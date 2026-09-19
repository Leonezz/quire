import { useSyncExternalStore, type RefObject } from "react";
import type { AgentEvent, AgentFailureCode, AgentRequest, AgentResult, AgentRun, AgentStatus, AgentTask } from "../../shared/contracts";
import { read } from "./api";

// The renderer's agent runtime: every turn in flight, whichever panel (if any) is looking at it.
// Panels are views of this store; mounting and unmounting them changes nothing here. A run is seeded
// from `listAgentRuns()` (or created the moment `ask` is called, before the bridge answers), grows with
// `agent:event`, and is dropped once the session holds the stored turn (or a short while after it finished,
// when no session change came).

export interface RunTool { key: string; name: string; status: "running" | "done" | "failed"; summary?: string | undefined }

export interface RunOutcome {
  status: "done" | "failed" | "interrupted";
  /** The final answer (`completed`); the streamed deltas are authoritative until it arrives. */
  text?: string | undefined;
  sources?: readonly string[] | undefined;
  code?: AgentFailureCode | undefined;
  message?: string | undefined;
}

export interface RunState {
  sessionId: string;
  turnId?: string | undefined;
  threadId?: string | undefined;
  task: AgentTask;
  prompt: string;
  answer: string;
  tools: readonly RunTool[];
  startedAt: string;
  outcome?: RunOutcome | undefined;
  /** Asked and shown, but the bridge has not named the session yet: keyed by the session id when known, else by a pending key. */
  pending?: boolean | undefined;
}

export interface AgentStoreState {
  runs: ReadonlyMap<string, RunState>;
  /** Pending key → the session the bridge then named, so a panel still holding the key finds its run. */
  adopted: ReadonlyMap<string, string>;
  status?: AgentStatus | undefined;
  /** The last bridge failure the store met: reading the status, signing in, or checking a finished run's session. */
  statusError?: string | undefined;
}

/** The slice of the bridge the store drives; a parameter so tests can hand in their own. */
export interface AgentStoreApi {
  agentStatus: () => Promise<AgentStatus>;
  agentAsk: (request: AgentRequest) => Promise<AgentResult>;
  agentInterrupt: (sessionId: string) => Promise<void>;
  agentLogin: () => Promise<AgentStatus>;
  listAgentRuns: () => Promise<AgentRun[]>;
  onAgentEvent: (listener: (event: AgentEvent) => void) => () => void;
  onAgentSessionsChanged: (listener: () => void) => () => void;
  /** Whether the session now holds an agent turn recorded at or after `since`. */
  sessionSettled: (sessionId: string, since: string) => Promise<boolean>;
}

/** How long a finished run outlives its stored turn, so a panel reloading the session swaps bubbles without a gap. */
export const SWAP_GRACE_MS = 250;
/** A finished run is dropped after this even when no session change was seen. */
export const FINISHED_TTL_MS = 2000;

const newKey = () => `tool-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
/** A temporary key for a run whose session the bridge has not named yet. */
export const newPendingKey = () => `pending:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

function runOfSnapshot(run: AgentRun): RunState {
  return { sessionId: run.sessionId, turnId: run.turnId, threadId: run.threadId, task: run.task, prompt: run.prompt, answer: run.answer, tools: run.tools.map((tool) => ({ key: newKey(), ...tool })), startedAt: run.startedAt };
}

function applyEvent(run: RunState, event: AgentEvent): RunState {
  switch (event.type) {
    case "started": return { ...run, turnId: event.turnId, threadId: event.threadId };
    case "delta": return { ...run, answer: run.answer + event.delta };
    case "tool": {
      const index = run.tools.findIndex((tool) => tool.name === event.name && tool.status === "running");
      const next: RunTool = { key: index >= 0 ? run.tools[index]!.key : newKey(), name: event.name, status: event.status, summary: event.summary };
      return { ...run, tools: index >= 0 ? run.tools.map((tool, position) => (position === index ? next : tool)) : [...run.tools, next] };
    }
    case "completed": return { ...run, answer: event.text || run.answer, outcome: { status: "done", text: event.text || run.answer, sources: event.sources } };
    case "failed": return { ...run, outcome: { status: event.code === "TURN_INTERRUPTED" ? "interrupted" : "failed", code: event.code, message: event.message } };
  }
}

export function createAgentStore(api: AgentStoreApi) {
  let state: AgentStoreState = { runs: new Map(), adopted: new Map() };
  const listeners = new Set<() => void>();
  const timers = new Map<string, number>();
  let stop: (() => void) | undefined;

  const set = (next: AgentStoreState) => { state = next; for (const listener of listeners) listener(); };
  const setRuns = (runs: ReadonlyMap<string, RunState>) => set({ ...state, runs });

  const refreshStatus = async () => {
    try { set({ ...state, status: await api.agentStatus(), statusError: undefined }); }
    catch (cause: unknown) { set({ ...state, statusError: cause instanceof Error ? cause.message : "Could not reach the agent." }); }
  };

  const clearTimer = (key: string) => {
    const timer = timers.get(key);
    if (timer !== undefined) { window.clearTimeout(timer); timers.delete(key); }
  };
  const drop = (sessionId: string) => {
    clearTimer(sessionId);
    if (!state.runs.has(sessionId)) return;
    const runs = new Map(state.runs);
    runs.delete(sessionId);
    set({ ...state, runs, adopted: new Map([...state.adopted].filter(([, id]) => id !== sessionId)) });
  };
  const dropAfter = (sessionId: string, ms: number) => {
    const pending = timers.get(sessionId);
    if (pending !== undefined) window.clearTimeout(pending);
    timers.set(sessionId, window.setTimeout(() => drop(sessionId), ms));
  };

  /** A run that finished: kept until the session holds its stored turn, and at most FINISHED_TTL_MS. */
  const finished = (sessionId: string) => { dropAfter(sessionId, FINISHED_TTL_MS); void refreshStatus(); };

  const onEvent = (event: AgentEvent) => {
    const known = state.runs.get(event.sessionId);
    // A turn this window did not start (another window, or `started` landing before `ask` returned): a placeholder, filled in later.
    const run = known ?? { sessionId: event.sessionId, task: "ask" as const, prompt: "", answer: "", tools: [], startedAt: new Date().toISOString() };
    const next = applyEvent(run, event);
    setRuns(new Map(state.runs).set(event.sessionId, next));
    if (next.outcome) finished(event.sessionId);
  };

  const onSessionsChanged = () => {
    for (const run of state.runs.values()) {
      if (!run.outcome) continue;
      api.sessionSettled(run.sessionId, run.startedAt)
        .then((settled) => { if (settled) dropAfter(run.sessionId, SWAP_GRACE_MS); })
        .catch((cause: unknown) => { set({ ...state, statusError: cause instanceof Error ? cause.message : "Could not read the finished conversation." }); });
    }
  };

  const syncRuns = async () => {
    const snapshot = await api.listAgentRuns();
    const runs = new Map(state.runs);
    for (const entry of snapshot) {
      const existing = runs.get(entry.sessionId);
      // Deltas may have landed since the snapshot was taken: the longer answer is the current one.
      runs.set(entry.sessionId, existing && existing.answer.length >= entry.answer.length ? { ...existing, turnId: entry.turnId, threadId: entry.threadId, task: entry.task, prompt: entry.prompt, startedAt: entry.startedAt } : runOfSnapshot(entry));
    }
    setRuns(runs);
  };

  /** Shows the turn at once, under its session id or under `key` until the bridge names the session. */
  const begin = (key: string, request: AgentRequest) => {
    clearTimer(key);
    const run: RunState = { sessionId: key, task: request.task, prompt: request.text, answer: "", tools: [], startedAt: new Date().toISOString(), pending: true, ...(request.threadId ? { threadId: request.threadId } : {}) };
    setRuns(new Map(state.runs).set(key, run));
  };
  /** The bridge refused (or broke): the shown turn goes, and the finished run it replaced comes back for its remaining grace. */
  const unwind = (key: string, previous: RunState | undefined) => {
    const runs = new Map(state.runs);
    if (previous) runs.set(key, previous); else runs.delete(key);
    setRuns(runs);
    if (previous) dropAfter(key, FINISHED_TTL_MS);
  };
  /** The bridge named the session: the entry moves under that id, taking in the events that arrived there first. */
  const adopt = (key: string, result: { sessionId: string; turnId: string }, request: AgentRequest) => {
    const runs = new Map(state.runs);
    const shown = runs.get(key);
    const early = key === result.sessionId ? undefined : runs.get(result.sessionId);
    const base = early ?? (shown && !shown.outcome ? shown : undefined);
    if (key !== result.sessionId) runs.delete(key);
    runs.set(result.sessionId, {
      sessionId: result.sessionId, turnId: result.turnId, threadId: base?.threadId ?? request.threadId, task: request.task, prompt: request.text,
      answer: base?.answer ?? "", tools: base?.tools ?? [], startedAt: shown?.startedAt ?? base?.startedAt ?? new Date().toISOString(), outcome: base?.outcome,
    });
    const adopted = key === result.sessionId ? state.adopted : new Map(state.adopted).set(key, result.sessionId);
    set({ ...state, runs, adopted });
  };

  return {
    getState: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    /** Called once by the shell: seeds the runs, follows events and session changes. Idempotent. Rejects when the seed fails. */
    start: async () => {
      if (stop) return;
      const offEvent = api.onAgentEvent(onEvent);
      const offSessions = api.onAgentSessionsChanged(onSessionsChanged);
      stop = () => { offEvent(); offSessions(); };
      void refreshStatus();
      await syncRuns();
    },
    /** Unsubscribes and forgets every run (tests, and a shell teardown). */
    stop: () => {
      stop?.(); stop = undefined;
      for (const timer of timers.values()) window.clearTimeout(timer);
      timers.clear();
      set({ runs: new Map(), adopted: new Map() });
    },
    refreshStatus,
    login: async () => {
      try { set({ ...state, status: await api.agentLogin(), statusError: undefined }); }
      catch (cause: unknown) { set({ ...state, statusError: cause instanceof Error ? cause.message : "Signing in failed." }); }
    },
    /**
     * Starts a turn. The run shows at once — under the session id when the request names one, else under
     * `pendingKey` (or a fresh one) until the bridge names the session, when it is re-keyed and `adopted`
     * records the move. A refusal removes it and is returned, not thrown; a broken bridge removes it and throws.
     */
    ask: async (request: AgentRequest, pendingKey?: string): Promise<AgentResult> => {
      const key = request.sessionId ?? pendingKey ?? newPendingKey();
      const previous = state.runs.get(key);
      // A turn of this session is already running (another window's): the bridge will refuse, so nothing is shown ahead of it.
      const shown = !(previous && !previous.outcome);
      if (shown) begin(key, request);
      let result: AgentResult;
      try { result = await api.agentAsk(request); }
      catch (cause: unknown) { if (shown) unwind(key, previous); throw cause; }
      if (!result.ok) {
        if (shown) unwind(key, previous);
        if (result.code === "AGENT_UNAVAILABLE" || result.code === "AUTH_REQUIRED") void refreshStatus();
        return result;
      }
      adopt(key, result, request);
      void refreshStatus();
      return result;
    },
    interrupt: (sessionId: string) => api.agentInterrupt(sessionId),
    /** Test seam: the bridge's session records changed. */
    notifySessionsChanged: onSessionsChanged,
  };
}

export type AgentStore = ReturnType<typeof createAgentStore>;

async function sessionSettled(sessionId: string, since: string): Promise<boolean> {
  const session = await read.getAgentSession(sessionId);
  return session?.turns.some((turn) => turn.role === "agent" && turn.at >= since) ?? false;
}

/** The one store of the window. The bridge is read at call time, so a test's mocked `read` is honoured. */
export const agentStore: AgentStore = createAgentStore({
  agentStatus: () => read.agentStatus(),
  agentAsk: (request) => read.agentAsk(request),
  agentInterrupt: (sessionId) => read.agentInterrupt(sessionId),
  agentLogin: () => read.agentLogin(),
  listAgentRuns: () => read.listAgentRuns(),
  onAgentEvent: (listener) => read.onAgentEvent(listener),
  onAgentSessionsChanged: (listener) => read.onAgentSessionsChanged(listener),
  sessionSettled,
});

export function useAgentStore<T>(selector: (state: AgentStoreState) => T): T {
  return useSyncExternalStore(agentStore.subscribe, () => selector(agentStore.getState()), () => selector(agentStore.getState()));
}

function runOf(state: AgentStoreState, sessionId: string | undefined, pendingKey: string | undefined): RunState | undefined {
  const own = sessionId ? state.runs.get(sessionId) : undefined;
  if (own || !pendingKey) return own;
  const adopted = state.adopted.get(pendingKey);
  return state.runs.get(pendingKey) ?? (adopted ? state.runs.get(adopted) : undefined);
}

/**
 * The run in flight (or just finished) for a session; undefined when there is none. A panel that asked
 * before it had a session passes the pending key it holds in a ref: the run is found under that key, and
 * still under the session the bridge then named, until the panel adopts that session itself.
 */
export function useAgentRun(sessionId: string | undefined, pendingKey?: RefObject<string | undefined>): RunState | undefined {
  return useAgentStore((state) => runOf(state, sessionId, pendingKey?.current));
}

export function runningCount(runs: ReadonlyMap<string, RunState>): number {
  let count = 0;
  for (const run of runs.values()) if (!run.outcome) count += 1;
  return count;
}

/** How many turns are running right now, across every session. */
export function useAgentRunning(): number {
  return useAgentStore((state) => runningCount(state.runs));
}

/** Every run, keyed by session (a stable reference until a run changes). */
export function useAgentRuns(): ReadonlyMap<string, RunState> {
  return useAgentStore((state) => state.runs);
}

export function useAgentStatus(): { status: AgentStatus | undefined; statusError: string | undefined } {
  const status = useAgentStore((state) => state.status);
  const statusError = useAgentStore((state) => state.statusError);
  return { status, statusError };
}

interface OpenSessionApi { onAgentOpenSession: (listener: (sessionId: string) => void) => () => void }

/** The main process asks the window to show a session (a notification was clicked); a no-op on a bridge without it. */
export function onAgentOpenSession(listener: (sessionId: string) => void): () => void {
  const bridge = read as unknown as Partial<OpenSessionApi>;
  return typeof bridge.onAgentOpenSession === "function" ? bridge.onAgentOpenSession(listener) : () => undefined;
}
