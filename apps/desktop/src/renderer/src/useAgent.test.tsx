// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, AgentResult, AgentSession } from "../../shared/contracts";
import { deferred, flush, mockRead } from "./testApi";

const api = vi.hoisted(() => ({ read: {} as ReturnType<typeof import("./testApi").mockRead> }));
vi.mock("./api", () => ({ get read() { return api.read; }, isPreview: true }));

import { turnsOfSession, useAgent } from "./useAgent";

const context = { kind: "material" as const, materialId: "526130b61f003c33" };
const labelOf = (task: string, text: string) => `${task}:${text}`;

function setup(overrides: Partial<ReturnType<typeof mockRead>> = {}) {
  const listeners = new Set<(event: AgentEvent) => void>();
  api.read = mockRead({
    agentStatus: vi.fn(async () => ({ available: true, busy: false })),
    listAgentSessions: vi.fn(async () => []),
    onAgentEvent: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    ...overrides,
  });
  const emit = (event: AgentEvent) => act(() => { for (const listener of listeners) listener(event); });
  const hook = renderHook(() => useAgent(context, { labelOf }));
  return { ...hook, emit };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("turnsOfSession", () => {
  it("pairs user and agent records into turns with their tools and outcome", () => {
    const records: AgentSession["turns"] = [
      { id: "u1", role: "user", text: "", task: "explain", at: "1" },
      { id: "a1", role: "agent", text: "Answer", task: "explain", status: "completed", tools: [{ name: "library_search", status: "done", summary: "3 hits" }], at: "2" },
      { id: "u2", role: "user", text: "why?", task: "ask", at: "3" },
      { id: "a2", role: "agent", text: "timed out", task: "ask", status: "failed", at: "4" },
      { id: "u3", role: "user", text: "and?", at: "5" },
    ];
    const turns = turnsOfSession(records, labelOf);
    expect(turns.map((turn) => [turn.label, turn.status, turn.answer, turn.error])).toEqual([
      ["explain:", "done", "Answer", undefined],
      ["ask:why?", "failed", "", "timed out"],
      ["ask:and?", "failed", "", "No answer was recorded for this turn."],
    ]);
    expect(turns[0]?.tools).toEqual([{ key: "a1-0", name: "library_search", status: "done", summary: "3 hits" }]);
    expect(turns[0]?.sources).toBeUndefined();
  });
});

describe("useAgent", () => {
  it("streams deltas and tools into the turn the events name, ignoring foreign turns, and takes the result's sources", async () => {
    const answer = deferred<AgentResult>();
    const { result, emit } = setup({ agentAsk: vi.fn(() => answer.promise) });
    await act(flush);
    expect(result.current.status?.available).toBe(true);
    act(() => { void result.current.ask("explain", "", "Explain X"); });
    expect(result.current.running).toBe(true);
    emit({ type: "started", threadId: "t1", turnId: "turn-1" });
    emit({ type: "delta", turnId: "turn-1", delta: "Hel" });
    emit({ type: "delta", turnId: "other-turn", delta: "NOPE" });
    emit({ type: "delta", turnId: "turn-1", delta: "lo" });
    emit({ type: "tool", turnId: "turn-1", name: "library_search", status: "running" });
    emit({ type: "tool", turnId: "turn-1", name: "library_search", status: "done", summary: "2 hits" });
    expect(result.current.turns[0]?.answer).toBe("Hello");
    expect(result.current.turns[0]?.tools).toEqual([expect.objectContaining({ name: "library_search", status: "done", summary: "2 hits" })]);
    emit({ type: "completed", turnId: "turn-1", sources: ["526130b61f003c33"] });
    await act(async () => { answer.resolve({ ok: true, threadId: "t1", turnId: "turn-1", text: "Hello.", sessionId: "s1", sources: ["526130b61f003c33", "63d7dedf6dd9973c"] }); await flush(); });
    expect(result.current.turns[0]).toEqual(expect.objectContaining({ status: "done", answer: "Hello.", sources: ["526130b61f003c33", "63d7dedf6dd9973c"] }));
    expect(result.current.sessionId).toBe("s1");
    expect(result.current.running).toBe(false);
    // The next question continues the same thread and session.
    act(() => { void result.current.ask("ask", "more", "more"); });
    expect(api.read.agentAsk).toHaveBeenLastCalledWith(expect.objectContaining({ threadId: "t1", sessionId: "s1", task: "ask", text: "more" }));
  });

  it("maps failure codes: timeout keeps the code for Retry, auth asks to sign in, interrupted is not a failure", async () => {
    const codes: AgentResult[] = [
      { ok: false, code: "TURN_TIMEOUT", message: "took too long" },
      { ok: false, code: "AUTH_REQUIRED", message: "sign in" },
      { ok: false, code: "TURN_INTERRUPTED", message: "stopped" },
      { ok: false, code: "TURN_FAILED", message: "boom" },
    ];
    const agentAsk = vi.fn(async () => codes.shift()!);
    const { result } = setup({ agentAsk });
    await act(flush);
    for (let index = 0; index < 4; index += 1) await act(async () => { await result.current.ask("ask", `q${index}`, `q${index}`); });
    expect(result.current.turns.map((turn) => [turn.status, turn.code, turn.authRequired ?? false, turn.error])).toEqual([
      ["failed", "TURN_TIMEOUT", false, "took too long"],
      ["failed", "AUTH_REQUIRED", true, "sign in"],
      ["interrupted", "TURN_INTERRUPTED", false, "stopped"],
      ["failed", "TURN_FAILED", false, "boom"],
    ]);
    // Retry resends the same question as a new turn.
    await act(async () => { await result.current.retry(result.current.turns[0]!); });
    expect(agentAsk).toHaveBeenLastCalledWith(expect.objectContaining({ task: "ask", text: "q0" }));
  });

  it("withdraws the question and waits when the agent is busy elsewhere", async () => {
    const agentStatus = vi.fn(async () => ({ available: true, busy: false }));
    const { result } = setup({ agentAsk: vi.fn(async () => ({ ok: false as const, code: "TURN_RUNNING" as const, message: "busy" })), agentStatus });
    await act(flush);
    agentStatus.mockResolvedValue({ available: true, busy: true });
    await act(async () => { await result.current.ask("ask", "q", "q"); await flush(); });
    expect(result.current.turns).toEqual([]);
    expect(result.current.busyElsewhere).toBe(true);
  });

  it("opens the context's most recent stored session and continues its thread", async () => {
    const session: AgentSession = { id: "s9", title: "Explain · X", context, createdAt: "1", updatedAt: "2", turnCount: 2, threadId: "thread-9", turns: [
      { id: "u1", role: "user", text: "", task: "explain", at: "1" },
      { id: "a1", role: "agent", text: "Stored answer", task: "explain", status: "completed", at: "2" },
    ] };
    const { result } = setup({
      listAgentSessions: vi.fn(async () => [{ id: "other", title: "Library chat", context: { kind: "library" as const }, createdAt: "3", updatedAt: "9", turnCount: 2 }, session]),
      getAgentSession: vi.fn(async (id: string) => (id === "s9" ? session : undefined)),
      agentAsk: vi.fn(async () => ({ ok: true as const, threadId: "thread-9", turnId: "t", text: "ok", sessionId: "s9", sources: [] })),
    });
    await act(flush);
    expect(result.current.loadingSession).toBe(false);
    expect(result.current.sessionId).toBe("s9");
    expect(result.current.turns).toEqual([expect.objectContaining({ label: "explain:", answer: "Stored answer", status: "done" })]);
    await act(async () => { await result.current.ask("ask", "next", "next"); });
    expect(api.read.agentAsk).toHaveBeenLastCalledWith(expect.objectContaining({ threadId: "thread-9", sessionId: "s9" }));
    act(() => { result.current.newConversation(); });
    expect(result.current.turns).toEqual([]);
    expect(result.current.sessionId).toBeUndefined();
  });
});
