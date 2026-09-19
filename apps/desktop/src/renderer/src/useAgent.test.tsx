// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, AgentResult, AgentSession, AgentTurnRecord } from "../../shared/contracts";
import { deferred, flush, mockRead } from "./testApi";

const api = vi.hoisted(() => ({ read: {} as ReturnType<typeof import("./testApi").mockRead> }));
vi.mock("./api", () => ({ get read() { return api.read; }, isPreview: true }));

import { agentStore } from "./agentStore";
import { mergeTurns, turnsOfSession, useAgent } from "./useAgent";

const context = { kind: "material" as const, materialId: "526130b61f003c33" };
const labelOf = (task: string, text: string) => `${task}:${text}`;

/** A bridge whose sessions are a map the test edits; `change()` tells the listeners. */
function setup(overrides: Partial<ReturnType<typeof mockRead>> = {}, sessions: AgentSession[] = []) {
  const events = new Set<(event: AgentEvent) => void>();
  const changes = new Set<() => void>();
  const stored = new Map(sessions.map((session) => [session.id, session]));
  api.read = mockRead({
    agentStatus: vi.fn(async () => ({ available: true, running: 0 })),
    listAgentRuns: vi.fn(async () => []),
    listAgentSessions: vi.fn(async () => [...stored.values()].map(({ turns: _turns, threadId: _thread, ...summary }) => summary)),
    getAgentSession: vi.fn(async (id: string) => stored.get(id)),
    agentAsk: vi.fn(async (request: { sessionId?: string }) => ({ ok: true as const, sessionId: request.sessionId ?? "s1", turnId: "t1" })),
    agentInterrupt: vi.fn(async () => undefined),
    onAgentEvent: (listener) => { events.add(listener); return () => { events.delete(listener); }; },
    onAgentSessionsChanged: (listener) => { changes.add(listener); return () => { changes.delete(listener); }; },
    ...overrides,
  });
  const emit = (event: AgentEvent) => act(() => { for (const listener of events) listener(event); });
  const store = (session: AgentSession) => { stored.set(session.id, session); };
  const change = async () => { await act(async () => { for (const listener of changes) listener(); await flush(); }); };
  return { emit, store, change };
}

const mount = (options: { sessionId?: string | undefined } = {}) => renderHook(() => useAgent(context, { labelOf, ...options }));
const user = (id: string, text: string, at: string): AgentTurnRecord => ({ id, role: "user", text, task: "ask", at });
const agent = (id: string, text: string, at: string): AgentTurnRecord => ({ id, role: "agent", text, task: "ask", status: "completed", at });
const session = (id: string, turns: AgentTurnRecord[], threadId?: string): AgentSession => ({ id, title: id, context, createdAt: "1", updatedAt: "2", turnCount: turns.length, turns, ...(threadId ? { threadId } : {}) });

afterEach(() => { agentStore.stop(); vi.restoreAllMocks(); });

describe("turnsOfSession", () => {
  it("pairs user and agent records into turns with their tools, sources and outcome", () => {
    const records: AgentTurnRecord[] = [
      { id: "u1", role: "user", text: "", task: "explain", at: "1" },
      { id: "a1", role: "agent", text: "Answer", task: "explain", status: "completed", tools: [{ name: "library_search", status: "done", summary: "3 hits" }], sources: ["526130b61f003c33"], at: "2" },
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
    expect(turns[0]?.sources).toEqual(["526130b61f003c33"]);
  });
});

describe("mergeTurns", () => {
  const run = { sessionId: "s1", task: "ask" as const, prompt: "more", answer: "Str", tools: [], startedAt: "2026-09-19T10:00:05.000Z" };
  it("replaces the open user record with the live run, then yields to the stored turn once it landed", () => {
    const records = [user("u1", "first", "2026-09-19T10:00:00.000Z"), agent("a1", "One.", "2026-09-19T10:00:01.000Z"), user("u2", "more", "2026-09-19T10:00:04.000Z")];
    expect(mergeTurns(records, run, labelOf).map((turn) => [turn.label, turn.status, turn.answer])).toEqual([["ask:first", "done", "One."], ["ask:more", "running", "Str"]]);
    const finished = { ...run, outcome: { status: "done" as const, text: "Streamed." } };
    expect(mergeTurns(records, finished, labelOf).map((turn) => [turn.status, turn.answer])).toEqual([["done", "One."], ["done", "Streamed."]]);
    const landed = [...records, agent("a2", "Stored.", "2026-09-19T10:00:09.000Z")];
    expect(mergeTurns(landed, finished, labelOf).map((turn) => [turn.status, turn.answer])).toEqual([["done", "One."], ["done", "Stored."]]);
  });
});

describe("useAgent", () => {
  it("asks through the store and streams the run of its session, ignoring other sessions", async () => {
    const { emit } = setup();
    await act(() => agentStore.start());
    const { result } = mount();
    await act(flush);
    expect(result.current.status?.available).toBe(true);
    expect(result.current.loadingSession).toBe(false);
    await act(async () => { await result.current.ask("explain", ""); });
    expect(api.read.agentAsk).toHaveBeenLastCalledWith({ context, task: "explain", text: "" });
    expect(result.current.sessionId).toBe("s1");
    expect(result.current.running).toBe(true);
    expect(result.current.turns).toEqual([expect.objectContaining({ label: "explain:", status: "running", answer: "" })]);
    emit({ type: "started", sessionId: "s1", threadId: "th1", turnId: "t1" });
    emit({ type: "delta", sessionId: "s1", turnId: "t1", delta: "Hel" });
    emit({ type: "delta", sessionId: "other", turnId: "t9", delta: "NOPE" });
    emit({ type: "delta", sessionId: "s1", turnId: "t1", delta: "lo" });
    expect(result.current.turns[0]?.answer).toBe("Hello");
    emit({ type: "completed", sessionId: "s1", turnId: "t1", text: "Hello.", sources: ["526130b61f003c33"] });
    expect(result.current.turns[0]).toEqual(expect.objectContaining({ status: "done", answer: "Hello.", sources: ["526130b61f003c33"] }));
    expect(result.current.running).toBe(false);
    // The next question continues the same thread and session.
    await act(async () => { await result.current.ask("ask", "more"); });
    expect(api.read.agentAsk).toHaveBeenLastCalledWith(expect.objectContaining({ threadId: "th1", sessionId: "s1", task: "ask", text: "more" }));
  });

  it("keeps the run across unmount and shows the partial answer on remount", async () => {
    const { emit, store } = setup();
    await act(() => agentStore.start());
    const first = mount();
    await act(flush);
    await act(async () => { await first.result.current.ask("ask", "q"); });
    store(session("s1", [user("u1", "q", "2026-09-19T10:00:00.000Z")], "th1"));
    emit({ type: "delta", sessionId: "s1", turnId: "t1", delta: "Part" });
    first.unmount();
    emit({ type: "delta", sessionId: "s1", turnId: "t1", delta: "ial" });
    expect(agentStore.getState().runs.get("s1")?.answer).toBe("Partial");
    const second = mount();
    await act(flush);
    expect(second.result.current.sessionId).toBe("s1");
    expect(second.result.current.running).toBe(true);
    expect(second.result.current.turns).toEqual([expect.objectContaining({ label: "ask:q", status: "running", answer: "Partial" })]);
  });

  it("swaps the live bubble for the stored turn once the session holds it, without a duplicate", async () => {
    const { emit, store, change } = setup();
    await act(() => agentStore.start());
    const { result } = mount();
    await act(flush);
    await act(async () => { await result.current.ask("ask", "q"); });
    const startedAt = agentStore.getState().runs.get("s1")!.startedAt;
    store(session("s1", [user("u1", "q", startedAt)]));
    await change();
    expect(result.current.turns).toHaveLength(1);
    emit({ type: "completed", sessionId: "s1", turnId: "t1", text: "Final.", sources: [] });
    expect(result.current.turns).toEqual([expect.objectContaining({ status: "done", answer: "Final." })]);
    const later = new Date(new Date(startedAt).getTime() + 1000).toISOString();
    store(session("s1", [user("u1", "q", startedAt), { ...agent("a1", "Final.", later), sources: ["526130b61f003c33"] }]));
    await change();
    expect(result.current.turns).toEqual([expect.objectContaining({ id: "u1", status: "done", answer: "Final.", sources: ["526130b61f003c33"] })]);
    expect(result.current.running).toBe(false);
  });

  it("runs sessions in parallel: only this session's run holds the composer, Stop interrupts by session", async () => {
    const { emit } = setup();
    await act(() => agentStore.start());
    const library = renderHook(() => useAgent({ kind: "library" }, { labelOf }));
    const material = mount();
    await act(flush);
    await act(async () => { await library.result.current.ask("summary", ""); });
    expect(library.result.current.running).toBe(true);
    expect(material.result.current.running).toBe(false);
    (api.read.agentAsk as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: true, sessionId: "s2", turnId: "t2" });
    await act(async () => { await material.result.current.ask("explain", ""); });
    expect(material.result.current.running).toBe(true);
    emit({ type: "delta", sessionId: "s2", turnId: "t2", delta: "B" });
    expect(material.result.current.turns[0]?.answer).toBe("B");
    expect(library.result.current.turns[0]?.answer).toBe("");
    await act(async () => { await material.result.current.stop(); });
    expect(api.read.agentInterrupt).toHaveBeenCalledWith("s2");
    emit({ type: "failed", sessionId: "s2", turnId: "t2", code: "TURN_INTERRUPTED", message: "stopped" });
    expect(material.result.current.turns[0]).toEqual(expect.objectContaining({ status: "interrupted", error: "stopped" }));
    expect(material.result.current.running).toBe(false);
    expect(library.result.current.running).toBe(true);
  });

  it("shows the question at once, before the bridge answers, and adopts the session it names", async () => {
    const asked = deferred<AgentResult>();
    const { emit } = setup({ agentAsk: vi.fn(() => asked.promise) });
    await act(() => agentStore.start());
    const { result } = mount();
    await act(flush);
    let asking: Promise<void> = Promise.resolve();
    act(() => { asking = result.current.ask("explain", ""); });
    // Before the promise resolves: the turn is there, running, and the panel has no session yet.
    expect(result.current.sessionId).toBeUndefined();
    expect(result.current.running).toBe(true);
    expect(result.current.turns).toEqual([expect.objectContaining({ label: "explain:", status: "running", pending: true, answer: "" })]);
    const id = result.current.turns[0]?.id;
    emit({ type: "delta", sessionId: "s1", turnId: "t1", delta: "Ear" });
    await act(async () => { asked.resolve({ ok: true, sessionId: "s1", turnId: "t1" }); await asking; await flush(); });
    expect(result.current.sessionId).toBe("s1");
    expect(result.current.turns).toEqual([expect.objectContaining({ id, label: "explain:", status: "running", pending: false, answer: "Ear" })]);
    emit({ type: "delta", sessionId: "s1", turnId: "t1", delta: "ly" });
    expect(result.current.turns[0]?.answer).toBe("Early");
  });

  it("takes the shown question away again when the bridge refuses it", async () => {
    const asked = deferred<AgentResult>();
    setup({ agentAsk: vi.fn(() => asked.promise) });
    await act(() => agentStore.start());
    const { result } = mount();
    await act(flush);
    let asking: Promise<void> = Promise.resolve();
    act(() => { asking = result.current.ask("ask", "q"); });
    expect(result.current.turns).toHaveLength(1);
    expect(result.current.running).toBe(true);
    await act(async () => { asked.resolve({ ok: false, code: "TURN_RUNNING", message: "busy" }); await asking; });
    expect(result.current.turns).toEqual([]);
    expect(result.current.running).toBe(false);
    expect(result.current.askFailure).toEqual({ code: "TURN_RUNNING", message: "busy", task: "ask", text: "q" });
  });

  it("shows a refusal inline and keeps the words for Retry", async () => {
    setup({ agentAsk: vi.fn(async () => ({ ok: false as const, code: "TURN_RUNNING" as const, message: "busy" })) });
    await act(() => agentStore.start());
    const { result } = mount();
    await act(flush);
    await act(async () => { await result.current.ask("ask", "q"); });
    expect(result.current.askFailure).toEqual({ code: "TURN_RUNNING", message: "busy", task: "ask", text: "q" });
    expect(result.current.turns).toEqual([]);
    expect(result.current.running).toBe(false);
    await act(async () => { await result.current.retry({ task: "ask", prompt: "q" }); });
    expect(api.read.agentAsk).toHaveBeenCalledTimes(2);
  });

  it("opens the context's most recent stored session, continues its thread, and follows a named session", async () => {
    const stored = session("s9", [{ id: "u1", role: "user", text: "", task: "explain", at: "1" }, { id: "a1", role: "agent", text: "Stored answer", task: "explain", status: "completed", at: "2" }], "thread-9");
    const other: AgentSession = { id: "other", title: "Library chat", context: { kind: "library" }, createdAt: "3", updatedAt: "9", turnCount: 0, turns: [] };
    setup({}, [other, stored]);
    await act(() => agentStore.start());
    const { result, rerender } = renderHook(({ sessionId }: { sessionId?: string | undefined }) => useAgent(context, { labelOf, sessionId }), { initialProps: {} });
    await act(flush);
    expect(result.current.loadingSession).toBe(false);
    expect(result.current.sessionId).toBe("s9");
    expect(result.current.turns).toEqual([expect.objectContaining({ label: "explain:", answer: "Stored answer", status: "done" })]);
    await act(async () => { await result.current.ask("ask", "next"); });
    expect(api.read.agentAsk).toHaveBeenLastCalledWith(expect.objectContaining({ threadId: "thread-9", sessionId: "s9" }));
    rerender({ sessionId: "other" });
    await act(flush);
    expect(result.current.sessionId).toBe("other");
    act(() => { result.current.newConversation(); });
    expect(result.current.turns).toEqual([]);
    expect(result.current.sessionId).toBeUndefined();
  });
});
