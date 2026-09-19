// One turn on one Codex thread. The binding routes the server's notifications and tool calls for
// its thread to the caller's callbacks, keeps what arrives before turn/start is acknowledged, times
// the turn out, and settles the runTurn promise. The client keeps one binding per running thread,
// so turns on different threads run side by side while a thread never runs two at once.

export type CodexErrorCode = "AGENT_UNAVAILABLE" | "AUTH_REQUIRED" | "TURN_RUNNING" | "TURN_FAILED" | "TURN_INTERRUPTED" | "TURN_TIMEOUT" | "APP_SERVER_EXITED" | "APP_SERVER_TIMEOUT" | "APP_SERVER_REQUEST_FAILED";

export class CodexError extends Error {
  constructor(public readonly code: CodexErrorCode, message: string) { super(message); this.name = "CodexError"; }
}

export interface DynamicTool { name: string; description: string; inputSchema: Record<string, unknown> }
export interface ToolCall { tool: string; arguments: unknown; callId: string }
export interface ToolReply { success: boolean; text: string; summary?: string }
export interface ToolProgress { tool: string; status: "running" | "done" | "failed"; summary?: string }
export type ReasoningEffort = "low" | "medium" | "high";
export interface TurnOptions {
  cwd: string;
  threadId?: string;
  prompt: string;
  /** Codex's `model` (thread/start, thread/resume, turn/start) and `effort` (turn/start); absent means Codex's own default. */
  model?: string;
  effort?: ReasoningEffort;
  dynamicTools: readonly DynamicTool[];
  onToolCall: (call: ToolCall) => Promise<ToolReply>;
  /** Fires once turn/start is acknowledged, before any delta or tool event. */
  onStarted?: (turn: { threadId: string; turnId: string }) => void;
  onDelta?: (delta: string) => void;
  onTool?: (progress: ToolProgress) => void;
}
export interface TurnOutcome { threadId: string; turnId: string; text: string }

export type Json = Record<string, unknown>;
export function isObject(value: unknown): value is Json { return typeof value === "object" && value !== null && !Array.isArray(value); }
export function str(value: unknown): string | undefined { return typeof value === "string" && value.length > 0 ? value : undefined; }

/** What a binding needs from the client: the wire, the diagnostics channel, the clock, and a way to be forgotten. */
export interface TurnHost {
  request: (method: string, params: Json, timeoutMs?: number) => Promise<unknown>;
  replyToTool: (message: Json, reply: ToolReply) => void;
  diagnostic: (message: string) => void;
  turnTimeoutMs: number;
  /** The binding settled (completed, failed, interrupted, timed out or lost its server): drop it. */
  release: (binding: TurnBinding) => void;
}

const INTERRUPT_TIMEOUT_MS = 10_000;

export class TurnBinding {
  turnId: string | undefined;
  private closed = false;
  /** Stop was pressed before turn/start answered; sent as soon as the id is known. */
  private interruptRequested = false;
  private finalText = "";
  private readonly earlyEvents: Json[] = [];
  private timeout: ReturnType<typeof setTimeout> | undefined;

  constructor(
    readonly threadId: string,
    private readonly options: TurnOptions,
    private readonly host: TurnHost,
    private readonly resolve: (outcome: TurnOutcome) => void,
    private readonly reject: (error: Error) => void,
  ) {}

  /** Sends turn/start; its answer carries the turn id that unlocks the buffered events and starts the clock. */
  start(): void {
    const { options, threadId } = this;
    this.host.request("turn/start", {
      threadId, cwd: options.cwd, approvalPolicy: "never", approvalsReviewer: "user", sandboxPolicy: { type: "readOnly" }, input: [{ type: "text", text: options.prompt }],
      ...(options.model ? { model: options.model } : {}), ...(options.effort ? { effort: options.effort } : {}),
    })
      .then((result) => this.started(result))
      .catch((error: Error) => this.fail(error));
  }

  private started(result: unknown): void {
    if (this.closed) return;
    const turnId = isObject(result) && isObject(result.turn) ? str(result.turn.id) : undefined;
    if (!turnId) throw new CodexError("TURN_FAILED", "codex app-server started a turn without an id.");
    this.turnId = turnId;
    this.options.onStarted?.({ threadId: this.threadId, turnId });
    if (this.interruptRequested) this.sendInterrupt("deferred interrupt");
    this.timeout = setTimeout(() => {
      this.sendInterrupt("interrupt after timeout");
      this.fail(new CodexError("TURN_TIMEOUT", `The agent did not finish within ${Math.round(this.host.turnTimeoutMs / 60_000)} minutes and was stopped.`));
    }, this.host.turnTimeoutMs);
    for (const message of this.earlyEvents.splice(0)) { if (message.method === "item/tool/call") this.onToolCall(message); else this.onNotification(message); }
  }

  private sendInterrupt(what: string): void {
    this.host.request("turn/interrupt", { threadId: this.threadId, turnId: this.turnId }, INTERRUPT_TIMEOUT_MS)
      .catch((error: Error) => this.host.diagnostic(`${what} failed: ${error.message}`));
  }

  /** Asks the server to stop this turn; it then settles as TURN_INTERRUPTED. Before the id is known, the request waits for it. */
  async interrupt(): Promise<void> {
    if (this.closed) return;
    if (!this.turnId) { this.interruptRequested = true; return; }
    await this.host.request("turn/interrupt", { threadId: this.threadId, turnId: this.turnId }, INTERRUPT_TIMEOUT_MS);
  }

  /** Settles the turn with an error (server exit, timeout, a refused turn/start); a second call is a no-op. */
  fail(error: Error): void {
    if (this.closed) return;
    this.close();
    this.reject(error);
  }

  private close(): void {
    this.closed = true;
    if (this.timeout) clearTimeout(this.timeout);
    this.host.release(this);
    for (const message of this.earlyEvents.splice(0)) if (message.method === "item/tool/call") this.host.replyToTool(message, { success: false, text: "The turn ended before the tool ran." });
  }

  onToolCall(message: Json): void {
    const params = isObject(message.params) ? message.params : {};
    const turnId = str(params.turnId);
    if (this.closed || params.threadId !== this.threadId || !turnId) { this.host.replyToTool(message, { success: false, text: "The tool call does not belong to the running turn." }); return; }
    // The server may call a tool before turn/start is acknowledged: keep the message, judge it once the turn id is known.
    if (!this.turnId) { this.earlyEvents.push(message); return; }
    if (turnId !== this.turnId) { this.host.replyToTool(message, { success: false, text: "The tool call belongs to another turn." }); return; }
    const call: ToolCall = { tool: str(params.tool) ?? "", arguments: params.arguments, callId: str(params.callId) ?? "" };
    this.options.onTool?.({ tool: call.tool, status: "running" });
    this.options.onToolCall(call).then(
      (reply) => { this.host.replyToTool(message, reply); this.options.onTool?.({ tool: call.tool, status: reply.success ? "done" : "failed", ...(reply.summary ? { summary: reply.summary } : {}) }); },
      (error: unknown) => { const text = error instanceof Error ? error.message : String(error); this.host.replyToTool(message, { success: false, text }); this.options.onTool?.({ tool: call.tool, status: "failed", summary: text }); },
    );
  }

  onNotification(message: Json): void {
    const params = isObject(message.params) ? message.params : {};
    if (this.closed || params.threadId !== this.threadId) return;
    const method = message.method;
    if (method !== "item/agentMessage/delta" && method !== "item/completed" && method !== "turn/completed") return;
    const turn = isObject(params.turn) ? params.turn : undefined;
    const turnId = method === "turn/completed" ? str(turn?.id) : str(params.turnId);
    if (!turnId) return;
    if (!this.turnId) { this.earlyEvents.push(message); return; }
    if (turnId !== this.turnId) return;
    if (method === "item/agentMessage/delta" && typeof params.delta === "string") this.options.onDelta?.(params.delta);
    if (method === "item/completed" && isObject(params.item) && params.item.type === "agentMessage" && typeof params.item.text === "string") this.finalText = params.item.text;
    if (method === "turn/completed" && turn) this.finish(turn);
  }

  private finish(turn: Json): void {
    this.close();
    const status = str(turn.status);
    if (status === "completed") { this.resolve({ threadId: this.threadId, turnId: this.turnId ?? "", text: this.finalText || "The agent completed without a text response." }); return; }
    if (status === "interrupted") { this.reject(new CodexError("TURN_INTERRUPTED", "The agent was interrupted.")); return; }
    const detail = isObject(turn.error) ? str(turn.error.message) : undefined;
    this.reject(new CodexError("TURN_FAILED", detail ?? `The agent's turn ended with status ${status ?? "unknown"}.`));
  }
}
