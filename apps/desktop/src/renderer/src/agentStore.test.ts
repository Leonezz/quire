// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, AgentResult, AgentRun } from "../../shared/contracts";
import { FINISHED_TTL_MS, SWAP_GRACE_MS, createAgentStore, runningCount, type AgentStoreApi } from "./agentStore";

function harness(overrides: Partial<AgentStoreApi> = {}, runs: AgentRun[] = []) {
  const events = new Set<(event: AgentEvent) => void>();
  const sessionListeners = new Set<() => void>();
  const api: AgentStoreApi = {
    agentStatus: vi.fn(async () => ({ available: true, running: 0 })),
    agentAsk: vi.fn(async () => ({ ok: true as const, sessionId: "s1", turnId: "t1" })),
    agentInterrupt: vi.fn(async () => undefined),
    agentLogin: vi.fn(async () => ({ available: true, running: 0, account: "me" })),
    listAgentRuns: vi.fn(async () => runs),
    onAgentEvent: (listener) => { events.add(listener); return () => { events.delete(listener); }; },
    onAgentSessionsChanged: (listener) => { sessionListeners.add(listener); return () => { sessionListeners.delete(listener); }; },
    sessionSettled: vi.fn(async () => false),
    ...overrides,
  };
  const store = createAgentStore(api);
  const emit = (event: AgentEvent) => { for (const listener of events) listener(event); };
  const sessionsChanged = () => { for (const listener of sessionListeners) listener(); };
  return { store, api, emit, sessionsChanged };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("agentStore", () => {
  it("seeds from listAgentRuns and reads the status", async () => {
    const seeded: AgentRun = { sessionId: "s0", turnId: "t0", task: "explain", prompt: "", answer: "So far", tools: [{ name: "library_search", status: "done", summary: "2 hits" }], startedAt: "2026-09-19T10:00:00.000Z" };
    const { store, api } = harness({}, [seeded]);
    await store.start();
    await vi.advanceTimersByTimeAsync(0);
    const run = store.getState().runs.get("s0");
    expect(run).toEqual(expect.objectContaining({ task: "explain", answer: "So far", turnId: "t0" }));
    expect(run?.tools[0]).toEqual(expect.objectContaining({ name: "library_search", status: "done" }));
    expect(store.getState().status).toEqual({ available: true, running: 0 });
    expect(runningCount(store.getState().runs)).toBe(1);
    expect(api.listAgentRuns).toHaveBeenCalledTimes(1);
    // Starting twice subscribes once.
    await store.start();
    expect(api.listAgentRuns).toHaveBeenCalledTimes(1);
  });

  it("creates the run when ask returns and routes deltas, tools and completion by session", async () => {
    const { store, emit } = harness();
    await store.start();
    const result = await store.ask({ context: { kind: "library" }, task: "ask", text: "why?" });
    expect(result).toEqual({ ok: true, sessionId: "s1", turnId: "t1" });
    expect(store.getState().runs.get("s1")).toEqual(expect.objectContaining({ task: "ask", prompt: "why?", answer: "" }));
    expect(store.getState().runs.get("s1")?.outcome).toBeUndefined();
    emit({ type: "started", sessionId: "s1", threadId: "th1", turnId: "t1" });
    emit({ type: "delta", sessionId: "s1", turnId: "t1", delta: "Hel" });
    emit({ type: "delta", sessionId: "s2", turnId: "t2", delta: "NOPE" });
    emit({ type: "delta", sessionId: "s1", turnId: "t1", delta: "lo" });
    emit({ type: "tool", sessionId: "s1", turnId: "t1", name: "library_search", status: "running" });
    emit({ type: "tool", sessionId: "s1", turnId: "t1", name: "library_search", status: "done", summary: "2 hits" });
    const run = store.getState().runs.get("s1");
    expect(run?.answer).toBe("Hello");
    expect(run?.threadId).toBe("th1");
    expect(run?.tools).toEqual([expect.objectContaining({ name: "library_search", status: "done", summary: "2 hits" })]);
    // The foreign delta made a placeholder for a turn this window did not start.
    expect(store.getState().runs.get("s2")?.answer).toBe("NOPE");
    expect(runningCount(store.getState().runs)).toBe(2);
    emit({ type: "completed", sessionId: "s1", turnId: "t1", text: "Hello.", sources: ["526130b61f003c33"] });
    expect(store.getState().runs.get("s1")).toEqual(expect.objectContaining({ answer: "Hello.", outcome: { status: "done", text: "Hello.", sources: ["526130b61f003c33"] } }));
    expect(runningCount(store.getState().runs)).toBe(1);
  });

  it("fills in a placeholder when events beat the ask result", async () => {
    let resolveAsk: (value: AgentResult) => void = () => undefined;
    const { store, emit } = harness({ agentAsk: vi.fn(() => new Promise<AgentResult>((resolve) => { resolveAsk = resolve; })) });
    await store.start();
    const asking = store.ask({ context: { kind: "library" }, task: "summary", text: "" });
    emit({ type: "started", sessionId: "s1", threadId: "th1", turnId: "t1" });
    emit({ type: "delta", sessionId: "s1", turnId: "t1", delta: "Early" });
    resolveAsk({ ok: true, sessionId: "s1", turnId: "t1" });
    await asking;
    expect(store.getState().runs.get("s1")).toEqual(expect.objectContaining({ task: "summary", answer: "Early", threadId: "th1" }));
  });

  it("returns a refusal and refreshes the status when the agent is unavailable", async () => {
    const agentStatus = vi.fn(async () => ({ available: false, running: 0, reason: "no codex" }));
    const { store } = harness({ agentAsk: vi.fn(async () => ({ ok: false as const, code: "AGENT_UNAVAILABLE" as const, message: "no codex" })), agentStatus });
    await store.start();
    const result = await store.ask({ context: { kind: "library" }, task: "ask", text: "q" });
    expect(result).toEqual({ ok: false, code: "AGENT_UNAVAILABLE", message: "no codex" });
    expect(store.getState().runs.size).toBe(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(agentStatus).toHaveBeenCalledTimes(2);
  });

  it("keeps a finished run until the session holds its turn, then drops it after the swap grace", async () => {
    const sessionSettled = vi.fn(async () => true);
    const { store, emit, sessionsChanged } = harness({ sessionSettled });
    await store.start();
    await store.ask({ context: { kind: "library" }, task: "ask", text: "q" });
    emit({ type: "completed", sessionId: "s1", turnId: "t1", text: "Done.", sources: [] });
    expect(store.getState().runs.get("s1")?.outcome?.status).toBe("done");
    sessionsChanged();
    await vi.advanceTimersByTimeAsync(0);
    expect(sessionSettled).toHaveBeenCalledWith("s1", expect.any(String));
    expect(store.getState().runs.has("s1")).toBe(true);
    await vi.advanceTimersByTimeAsync(SWAP_GRACE_MS);
    expect(store.getState().runs.has("s1")).toBe(false);
  });

  it("drops a finished run after the TTL when no session change confirms it, and maps failures by code", async () => {
    const { store, emit } = harness();
    await store.start();
    await store.ask({ context: { kind: "library" }, task: "ask", text: "q" });
    emit({ type: "failed", sessionId: "s1", turnId: "t1", code: "TURN_INTERRUPTED", message: "stopped" });
    expect(store.getState().runs.get("s1")?.outcome).toEqual({ status: "interrupted", code: "TURN_INTERRUPTED", message: "stopped" });
    await vi.advanceTimersByTimeAsync(FINISHED_TTL_MS);
    expect(store.getState().runs.has("s1")).toBe(false);
    emit({ type: "failed", sessionId: "s3", turnId: "t3", code: "TURN_TIMEOUT", message: "too long" });
    expect(store.getState().runs.get("s3")?.outcome).toEqual({ status: "failed", code: "TURN_TIMEOUT", message: "too long" });
  });

  it("runs sessions in parallel and interrupts by session", async () => {
    const agentAsk = vi.fn(async (request: { sessionId?: string }) => ({ ok: true as const, sessionId: request.sessionId ?? "new", turnId: `t-${request.sessionId ?? "new"}` }));
    const { store, api, emit } = harness({ agentAsk });
    await store.start();
    await store.ask({ context: { kind: "library" }, task: "ask", text: "a", sessionId: "sA" });
    await store.ask({ context: { kind: "material", materialId: "m" }, task: "explain", text: "", sessionId: "sB" });
    emit({ type: "delta", sessionId: "sA", turnId: "t-sA", delta: "A" });
    emit({ type: "delta", sessionId: "sB", turnId: "t-sB", delta: "B" });
    expect(runningCount(store.getState().runs)).toBe(2);
    expect(store.getState().runs.get("sA")?.answer).toBe("A");
    expect(store.getState().runs.get("sB")?.answer).toBe("B");
    await store.interrupt("sA");
    expect(api.agentInterrupt).toHaveBeenCalledWith("sA");
  });

  it("records a bridge failure while checking a finished run instead of hiding it", async () => {
    const { store, emit, sessionsChanged } = harness({ sessionSettled: vi.fn(async () => { throw new Error("db locked"); }) });
    await store.start();
    await store.ask({ context: { kind: "library" }, task: "ask", text: "q" });
    emit({ type: "completed", sessionId: "s1", turnId: "t1", text: "x", sources: [] });
    sessionsChanged();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().statusError).toBe("db locked");
  });

  it("stop forgets every run and timer", async () => {
    const { store, emit } = harness();
    await store.start();
    emit({ type: "delta", sessionId: "s1", turnId: "t1", delta: "x" });
    store.stop();
    expect(store.getState().runs.size).toBe(0);
    emit({ type: "delta", sessionId: "s1", turnId: "t1", delta: "y" });
    expect(store.getState().runs.size).toBe(0);
  });
});

describe("agentStore: the turn shows before the bridge answers", () => {
  const library = { context: { kind: "library" as const }, task: "explain" as const, text: "" };

  it("shows a new conversation's turn under the pending key at once, then re-keys it to the session the bridge names", async () => {
    let resolveAsk: (value: AgentResult) => void = () => undefined;
    const { store, emit } = harness({ agentAsk: vi.fn(() => new Promise<AgentResult>((resolve) => { resolveAsk = resolve; })) });
    await store.start();
    const asking = store.ask(library, "pending:p1");
    const shown = store.getState().runs.get("pending:p1");
    expect(shown).toEqual(expect.objectContaining({ sessionId: "pending:p1", task: "explain", prompt: "", answer: "", tools: [], pending: true }));
    expect(runningCount(store.getState().runs)).toBe(1);
    // Events for the real session can land before the result does; they are taken in at the move.
    emit({ type: "started", sessionId: "s1", threadId: "th1", turnId: "t1" });
    emit({ type: "delta", sessionId: "s1", turnId: "t1", delta: "Early" });
    resolveAsk({ ok: true, sessionId: "s1", turnId: "t1" });
    await asking;
    expect(store.getState().runs.has("pending:p1")).toBe(false);
    const run = store.getState().runs.get("s1");
    expect(run).toEqual(expect.objectContaining({ sessionId: "s1", turnId: "t1", threadId: "th1", task: "explain", prompt: "", answer: "Early", startedAt: shown!.startedAt }));
    expect(run?.pending).toBeFalsy();
    expect(store.getState().adopted.get("pending:p1")).toBe("s1");
    expect(runningCount(store.getState().runs)).toBe(1);
    // The alias goes with the run.
    emit({ type: "completed", sessionId: "s1", turnId: "t1", text: "Early.", sources: [] });
    await vi.advanceTimersByTimeAsync(FINISHED_TTL_MS);
    expect(store.getState().runs.has("s1")).toBe(false);
    expect(store.getState().adopted.has("pending:p1")).toBe(false);
  });

  it("makes a pending key itself when none is given", async () => {
    let resolveAsk: (value: AgentResult) => void = () => undefined;
    const { store } = harness({ agentAsk: vi.fn(() => new Promise<AgentResult>((resolve) => { resolveAsk = resolve; })) });
    await store.start();
    const asking = store.ask(library);
    const [key] = [...store.getState().runs.keys()];
    expect(key).toMatch(/^pending:/);
    resolveAsk({ ok: true, sessionId: "s1", turnId: "t1" });
    await asking;
    expect([...store.getState().runs.keys()]).toEqual(["s1"]);
  });

  it("shows a known session's turn under its id at once and keeps what streamed while the bridge answered", async () => {
    let resolveAsk: (value: AgentResult) => void = () => undefined;
    const { store, emit } = harness({ agentAsk: vi.fn(() => new Promise<AgentResult>((resolve) => { resolveAsk = resolve; })) });
    await store.start();
    const asking = store.ask({ context: { kind: "library" }, task: "ask", text: "more", sessionId: "sA", threadId: "thA" });
    expect(store.getState().runs.get("sA")).toEqual(expect.objectContaining({ sessionId: "sA", pending: true, prompt: "more", threadId: "thA", answer: "" }));
    emit({ type: "delta", sessionId: "sA", turnId: "tA", delta: "Hi" });
    resolveAsk({ ok: true, sessionId: "sA", turnId: "tA" });
    await asking;
    expect(store.getState().runs.get("sA")).toEqual(expect.objectContaining({ turnId: "tA", answer: "Hi", threadId: "thA", prompt: "more" }));
    expect(store.getState().runs.get("sA")?.pending).toBeFalsy();
    expect(store.getState().adopted.size).toBe(0);
  });

  it("removes the shown turn when the bridge refuses, and when it throws", async () => {
    let resolveAsk: (value: AgentResult) => void = () => undefined;
    let rejectAsk: (reason: unknown) => void = () => undefined;
    const { store } = harness({ agentAsk: vi.fn(() => new Promise<AgentResult>((resolve, reject) => { resolveAsk = resolve; rejectAsk = reject; })) });
    await store.start();
    const first = store.ask(library, "pending:p1");
    expect(store.getState().runs.has("pending:p1")).toBe(true);
    resolveAsk({ ok: false, code: "TURN_RUNNING", message: "busy" });
    expect(await first).toEqual({ ok: false, code: "TURN_RUNNING", message: "busy" });
    expect(store.getState().runs.size).toBe(0);
    const second = store.ask(library, "pending:p2");
    expect(store.getState().runs.has("pending:p2")).toBe(true);
    rejectAsk(new Error("bridge down"));
    await expect(second).rejects.toThrow("bridge down");
    expect(store.getState().runs.size).toBe(0);
  });

  it("puts a finished run back, with its grace, when the next turn of its session is refused", async () => {
    const agentAsk = vi.fn(async () => ({ ok: true as const, sessionId: "s1", turnId: "t1" }));
    const { store, emit } = harness({ agentAsk });
    await store.start();
    await store.ask({ ...library, sessionId: "s1" });
    emit({ type: "completed", sessionId: "s1", turnId: "t1", text: "Done.", sources: [] });
    agentAsk.mockResolvedValueOnce({ ok: false as const, code: "TURN_RUNNING" as const, message: "busy" } as never);
    const asking = store.ask({ ...library, sessionId: "s1" });
    expect(store.getState().runs.get("s1")?.pending).toBe(true);
    await asking;
    expect(store.getState().runs.get("s1")?.outcome?.status).toBe("done");
    await vi.advanceTimersByTimeAsync(FINISHED_TTL_MS);
    expect(store.getState().runs.has("s1")).toBe(false);
  });

  it("shows nothing ahead of a session whose turn is already running elsewhere", async () => {
    const { store, emit } = harness({ agentAsk: vi.fn(async () => ({ ok: false as const, code: "TURN_RUNNING" as const, message: "busy" })) });
    await store.start();
    emit({ type: "delta", sessionId: "s1", turnId: "t9", delta: "theirs" });
    const asking = store.ask({ ...library, sessionId: "s1" });
    expect(store.getState().runs.get("s1")).toEqual(expect.objectContaining({ answer: "theirs" }));
    expect(store.getState().runs.get("s1")?.pending).toBeFalsy();
    await asking;
    expect(store.getState().runs.get("s1")?.answer).toBe("theirs");
  });
});
