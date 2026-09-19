import { useSyncExternalStore } from "react";
import type { AgentEvent, AgentFailureCode, AgentRequest, AgentResult, AgentRun, AgentStatus, AgentTask } from "../../shared/contracts";
import { read } from "./api";

// The renderer's agent runtime: every turn in flight, whichever panel (if any) is looking at it.
// Panels are views of this store; mounting and unmounting them changes nothing here. A run is seeded
// from `listAgentRuns()` (or created when `ask` returns), grows with `agent:event`, and is dropped once
// the session holds the stored turn (or a short while after it finished, when no session change came).

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
}

export interface AgentStoreState {
  runs: ReadonlyMap<string, RunState>;
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
  let state: AgentStoreState = { runs: new Map() };
  const listeners = new Set<() => void>();
  const timers = new Map<string, number>();
  let stop: (() => void) | undefined;

  const set = (next: AgentStoreState) => { state = next; for (const listener of listeners) listener(); };
  const setRuns = (runs: ReadonlyMap<string, RunState>) => set({ ...state, runs });

  const refreshStatus = async () => {
    try { set({ ...state, status: await api.agentStatus(), statusError: undefined }); }
    catch (cause: unknown) { set({ ...state, statusError: cause instanceof Error ? cause.message : "Could not reach the agent." }); }
  };

  const drop = (sessionId: string) => {
    const timer = timers.get(sessionId);
    if (timer !== undefined) { window.clearTimeout(timer); timers.delete(sessionId); }
    if (!state.runs.has(sessionId)) return;
    const runs = new Map(state.runs);
    runs.delete(sessionId);
    setRuns(runs);
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
      set({ runs: new Map() });
    },
    refreshStatus,
    login: async () => {
      try { set({ ...state, status: await api.agentLogin(), statusError: undefined }); }
      catch (cause: unknown) { set({ ...state, statusError: cause instanceof Error ? cause.message : "Signing in failed." }); }
    },
    /** Starts a turn; the run appears here once the bridge names its session. A refusal is returned, not thrown; a broken bridge throws. */
    ask: async (request: AgentRequest): Promise<AgentResult> => {
      const result = await api.agentAsk(request);
      if (!result.ok) {
        if (result.code === "AGENT_UNAVAILABLE" || result.code === "AUTH_REQUIRED") void refreshStatus();
        return result;
      }
      const placeholder = state.runs.get(result.sessionId);
      // Events that raced ahead of this result already live in the placeholder; only the words are filled in.
      const run: RunState = placeholder && !placeholder.outcome
        ? { ...placeholder, turnId: result.turnId, task: request.task, prompt: request.text }
        : { sessionId: result.sessionId, turnId: result.turnId, task: request.task, prompt: request.text, answer: "", tools: [], startedAt: new Date().toISOString(), ...(request.threadId ? { threadId: request.threadId } : {}) };
      setRuns(new Map(state.runs).set(result.sessionId, run));
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

/** The run in flight (or just finished) for a session; undefined when there is none. */
export function useAgentRun(sessionId: string | undefined): RunState | undefined {
  return useAgentStore((state) => (sessionId ? state.runs.get(sessionId) : undefined));
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
