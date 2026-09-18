import { spawn as nodeSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";

// A client for `codex app-server`: one JSON object per line on stdio, JSON-RPC shaped
// (id / method / params, result / error) without the "jsonrpc" field. Ported from the
// research workbench; the process is injected so tests drive it with scripted lines.

export type CodexErrorCode = "AGENT_UNAVAILABLE" | "AUTH_REQUIRED" | "TURN_RUNNING" | "TURN_FAILED" | "TURN_INTERRUPTED" | "TURN_TIMEOUT" | "APP_SERVER_EXITED" | "APP_SERVER_TIMEOUT" | "APP_SERVER_REQUEST_FAILED";

export class CodexError extends Error {
  constructor(public readonly code: CodexErrorCode, message: string) { super(message); this.name = "CodexError"; }
}

export interface CodexProcess {
  stdin: { writable: boolean; write: (chunk: string) => unknown; end: () => unknown };
  stdout: Readable;
  stderr: Readable | null;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}
export type Spawn = (command: string, args: readonly string[], options: { env: NodeJS.ProcessEnv }) => CodexProcess;

export interface DynamicTool { name: string; description: string; inputSchema: Record<string, unknown> }
export interface ToolCall { tool: string; arguments: unknown; callId: string }
export interface ToolReply { success: boolean; text: string; summary?: string }
export interface ToolProgress { tool: string; status: "running" | "done" | "failed"; summary?: string }
export interface TurnOptions {
  cwd: string;
  threadId?: string;
  prompt: string;
  dynamicTools: readonly DynamicTool[];
  onToolCall: (call: ToolCall) => Promise<ToolReply>;
  onStarted?: (turn: { threadId: string; turnId: string }) => void;
  onDelta?: (delta: string) => void;
  onTool?: (progress: ToolProgress) => void;
}
export interface TurnOutcome { threadId: string; turnId: string; text: string }
export type CodexAccount = { type: "chatgpt"; email?: string; planType?: string } | { type: "apiKey" } | { type: string };
export interface AccountInfo { account?: CodexAccount }

export interface CodexClientOptions {
  spawn?: Spawn;
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
  sleep?: (ms: number) => Promise<void>;
  /** stderr lines, declined approvals and other non-fatal facts; never silent, never a throw. */
  onDiagnostic?: (message: string) => void;
  turnTimeoutMs?: number;
  requestTimeoutMs?: number;
}

type Json = Record<string, unknown>;
interface Pending { resolve: (value: unknown) => void; reject: (error: Error) => void; timeout: ReturnType<typeof setTimeout> }
interface Binding {
  threadId: string;
  turnId?: string;
  closed: boolean;
  earlyEvents: Json[];
  onToolCall: (message: Json) => void;
  onNotification: (message: Json) => void;
  onExit: (error: Error) => void;
}

const CLIENT_INFO = { name: "quire", title: "Quire", version: "0.0.1" };
const DEFAULT_TURN_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const LOGIN_POLL_MS = 2_000;
const LOGIN_TIMEOUT_MS = 3 * 60_000;
const INSTALL_HINT = "Install Codex CLI (npm i -g @openai/codex) or set CODEX_PATH to the codex binary.";

function isObject(value: unknown): value is Json { return typeof value === "object" && value !== null && !Array.isArray(value); }
function str(value: unknown): string | undefined { return typeof value === "string" && value.length > 0 ? value : undefined; }

const defaultSpawn: Spawn = (command, args, options) => nodeSpawn(command, args, { env: options.env, stdio: ["pipe", "pipe", "pipe"] });

/** CODEX_PATH first, then the usual install locations, then PATH. Missing everywhere is an actionable error, not a later ENOENT. */
export function resolveCodexBinary(env: NodeJS.ProcessEnv, exists: (path: string) => boolean): string {
  const configured = str(env.CODEX_PATH);
  if (configured) {
    if (exists(configured)) return configured;
    throw new CodexError("AGENT_UNAVAILABLE", `CODEX_PATH points to ${configured}, which does not exist. ${INSTALL_HINT}`);
  }
  const fixed = ["/opt/homebrew/bin/codex", "/usr/local/bin/codex"].find((candidate) => exists(candidate));
  if (fixed) return fixed;
  const onPath = (env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, "codex")).find((candidate) => exists(candidate));
  if (onPath) return onPath;
  throw new CodexError("AGENT_UNAVAILABLE", `Codex CLI was not found. ${INSTALL_HINT}`);
}

export class CodexClient {
  private readonly spawn: Spawn;
  private readonly env: NodeJS.ProcessEnv;
  private readonly exists: (path: string) => boolean;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly diagnostic: (message: string) => void;
  private readonly turnTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private process: CodexProcess | undefined;
  private initialized = false;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private activeTurn: Binding | undefined;
  private cachedVersion: Promise<string> | undefined;

  constructor(options: CodexClientOptions = {}) {
    this.spawn = options.spawn ?? defaultSpawn;
    this.env = options.env ?? process.env;
    this.exists = options.exists ?? existsSync;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.diagnostic = options.onDiagnostic ?? (() => {});
    this.turnTimeoutMs = options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  get busy(): boolean { return this.activeTurn !== undefined; }

  /** The binary's path, or the AGENT_UNAVAILABLE error explaining what to install. */
  binary(): string { return resolveCodexBinary(this.env, this.exists); }

  private childEnv(): NodeJS.ProcessEnv {
    return { ...this.env, CODEX_HOME: str(this.env.CODEX_HOME) ?? join(str(this.env.HOME) ?? homedir(), ".codex"), NO_COLOR: "1" };
  }

  /** "codex-cli X.Y.Z" from `codex --version`, run once. */
  version(): Promise<string> {
    this.cachedVersion ??= new Promise<string>((resolve, reject) => {
      let binary: string;
      try { binary = this.binary(); } catch (error) { reject(error); return; }
      const child = this.spawn(binary, ["--version"], { env: this.childEnv() });
      let output = "";
      child.stdout.on("data", (chunk: Buffer | string) => { output += String(chunk); });
      child.on("error", (error) => reject(new CodexError("AGENT_UNAVAILABLE", `Could not run ${binary}: ${error.message}`)));
      child.on("exit", (code) => {
        const match = /codex(?:-cli)?\s+v?(\d+\.\d+\.\d+\S*)/i.exec(output);
        if (match?.[1]) resolve(match[1]);
        else reject(new CodexError("AGENT_UNAVAILABLE", `codex --version exited with ${code ?? "a signal"} and printed "${output.trim().slice(0, 120)}".`));
      });
    });
    this.cachedVersion.catch(() => { this.cachedVersion = undefined; });
    return this.cachedVersion;
  }

  start(): void {
    if (this.process) return;
    const child = this.spawn(this.binary(), ["app-server"], { env: this.childEnv() });
    this.process = child;
    createInterface({ input: child.stdout }).on("line", (line) => this.handleLine(line));
    child.stderr?.on("data", (chunk: Buffer | string) => this.diagnostic(String(chunk).trimEnd()));
    child.on("error", (error) => this.failAll(new CodexError("APP_SERVER_EXITED", `codex app-server could not run: ${error.message}`)));
    child.on("exit", (code, signal) => {
      if (this.process !== child) return;
      this.process = undefined;
      this.initialized = false;
      this.failAll(new CodexError("APP_SERVER_EXITED", `codex app-server exited (${code ?? signal ?? "unknown"}).`));
    });
  }

  private failAll(error: Error) {
    for (const pending of this.pending.values()) { clearTimeout(pending.timeout); pending.reject(error); }
    this.pending.clear();
    this.activeTurn?.onExit(error);
  }

  private write(message: Json) {
    if (!this.process?.stdin.writable) throw new CodexError("APP_SERVER_EXITED", "codex app-server is not running.");
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private request(method: string, params: Json = {}, timeoutMs = this.requestTimeoutMs): Promise<unknown> {
    this.start();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { this.pending.delete(id); reject(new CodexError("APP_SERVER_TIMEOUT", `codex app-server did not answer ${method} within ${Math.round(timeoutMs / 1000)}s.`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      try { this.write({ id, method, params }); } catch (error) { clearTimeout(timeout); this.pending.delete(id); reject(error as Error); }
    });
  }

  private handleLine(line: string) {
    let message: unknown;
    try { message = JSON.parse(line); } catch { this.diagnostic(`codex app-server sent a non-JSON line: ${line.slice(0, 200)}`); return; }
    if (!isObject(message)) return;
    if (typeof message.id === "number" && !("method" in message)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pending.delete(message.id);
      if (isObject(message.error)) pending.reject(new CodexError("APP_SERVER_REQUEST_FAILED", str(message.error.message) ?? "codex app-server rejected the request."));
      else pending.resolve(message.result);
      return;
    }
    const method = str(message.method);
    if (!method) return;
    if ("id" in message) this.handleServerRequest(method, message);
    else this.activeTurn?.onNotification(message);
  }

  private handleServerRequest(method: string, message: Json) {
    if (method === "item/tool/call") {
      if (this.activeTurn) this.activeTurn.onToolCall(message);
      else this.replyToTool(message, { success: false, text: "No turn is running; the tool call was ignored." });
      return;
    }
    if (method.includes("requestApproval")) { this.write({ id: message.id, result: { decision: "decline" } }); this.diagnostic(`declined ${method}`); return; }
    if (method.includes("requestUserInput")) { this.write({ id: message.id, result: { answers: {} } }); this.diagnostic(`declined ${method}`); return; }
    this.write({ id: message.id, error: { code: -32601, message: "Quire does not implement this request." } });
    this.diagnostic(`refused ${method}`);
  }

  private replyToTool(message: Json, reply: ToolReply) {
    try { this.write({ id: message.id, result: { contentItems: [{ type: "inputText", text: reply.text }], success: reply.success } }); }
    catch (error) { this.diagnostic(`tool reply after exit: ${(error as Error).message}`); }
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.request("initialize", { clientInfo: CLIENT_INFO, capabilities: { experimentalApi: true } });
    this.write({ method: "initialized", params: {} });
    this.initialized = true;
  }

  async account(): Promise<AccountInfo> {
    await this.initialize();
    const result = await this.request("account/read", { refreshToken: false }, 30_000);
    const account = isObject(result) && isObject(result.account) ? result.account : undefined;
    return account && typeof account.type === "string" ? { account: account as CodexAccount } : {};
  }

  /** Starts the browser login; the caller opens `authUrl`, then waits with `waitForAccount`. */
  async login(): Promise<{ authUrl: string }> {
    await this.initialize();
    const result = await this.request("account/login/start", { type: "chatgpt", useHostedLoginSuccessPage: true }, 30_000);
    const authUrl = isObject(result) ? str(result.authUrl) : undefined;
    if (!authUrl) throw new CodexError("AUTH_REQUIRED", "codex app-server did not return a login URL.");
    return { authUrl };
  }

  async waitForAccount(intervalMs = LOGIN_POLL_MS, timeoutMs = LOGIN_TIMEOUT_MS): Promise<AccountInfo> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const info = await this.account();
      if (info.account) return info;
      if (Date.now() >= deadline) throw new CodexError("AUTH_REQUIRED", "The sign-in did not complete within three minutes. Finish it in the browser and try again.");
      await this.sleep(intervalMs);
    }
  }

  private async threadFor(options: TurnOptions): Promise<string> {
    const common = { approvalPolicy: "never", approvalsReviewer: "user", cwd: options.cwd, sandboxPolicy: { type: "readOnly" }, dynamicTools: options.dynamicTools.map((tool) => ({ type: "function", ...tool })) };
    if (options.threadId) {
      try {
        const resumed = await this.request("thread/resume", { threadId: options.threadId, ...common });
        const id = isObject(resumed) && isObject(resumed.thread) ? str(resumed.thread.id) : undefined;
        if (id) return id;
      } catch (error) { this.diagnostic(`thread ${options.threadId} could not be resumed, starting a new one: ${(error as Error).message}`); }
    }
    const started = await this.request("thread/start", { ...common, serviceName: "quire" });
    const id = isObject(started) && isObject(started.thread) ? str(started.thread.id) : undefined;
    if (!id) throw new CodexError("TURN_FAILED", "codex app-server started a thread without an id.");
    return id;
  }

  /** One turn: prompt in, streamed deltas and tool calls, final text out. Rejects with a CodexError. */
  async runTurn(options: TurnOptions): Promise<TurnOutcome> {
    if (this.activeTurn) throw new CodexError("TURN_RUNNING", "The agent is still answering; wait for it or interrupt it.");
    const { account } = await this.account();
    if (!account) throw new CodexError("AUTH_REQUIRED", "Sign in to ChatGPT to use the agent.");
    const threadId = await this.threadFor(options);
    if (this.activeTurn) throw new CodexError("TURN_RUNNING", "The agent is still answering; wait for it or interrupt it.");
    return new Promise<TurnOutcome>((resolve, reject) => {
      let finalText = "";
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const binding: Binding = { threadId, closed: false, earlyEvents: [], onToolCall: () => {}, onNotification: () => {}, onExit: () => {} };
      const cleanup = () => {
        binding.closed = true;
        if (timeout) clearTimeout(timeout);
        if (this.activeTurn === binding) this.activeTurn = undefined;
        for (const message of binding.earlyEvents.splice(0)) if (message.method === "item/tool/call") this.replyToTool(message, { success: false, text: "The turn ended before the tool ran." });
      };
      const fail = (error: Error) => { if (binding.closed) return; cleanup(); reject(error); };
      binding.onExit = fail;
      binding.onToolCall = (message) => {
        const params = isObject(message.params) ? message.params : {};
        const turnId = str(params.turnId);
        if (binding.closed || params.threadId !== threadId || !turnId) { this.replyToTool(message, { success: false, text: "The tool call does not belong to the running turn." }); return; }
        // The server may call a tool before turn/start is acknowledged: keep the message, judge it once the turn id is known.
        if (!binding.turnId) { binding.earlyEvents.push(message); return; }
        if (turnId !== binding.turnId) { this.replyToTool(message, { success: false, text: "The tool call belongs to another turn." }); return; }
        const call: ToolCall = { tool: str(params.tool) ?? "", arguments: params.arguments, callId: str(params.callId) ?? "" };
        options.onTool?.({ tool: call.tool, status: "running" });
        options.onToolCall(call).then(
          (reply) => { this.replyToTool(message, reply); options.onTool?.({ tool: call.tool, status: reply.success ? "done" : "failed", ...(reply.summary ? { summary: reply.summary } : {}) }); },
          (error: unknown) => { const text = error instanceof Error ? error.message : String(error); this.replyToTool(message, { success: false, text }); options.onTool?.({ tool: call.tool, status: "failed", summary: text }); },
        );
      };
      binding.onNotification = (message) => {
        const params = isObject(message.params) ? message.params : {};
        if (binding.closed || params.threadId !== threadId) return;
        const method = message.method;
        if (method !== "item/agentMessage/delta" && method !== "item/completed" && method !== "turn/completed") return;
        const turn = isObject(params.turn) ? params.turn : undefined;
        const turnId = method === "turn/completed" ? str(turn?.id) : str(params.turnId);
        if (!turnId) return;
        if (!binding.turnId) { binding.earlyEvents.push(message); return; }
        if (turnId !== binding.turnId) return;
        if (method === "item/agentMessage/delta" && typeof params.delta === "string") options.onDelta?.(params.delta);
        if (method === "item/completed" && isObject(params.item) && params.item.type === "agentMessage" && typeof params.item.text === "string") finalText = params.item.text;
        if (method === "turn/completed" && turn) this.finishTurn(binding, turn, finalText, cleanup, resolve, reject);
      };
      this.activeTurn = binding;
      this.request("turn/start", { threadId, cwd: options.cwd, approvalPolicy: "never", approvalsReviewer: "user", sandboxPolicy: { type: "readOnly" }, input: [{ type: "text", text: options.prompt }] })
        .then((result) => {
          if (binding.closed) return;
          const turnId = isObject(result) && isObject(result.turn) ? str(result.turn.id) : undefined;
          if (!turnId) throw new CodexError("TURN_FAILED", "codex app-server started a turn without an id.");
          binding.turnId = turnId;
          options.onStarted?.({ threadId, turnId });
          timeout = setTimeout(() => {
            this.request("turn/interrupt", { threadId, turnId }, 10_000).catch((error: Error) => this.diagnostic(`interrupt after timeout failed: ${error.message}`));
            fail(new CodexError("TURN_TIMEOUT", `The agent did not finish within ${Math.round(this.turnTimeoutMs / 60_000)} minutes and was stopped.`));
          }, this.turnTimeoutMs);
          for (const message of binding.earlyEvents.splice(0)) { if (message.method === "item/tool/call") binding.onToolCall(message); else binding.onNotification(message); }
        })
        .catch(fail);
    });
  }

  private finishTurn(binding: Binding, turn: Json, finalText: string, cleanup: () => void, resolve: (outcome: TurnOutcome) => void, reject: (error: Error) => void) {
    cleanup();
    const status = str(turn.status);
    if (status === "completed") { resolve({ threadId: binding.threadId, turnId: binding.turnId ?? "", text: finalText || "The agent completed without a text response." }); return; }
    if (status === "interrupted") { reject(new CodexError("TURN_INTERRUPTED", "The agent was interrupted.")); return; }
    const detail = isObject(turn.error) ? str(turn.error.message) : undefined;
    reject(new CodexError("TURN_FAILED", detail ?? `The agent's turn ended with status ${status ?? "unknown"}.`));
  }

  /** Asks the server to stop the running turn; the turn then settles as TURN_INTERRUPTED. */
  async interrupt(): Promise<void> {
    const turn = this.activeTurn;
    if (!turn?.turnId) return;
    await this.request("turn/interrupt", { threadId: turn.threadId, turnId: turn.turnId }, 10_000);
  }

  stop(): void {
    const child = this.process;
    if (!child) return;
    this.process = undefined;
    this.initialized = false;
    this.failAll(new CodexError("APP_SERVER_EXITED", "codex app-server was stopped."));
    child.stdin.end();
    child.kill();
  }
}
