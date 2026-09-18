import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { AgentEvent, AgentRequest, AgentResult, AgentSession, AgentStatus, AgentTurnRecord, MaterialRecord, MaterialSummary, Settings } from "../../shared/contracts";
import { buildPrompt } from "./agent-prompt";
import type { TurnScope } from "./agent-tools";
import { titleFor, type SessionStore } from "./agent-sessions";
import { CodexError, type CodexAccount, type CodexClient, type DynamicTool, type ToolCall, type ToolReply, type TurnOptions } from "./codex-client";

// The agent as the renderer sees it: a status, one question at a time, events while it runs.
// Codex runs in <userData>/agent, an empty read-only directory; the library is reached only through the tools.

export type AgentClient = Pick<CodexClient, "version" | "initialize" | "account" | "login" | "waitForAccount" | "runTurn" | "interrupt" | "busy">;

export type AgentSettings = Pick<Settings, "agentModel" | "agentReasoningEffort">;
type ToolRecord = NonNullable<AgentTurnRecord["tools"]>[number];

export interface AgentServiceDeps {
  client: AgentClient;
  tools: readonly DynamicTool[];
  toolHandler: (call: ToolCall) => Promise<ToolReply>;
  /** Reset at every turn; afterwards holds the ids the model retrieved (the only ids it may cite). */
  scope?: TurnScope;
  store: { list: () => Promise<MaterialSummary[]>; get: (id: string) => Promise<MaterialRecord | undefined>; setRebuiltAs: (id: string, artifactId: string) => Promise<MaterialRecord> };
  sessions: Pick<SessionStore, "create" | "get" | "appendTurn" | "setThread">;
  userData: string;
  onEvent: (event: AgentEvent) => void;
  /** A session was created or a turn appended; index.ts broadcasts agent:sessions:changed. */
  onSessionsChanged?: () => void;
  /** A rebuild marked a material; index.ts broadcasts library:changed. */
  onLibraryChanged?: () => void;
  /** Model and effort for Codex, read at every turn; empty strings mean Codex's defaults. */
  settings?: () => AgentSettings;
  /** Opens the sign-in page; index.ts passes shell.openExternal. */
  openExternal: (url: string) => Promise<void>;
}

type FailureCode = Extract<AgentResult, { ok: false }>["code"];
const SIGN_IN = "Sign in to ChatGPT to use the agent.";
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

function failureOf(error: unknown): { code: FailureCode; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof CodexError) {
    if (error.code === "AGENT_UNAVAILABLE" || error.code === "AUTH_REQUIRED" || error.code === "TURN_RUNNING" || error.code === "TURN_INTERRUPTED" || error.code === "TURN_TIMEOUT") return { code: error.code, message };
  }
  return { code: "TURN_FAILED", message };
}

export class AgentService {
  constructor(private readonly deps: AgentServiceDeps) {}

  private get cwd() { return join(this.deps.userData, "agent"); }

  /** Never throws: whatever stops the agent is written into `reason`. */
  async status(): Promise<AgentStatus> {
    const { client } = this.deps;
    const busy = client.busy;
    let version: string;
    try { version = await client.version(); }
    catch (error) { return { available: false, busy, reason: error instanceof Error ? error.message : String(error) }; }
    try { await client.initialize(); }
    catch (error) { return { available: false, version, busy, reason: `codex app-server did not start: ${error instanceof Error ? error.message : String(error)}` }; }
    try {
      const { account } = await client.account();
      return account ? { available: true, version, account: accountLabel(account), busy } : { available: true, version, busy, reason: SIGN_IN };
    } catch (error) { return { available: true, version, busy, reason: `Could not read the account: ${error instanceof Error ? error.message : String(error)}` }; }
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

  async ask(request: AgentRequest): Promise<AgentResult> {
    const { client, store, sessions, onEvent } = this.deps;
    let material: MaterialRecord | undefined;
    if (request.context.kind !== "library") {
      material = await store.get(request.context.materialId);
      if (!material) return { ok: false, code: "TURN_FAILED", message: `Material ${request.context.materialId} is not in the library.` };
    }
    const session = this.sessionFor(request, material);
    if (!session) return { ok: false, code: "TURN_FAILED", message: `Session ${request.sessionId} no longer exists; start a new one.` };
    const prompt = buildPrompt(request, { library: await store.list(), ...(material ? { material } : {}) });
    await mkdir(this.cwd, { recursive: true });
    sessions.appendTurn(session.id, { role: "user", text: request.text, task: request.task });
    this.deps.onSessionsChanged?.();
    const threadId = request.threadId ?? session.threadId;
    const tools: ToolRecord[] = [];
    let turnId: string | undefined;
    // The material the conversation is about is citable without a tool call; everything else must be retrieved.
    this.deps.scope?.reset(material ? [material.id] : []);
    try {
      const outcome = await client.runTurn({
        cwd: this.cwd, prompt, dynamicTools: this.deps.tools, onToolCall: this.deps.toolHandler, ...modelOptions(this.deps.settings?.()),
        ...(threadId ? { threadId } : {}),
        onStarted: (turn) => { turnId = turn.turnId; onEvent({ type: "started", threadId: turn.threadId, turnId: turn.turnId }); },
        onDelta: (delta) => { if (turnId) onEvent({ type: "delta", turnId, delta }); },
        onTool: (progress) => {
          if (progress.status !== "running") tools.push({ name: progress.tool, status: progress.status, ...(progress.summary ? { summary: progress.summary } : {}) });
          if (turnId) onEvent({ type: "tool", turnId, name: progress.tool, status: progress.status, ...(progress.summary ? { summary: progress.summary } : {}) });
        },
      });
      const sources = [...(this.deps.scope?.seen ?? [])];
      onEvent({ type: "completed", turnId: outcome.turnId, sources });
      sessions.setThread(session.id, outcome.threadId);
      sessions.appendTurn(session.id, { role: "agent", text: outcome.text, task: request.task, status: "completed", tools, sources });
      this.deps.onSessionsChanged?.();
      if (request.task === "rebuild" && material) await this.markRebuilt(material, outcome.text, tools);
      return { ok: true, ...outcome, sessionId: session.id, sources };
    } catch (error) {
      const failure = failureOf(error);
      if (turnId) onEvent({ type: "failed", turnId, message: failure.message });
      sessions.appendTurn(session.id, { role: "agent", text: failure.message, task: request.task, status: failure.code === "TURN_INTERRUPTED" ? "interrupted" : "failed", tools });
      this.deps.onSessionsChanged?.();
      return { ok: false, ...failure };
    }
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

  async interrupt(): Promise<void> {
    await this.deps.client.interrupt();
  }
}
