import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { AgentEvent, AgentRequest, AgentResult, AgentRun, AgentSession, AgentStatus, AgentTurnRecord, MaterialRecord, MaterialSummary, Settings } from "../../shared/contracts";
import { buildPrompt } from "./agent-prompt";
import { createTurnScope, type ToolHandlerFactory, type TurnScope } from "./agent-tools";
import { titleFor, type SessionStore } from "./agent-sessions";
import { CodexError, type CodexAccount, type CodexClient, type DynamicTool, type ToolProgress, type TurnOptions, type TurnOutcome } from "./codex-client";

// The agent runtime, independent of any view. `ask` starts a turn and returns as soon as it runs;
// the run then lives in `runs` (one per session, sessions in parallel), accumulates what streams,
// and ends as a stored turn of its session. Every event names its session so the renderer's store
// routes it whether or not a panel is watching. Codex runs in <userData>/agent, an empty
// read-only directory; the library is reached only through the tools.

export type AgentClient = Pick<CodexClient, "version" | "initialize" | "account" | "login" | "waitForAccount" | "runTurn" | "interrupt" | "running" | "stop">;

export type AgentSettings = Pick<Settings, "agentModel" | "agentReasoningEffort">;
type ToolRecord = NonNullable<AgentTurnRecord["tools"]>[number];
type RunTool = AgentRun["tools"][number];

export interface AgentServiceDeps {
  client: AgentClient;
  tools: readonly DynamicTool[];
  /** Every turn gets its own handler, closed over that turn's scope. */
  toolHandler: ToolHandlerFactory;
  store: { list: () => Promise<MaterialSummary[]>; get: (id: string) => Promise<MaterialRecord | undefined>; setRebuiltAs: (id: string, artifactId: string) => Promise<MaterialRecord> };
  sessions: Pick<SessionStore, "create" | "get" | "appendTurn" | "setThread">;
  userData: string;
  onEvent: (event: AgentEvent) => void;
  /** A session was created or a turn appended; index.ts broadcasts agent:sessions:changed. */
  onSessionsChanged?: () => void;
  /** A rebuild marked a material; index.ts broadcasts library:changed. */
  onLibraryChanged?: () => void;
  /** A run could not be recorded after it ended (its session was deleted meanwhile, the store failed); never swallowed. */
  onError: (context: string, error: unknown) => void;
  /** Model and effort for Codex, read at every turn; empty strings mean Codex's defaults. */
  settings?: () => AgentSettings;
  /** Opens the sign-in page; index.ts passes shell.openExternal. */
  openExternal: (url: string) => Promise<void>;
  now?: () => Date;
}

/** A turn in flight. `turnId` and `threadId` arrive with onStarted; `key` tells this run from a later one in the same session. */
interface Run {
  key: number;
  sessionId: string;
  turnId?: string;
  threadId?: string;
  task: AgentRun["task"];
  prompt: string;
  answer: string;
  tools: readonly RunTool[];
  startedAt: string;
  /** Stop was pressed before the thread was known; sent as soon as it is. */
  interruptRequested?: boolean;
}

type Failure = Extract<AgentResult, { ok: false }>;
const SIGN_IN = "Sign in to ChatGPT to use the agent.";
const SESSION_BUSY = "The agent is still answering in this conversation; wait for it or stop it.";
export const QUIT_MESSAGE = "Stopped: Quire quit while the agent was answering.";
const HEX_ID = /\b[a-f0-9]{16}\b/g;
const ARTIFACT_SUMMARY = /^artifact_write .* → ([a-f0-9]{16})$/;

function modelOptions(settings: AgentSettings | undefined): Pick<TurnOptions, "model" | "effort"> {
  const model = settings?.agentModel.trim();
  const effort = settings?.agentReasoningEffort;
  return { ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
}

/** The artifact a rebuild produced: named in the reply or by artifact_write, an agent material whose lineage holds the original. */
function rebuiltArtifactIds(text: string, tools: readonly ToolRecord[]): string[] {
  const fromTools = tools.flatMap((tool) => { const match = tool.name === "artifact_write" && tool.status === "done" && tool.summary ? ARTIFACT_SUMMARY.exec(tool.summary) : null; return match?.[1] ? [match[1]] : []; });
  return [...new Set([...fromTools, ...(text.match(HEX_ID) ?? [])])];
}

function accountLabel(account: CodexAccount): string {
  if (account.type === "chatgpt") { const { email, planType } = account as { email?: string | null; planType?: string }; return email ?? (planType ? `ChatGPT ${planType}` : "ChatGPT"); }
  if (account.type === "apiKey") return "API key";
  return account.type;
}

function failureOf(error: unknown): Failure {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof CodexError) {
    if (error.code === "AGENT_UNAVAILABLE" || error.code === "AUTH_REQUIRED" || error.code === "TURN_RUNNING" || error.code === "TURN_INTERRUPTED" || error.code === "TURN_TIMEOUT") return { ok: false, code: error.code, message };
  }
  return { ok: false, code: "TURN_FAILED", message };
}

/** The tool rows with `progress` applied: a running row is appended, its outcome replaces the last running row of that tool. */
function withProgress(tools: readonly RunTool[], progress: ToolProgress): RunTool[] {
  if (progress.status === "running") return [...tools, { name: progress.tool, status: "running" }];
  const entry: RunTool = { name: progress.tool, status: progress.status, ...(progress.summary ? { summary: progress.summary } : {}) };
  const index = tools.findLastIndex((tool) => tool.name === progress.tool && tool.status === "running");
  return index < 0 ? [...tools, entry] : tools.map((tool, i) => (i === index ? entry : tool));
}

function isSettled(tool: RunTool): tool is ToolRecord { return tool.status !== "running"; }
/** What a stored turn keeps: the tools that finished. */
function storedTools(tools: readonly RunTool[]): ToolRecord[] { return tools.filter(isSettled); }

export class AgentService {
  private readonly runs = new Map<string, Run>();
  private nextKey = 1;

  constructor(private readonly deps: AgentServiceDeps) {}

  private get cwd() { return join(this.deps.userData, "agent"); }

  /** Never throws: whatever stops the agent is written into `reason`. */
  async status(): Promise<AgentStatus> {
    const { client } = this.deps;
    const running = this.runs.size;
    let version: string;
    try { version = await client.version(); }
    catch (error) { return { available: false, running, reason: error instanceof Error ? error.message : String(error) }; }
    try { await client.initialize(); }
    catch (error) { return { available: false, version, running, reason: `codex app-server did not start: ${error instanceof Error ? error.message : String(error)}` }; }
    try {
      const { account } = await client.account();
      return account ? { available: true, version, account: accountLabel(account), running } : { available: true, version, running, reason: SIGN_IN };
    } catch (error) { return { available: true, version, running, reason: `Could not read the account: ${error instanceof Error ? error.message : String(error)}` }; }
  }

  /** Browser sign-in; resolves with the status once the account is there, or with the reason it is not. */
  async login(): Promise<AgentStatus> {
    try {
      const { authUrl } = await this.deps.client.login();
      if (!authUrl.startsWith("https://")) throw new CodexError("AUTH_REQUIRED", `Refusing to open a non-https login URL (${authUrl.slice(0, 40)}).`);
      await this.deps.openExternal(authUrl);
      await this.deps.client.waitForAccount();
      return this.status();
    } catch (error) {
      const base = await this.status();
      return { ...base, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  /** The session the request continues, or a new one titled from it. Undefined when the request names a session that is gone. */
  private sessionFor(request: AgentRequest, material: MaterialRecord | undefined): AgentSession | undefined {
    if (request.sessionId) return this.deps.sessions.get(request.sessionId);
    return this.deps.sessions.create(request.context, titleFor(request, material?.title));
  }

  /** Validates, stores the user's turn, starts the turn and returns once it runs. The answer arrives as events and a stored turn. */
  async ask(request: AgentRequest): Promise<AgentResult> {
    const { store, sessions } = this.deps;
    let material: MaterialRecord | undefined;
    if (request.context.kind !== "library") {
      material = await store.get(request.context.materialId);
      if (!material) return { ok: false, code: "TURN_FAILED", message: `Material ${request.context.materialId} is not in the library.` };
    }
    if (request.sessionId && this.runs.has(request.sessionId)) return { ok: false, code: "TURN_RUNNING", message: SESSION_BUSY };
    const session = this.sessionFor(request, material);
    if (!session) return { ok: false, code: "TURN_FAILED", message: `Session ${request.sessionId} no longer exists; start a new one.` };
    const prompt = buildPrompt(request, { library: await store.list(), ...(material ? { material } : {}) });
    await mkdir(this.cwd, { recursive: true });
    // Nothing awaits between this check and the registration, so two asks for one session cannot both pass.
    if (this.runs.has(session.id)) return { ok: false, code: "TURN_RUNNING", message: SESSION_BUSY };
    sessions.appendTurn(session.id, { role: "user", text: request.text, task: request.task });
    this.deps.onSessionsChanged?.();
    const run: Run = { key: this.nextKey++, sessionId: session.id, task: request.task, prompt, answer: "", tools: [], startedAt: (this.deps.now?.() ?? new Date()).toISOString() };
    this.runs.set(session.id, run);
    return this.startTurn(run, request, session, material);
  }

  /** Resolves once the turn runs (or could not start); the turn's end is recorded by complete / fail, not awaited here. */
  private startTurn(run: Run, request: AgentRequest, session: AgentSession, material: MaterialRecord | undefined): Promise<AgentResult> {
    const { client, tools, toolHandler, onEvent } = this.deps;
    const { key, sessionId } = run;
    // The material the conversation is about is citable without a tool call; everything else must be retrieved.
    const scope = createTurnScope(material ? [material.id] : []);
    const threadId = request.threadId ?? session.threadId;
    return new Promise<AgentResult>((settle) => {
      const outcome = Promise.resolve().then(() => client.runTurn({
        cwd: this.cwd, prompt: run.prompt, dynamicTools: tools, onToolCall: toolHandler.forTurn(scope), ...modelOptions(this.deps.settings?.()),
        ...(threadId ? { threadId } : {}),
        onStarted: (turn) => {
          const started = this.patch(key, sessionId, (current) => ({ ...current, threadId: turn.threadId, turnId: turn.turnId }));
          onEvent({ type: "started", sessionId, threadId: turn.threadId, turnId: turn.turnId });
          if (started?.interruptRequested) client.interrupt(turn.threadId).catch((error: unknown) => this.deps.onError(`interrupting session ${sessionId}`, error));
          settle({ ok: true, sessionId, turnId: turn.turnId });
        },
        onDelta: (delta) => {
          const current = this.patch(key, sessionId, (running) => ({ ...running, answer: running.answer + delta }));
          if (current?.turnId) onEvent({ type: "delta", sessionId, turnId: current.turnId, delta });
        },
        onTool: (progress) => {
          const current = this.patch(key, sessionId, (running) => ({ ...running, tools: withProgress(running.tools, progress) }));
          if (current?.turnId) onEvent({ type: "tool", sessionId, turnId: current.turnId, name: progress.tool, status: progress.status, ...(progress.summary ? { summary: progress.summary } : {}) });
        },
      }));
      outcome
        .then(
          (result) => this.complete(key, sessionId, request, material, result, scope),
          (error: unknown) => { const failure = failureOf(error); this.fail(key, sessionId, request, failure); settle(failure); },
        )
        .catch((error: unknown) => this.deps.onError(`recording the turn of session ${sessionId}`, error));
    });
  }

  /** The run `key` names if it is still the session's current one. */
  private current(key: number, sessionId: string): Run | undefined {
    const run = this.runs.get(sessionId);
    return run?.key === key ? run : undefined;
  }

  private patch(key: number, sessionId: string, change: (run: Run) => Run): Run | undefined {
    const run = this.current(key, sessionId);
    if (!run) return undefined;
    const next = change(run);
    this.runs.set(sessionId, next);
    return next;
  }

  /** Removes the run so its outcome is recorded once, even if the client settles after shutdown took it. */
  private take(key: number, sessionId: string): Run | undefined {
    const run = this.current(key, sessionId);
    if (run) this.runs.delete(sessionId);
    return run;
  }

  private async complete(key: number, sessionId: string, request: AgentRequest, material: MaterialRecord | undefined, outcome: TurnOutcome, scope: TurnScope): Promise<void> {
    const { sessions, onEvent } = this.deps;
    const run = this.take(key, sessionId);
    if (!run) return;
    const sources = [...scope.seen];
    const tools = storedTools(run.tools);
    sessions.setThread(sessionId, outcome.threadId);
    sessions.appendTurn(sessionId, { role: "agent", text: outcome.text, task: request.task, status: "completed", tools, sources });
    onEvent({ type: "completed", sessionId, turnId: outcome.turnId, text: outcome.text, sources });
    this.deps.onSessionsChanged?.();
    if (request.task === "rebuild" && material) await this.markRebuilt(material, outcome.text, tools);
  }

  private fail(key: number, sessionId: string, request: AgentRequest, failure: Failure): void {
    const { sessions, onEvent } = this.deps;
    const run = this.take(key, sessionId);
    if (!run) return;
    sessions.appendTurn(sessionId, { role: "agent", text: failure.message, task: request.task, status: failure.code === "TURN_INTERRUPTED" ? "interrupted" : "failed", tools: storedTools(run.tools) });
    if (run.turnId) onEvent({ type: "failed", sessionId, turnId: run.turnId, code: failure.code, message: failure.message });
    this.deps.onSessionsChanged?.();
  }

  private async markRebuilt(material: MaterialRecord, text: string, tools: readonly ToolRecord[]): Promise<void> {
    for (const id of rebuiltArtifactIds(text, tools)) {
      const artifact = await this.deps.store.get(id);
      if (!artifact || artifact.origin !== "agent" || !artifact.lineage?.includes(material.id)) continue;
      await this.deps.store.setRebuiltAs(material.id, artifact.id);
      this.deps.onLibraryChanged?.();
      return;
    }
  }

  /** Every turn in flight that has started, with what streamed so far; copies, so the caller cannot reach the registry. */
  listRuns(): AgentRun[] {
    return [...this.runs.values()].flatMap(({ key: _key, interruptRequested: _requested, turnId, ...run }) =>
      turnId ? [{ ...run, turnId, tools: run.tools.map((tool) => ({ ...tool })) }] : []);
  }

  /** Stops the turn running in that session; a no-op when none is. Before the thread is known, the stop waits for it. */
  async interrupt(sessionId: string): Promise<void> {
    const run = this.runs.get(sessionId);
    if (!run) return;
    if (!run.threadId) { this.runs.set(sessionId, { ...run, interruptRequested: true }); return; }
    await this.deps.client.interrupt(run.threadId);
  }

  /** On quit: every run becomes an interrupted turn of its session, then the client stops. Nothing is left half-written. */
  shutdown(): void {
    const runs = [...this.runs.values()];
    this.runs.clear();
    for (const run of runs) {
      try { this.deps.sessions.appendTurn(run.sessionId, { role: "agent", text: QUIT_MESSAGE, task: run.task, status: "interrupted", tools: storedTools(run.tools) }); }
      catch (error) { this.deps.onError(`recording the interrupted turn of session ${run.sessionId} on quit`, error); }
    }
    this.deps.client.stop();
  }
}
