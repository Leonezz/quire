import { spawn as nodeSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { codexBinaryAt, expandCodexPath } from "./codex-path";
import { CodexError, TurnBinding, isObject, str, type Json, type ToolReply, type TurnHost, type TurnOptions, type TurnOutcome } from "./codex-turns";

// A client for `codex app-server`: one JSON object per line on stdio, JSON-RPC shaped
// (id / method / params, result / error) without the "jsonrpc" field. Ported from the
// research workbench; the process is injected so tests drive it with scripted lines.
// Turns live in codex-turns.ts: one binding per running thread, routed by threadId.

export { CodexError } from "./codex-turns";
export type { CodexErrorCode, DynamicTool, ReasoningEffort, ToolCall, ToolProgress, ToolReply, TurnOptions, TurnOutcome } from "./codex-turns";

export interface CodexProcess {
  stdin: { writable: boolean; write: (chunk: string) => unknown; end: () => unknown };
  stdout: Readable;
  stderr: Readable | null;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}
export type Spawn = (command: string, args: readonly string[], options: { env: NodeJS.ProcessEnv }) => CodexProcess;

export type CodexAccount = { type: "chatgpt"; email?: string; planType?: string } | { type: "apiKey" } | { type: string };
export interface AccountInfo { account?: CodexAccount }

export interface CodexClientOptions {
  spawn?: Spawn;
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
  /** The binary the settings name; read at every resolution, empty means auto-detect. */
  configuredPath?: () => string;
  sleep?: (ms: number) => Promise<void>;
  /** stderr lines, declined approvals and other non-fatal facts; never silent, never a throw. */
  onDiagnostic?: (message: string) => void;
  turnTimeoutMs?: number;
  requestTimeoutMs?: number;
}

interface Pending { resolve: (value: unknown) => void; reject: (error: Error) => void; timeout: ReturnType<typeof setTimeout> }

const CLIENT_INFO = { name: "quire", title: "Quire", version: "0.0.1" };
const DEFAULT_TURN_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const LOGIN_POLL_MS = 2_000;
const LOGIN_TIMEOUT_MS = 3 * 60_000;
const INSTALL_HINT = "Install Codex CLI (npm i -g @openai/codex) or set CODEX_PATH to the codex binary.";
const THREAD_BUSY = "The agent is still answering in this conversation; wait for it or interrupt it.";

const defaultSpawn: Spawn = (command, args, options) => nodeSpawn(command, args, { env: options.env, stdio: ["pipe", "pipe", "pipe"] });

/**
 * The settings' path first, then CODEX_PATH, then the usual install locations, then PATH. Missing everywhere is an
 * actionable error, not a later ENOENT. A configured path is trimmed, "~" is expanded, and a directory holding a
 * codex binary (or the npm shim) stands for that binary (codex-path.ts).
 */
export function resolveCodexBinary(env: NodeJS.ProcessEnv, exists: (path: string) => boolean, configuredPath?: string): string {
  const home = str(env.HOME) ?? homedir();
  const fromSettings = expandCodexPath(configuredPath ?? "", home);
  if (fromSettings) {
    const binary = codexBinaryAt(fromSettings, exists);
    if (binary) return binary;
    throw new CodexError("AGENT_UNAVAILABLE", `The Codex path in Settings (${fromSettings}) does not exist. Fix it or clear it to auto-detect.`);
  }
  const configured = expandCodexPath(env.CODEX_PATH ?? "", home);
  if (configured) {
    const binary = codexBinaryAt(configured, exists);
    if (binary) return binary;
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
  private readonly configuredPath: () => string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly diagnostic: (message: string) => void;
  private readonly turnTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private process: CodexProcess | undefined;
  private initialized = false;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  /** The running turns, one per thread. */
  private readonly turns = new Map<string, TurnBinding>();
  private cachedVersion: Promise<string> | undefined;
  private readonly host: TurnHost;

  constructor(options: CodexClientOptions = {}) {
    this.spawn = options.spawn ?? defaultSpawn;
    this.env = options.env ?? process.env;
    this.exists = options.exists ?? existsSync;
    this.configuredPath = options.configuredPath ?? (() => "");
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.diagnostic = options.onDiagnostic ?? (() => {});
    this.turnTimeoutMs = options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.host = {
      request: (method, params, timeoutMs) => this.request(method, params, timeoutMs),
      replyToTool: (message, reply) => this.replyToTool(message, reply),
      diagnostic: (message) => this.diagnostic(message),
      turnTimeoutMs: this.turnTimeoutMs,
      release: (binding) => { if (this.turns.get(binding.threadId) === binding) this.turns.delete(binding.threadId); },
    };
  }

  /** How many turns are running right now, across threads. */
  get running(): number { return this.turns.size; }

  /** The binary's path, or the AGENT_UNAVAILABLE error explaining what to install. */
  binary(): string { return resolveCodexBinary(this.env, this.exists, this.configuredPath()); }

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

  /** Every pending request and every running turn ends with `error`; the server is gone. */
  private failAll(error: Error) {
    for (const pending of this.pending.values()) { clearTimeout(pending.timeout); pending.reject(error); }
    this.pending.clear();
    for (const binding of [...this.turns.values()]) binding.fail(error);
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
    else this.bindingFor(message)?.onNotification(message);
  }

  /** The turn a notification or tool call belongs to, by the threadId in its params. */
  private bindingFor(message: Json): TurnBinding | undefined {
    const params = isObject(message.params) ? message.params : {};
    const threadId = str(params.threadId);
    return threadId ? this.turns.get(threadId) : undefined;
  }

  private handleServerRequest(method: string, message: Json) {
    if (method === "item/tool/call") {
      const binding = this.bindingFor(message);
      if (binding) binding.onToolCall(message);
      else this.replyToTool(message, { success: false, text: "No turn is running on that thread; the tool call was ignored." });
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
    const common = { approvalPolicy: "never", approvalsReviewer: "user", cwd: options.cwd, sandboxPolicy: { type: "readOnly" }, dynamicTools: options.dynamicTools.map((tool) => ({ type: "function", ...tool })), ...(options.model ? { model: options.model } : {}) };
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

  /**
   * One turn: prompt in, streamed deltas and tool calls, final text out. Rejects with a CodexError.
   * Threads run side by side; a thread that already has a turn refuses a second one with TURN_RUNNING.
   */
  async runTurn(options: TurnOptions): Promise<TurnOutcome> {
    if (options.threadId && this.turns.has(options.threadId)) throw new CodexError("TURN_RUNNING", THREAD_BUSY);
    const { account } = await this.account();
    if (!account) throw new CodexError("AUTH_REQUIRED", "Sign in to ChatGPT to use the agent.");
    const threadId = await this.threadFor(options);
    if (this.turns.has(threadId)) throw new CodexError("TURN_RUNNING", THREAD_BUSY);
    return new Promise<TurnOutcome>((resolve, reject) => {
      const binding = new TurnBinding(threadId, options, this.host, resolve, reject);
      this.turns.set(threadId, binding);
      binding.start();
    });
  }

  /** Asks the server to stop the turn on that thread; it then settles as TURN_INTERRUPTED. A no-op when none runs there. */
  async interrupt(threadId: string): Promise<void> {
    await this.turns.get(threadId)?.interrupt();
  }

  /** Stops the server (a changed binary path takes effect at the next request); the version is read again too. Every running turn fails. */
  stop(): void {
    this.cachedVersion = undefined;
    const child = this.process;
    if (!child) return;
    this.process = undefined;
    this.initialized = false;
    this.failAll(new CodexError("APP_SERVER_EXITED", "codex app-server was stopped."));
    child.stdin.end();
    child.kill();
  }
}
