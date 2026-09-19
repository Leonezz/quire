import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentContext, AgentFailureCode, AgentSession, AgentTask, AgentTurnRecord } from "../../shared/contracts";
import { read } from "./api";
import { agentStore, newPendingKey, useAgentRun, useAgentStatus, type RunState } from "./agentStore";
import { contextKeyOf } from "./useAgentSessions";

export interface ToolActivity { key: string; name: string; status: "running" | "done" | "failed"; summary?: string | undefined }

/** One exchange as the panel shows it: what was asked, and the answer as it streams in and once it is final. */
export interface AgentTurnState {
  id: string;
  task: AgentTask;
  prompt: string;
  /** What the user bubble shows (the panel knows the subject). */
  label: string;
  answer: string;
  tools: readonly ToolActivity[];
  status: "running" | "done" | "failed" | "interrupted";
  error?: string | undefined;
  /** The bridge's failure code, when it gave one: a timeout offers Retry. */
  code?: AgentFailureCode | undefined;
  /** The material ids the agent retrieved in this turn — the only trustworthy citations. Undefined for stored turns without them. */
  sources?: readonly string[] | undefined;
  /** Asked, and the bridge has not started the turn yet ("Thinking…" rather than a streaming answer). */
  pending?: boolean | undefined;
}

/** A question the bridge refused to start (busy, unavailable, signed out): shown inline, the words kept for Retry. */
export interface AskFailure { code: AgentFailureCode; message: string; task: AgentTask; text: string }

export type LabelOf = (task: AgentTask, text: string) => string;

/** A stored session's user/agent records as panel turns: each user record opens a turn, the agent record that follows closes it. */
export function turnsOfSession(records: readonly AgentTurnRecord[], labelOf: LabelOf): AgentTurnState[] {
  return records.reduce<AgentTurnState[]>((turns, record) => {
    if (record.role === "user") {
      const task = record.task ?? "ask";
      return [...turns, { id: record.id, task, prompt: record.text, label: labelOf(task, record.text), answer: "", tools: [], status: "failed", error: "No answer was recorded for this turn." }];
    }
    const open = turns[turns.length - 1];
    if (!open) return turns;
    const tools = (record.tools ?? []).map((tool, index) => ({ key: `${record.id}-${index}`, name: tool.name, status: tool.status, summary: tool.summary }));
    const closed: AgentTurnState = record.status === "failed" ? { ...open, tools, status: "failed", error: record.text }
      : record.status === "interrupted" ? { ...open, tools, status: "interrupted", error: record.text }
      : { ...open, tools, status: "done", answer: record.text, error: undefined, sources: record.sources };
    return [...turns.slice(0, -1), closed];
  }, []);
}

/** The live run as a panel turn. Its id follows the start time, which survives the move from a pending key to the session id. */
export function turnOfRun(run: RunState, labelOf: LabelOf): AgentTurnState {
  const { outcome } = run;
  return {
    id: `run-${run.startedAt}`, task: run.task, prompt: run.prompt, label: labelOf(run.task, run.prompt), tools: run.tools,
    answer: outcome?.text ?? run.answer, status: outcome?.status ?? "running", error: outcome?.message, code: outcome?.code, sources: outcome?.sources,
    pending: run.pending === true,
  };
}

/**
 * The transcript: the stored turns, then the live run of that session. The run's own user record is
 * already stored (an open user turn at the end) and is not shown twice; once the stored agent turn
 * has landed (recorded after the run started) it replaces the run, so nothing flashes at the swap.
 */
export function mergeTurns(records: readonly AgentTurnRecord[], run: RunState | undefined, labelOf: LabelOf): AgentTurnState[] {
  const stored = turnsOfSession(records, labelOf);
  if (!run) return stored;
  if (run.outcome && records.some((record) => record.role === "agent" && record.at >= run.startedAt)) return stored;
  const last = records[records.length - 1];
  const base = last?.role === "user" ? stored.slice(0, -1) : stored;
  return [...base, turnOfRun(run, labelOf)];
}

interface Options {
  /** Open this stored session instead of the context's most recent one; a later value opens that one. */
  sessionId?: string | undefined;
  labelOf: LabelOf;
  onSessionChange?: ((sessionId: string | undefined) => void) | undefined;
}

const EMPTY: readonly AgentTurnRecord[] = [];

/**
 * One panel's view of a conversation: the stored session it shows, merged with that session's live run
 * from the agent store. Asking goes to the store; the run keeps going when the panel unmounts, and a panel
 * mounting later finds it there. Only this session's run holds the composer — other sessions run in parallel.
 */
export function useAgent(context: AgentContext, { sessionId: namedSessionId, labelOf, onSessionChange }: Options) {
  const { status, statusError } = useAgentStatus();
  const [session, setSession] = useState<AgentSession | undefined>(undefined);
  const [sessionId, setSessionId] = useState<string | undefined>(undefined);
  const [sessionError, setSessionError] = useState<string | undefined>(undefined);
  const [loadingSession, setLoadingSession] = useState(true);
  const [askFailure, setAskFailure] = useState<AskFailure | undefined>(undefined);
  const [stopError, setStopError] = useState<string | undefined>(undefined);
  // A question asked before this panel had a session: the store shows it under this key until the bridge names one.
  const pendingKey = useRef<string | undefined>(undefined);
  const run = useAgentRun(sessionId, pendingKey);
  const threadKey = contextKeyOf(context);
  const contextRef = useRef(context);
  contextRef.current = context;
  const sessionRef = useRef<string | undefined>(undefined);
  const onSessionChangeRef = useRef(onSessionChange);
  onSessionChangeRef.current = onSessionChange;
  // Session loads race with context changes and "New conversation": only the latest one lands.
  const generation = useRef(0);
  useEffect(() => { onSessionChangeRef.current?.(sessionId); }, [sessionId]);

  const showSession = useCallback((next: AgentSession | undefined) => {
    pendingKey.current = undefined;
    sessionRef.current = next?.id;
    setSessionId(next?.id);
    setSession(next);
  }, []);

  /** Loads a session into the panel. A quiet load (a reload behind a running turn) keeps the id when the record is not there yet. */
  const loadSession = useCallback(async (id: string | undefined, { quiet = false } = {}) => {
    const mine = ++generation.current;
    if (!quiet) setLoadingSession(true);
    setSessionError(undefined);
    try {
      const next = id ? await read.getAgentSession(id) : undefined;
      if (generation.current !== mine) return;
      if (id && !next) {
        if (quiet) { pendingKey.current = undefined; sessionRef.current = id; setSessionId(id); setSession(undefined); return; }
        showSession(undefined); setSessionError("That conversation is no longer stored."); return;
      }
      showSession(next);
    } catch (cause: unknown) {
      if (generation.current === mine) { showSession(undefined); setSessionError(cause instanceof Error ? cause.message : "Could not load the conversation."); }
    } finally { if (generation.current === mine) setLoadingSession(false); }
  }, [showSession]);

  const newConversation = useCallback(() => {
    generation.current += 1;
    setLoadingSession(false); setSessionError(undefined); setAskFailure(undefined);
    showSession(undefined);
  }, [showSession]);

  // A new context shows its most recent stored conversation; a named session takes precedence and is followed when it changes.
  const namedRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (namedSessionId) {
      if (namedSessionId !== sessionRef.current) void loadSession(namedSessionId);
      namedRef.current = namedSessionId;
      return;
    }
    // The name was dropped (the caller stopped naming one): the shown session stays.
    if (namedRef.current) { namedRef.current = undefined; return; }
    const mine = ++generation.current;
    setLoadingSession(true); setSessionError(undefined);
    read.listAgentSessions()
      .then((sessions) => {
        if (generation.current !== mine) return;
        const recent = sessions.find((entry) => contextKeyOf(entry.context) === threadKey);
        if (recent) void loadSession(recent.id); else { showSession(undefined); setLoadingSession(false); }
      })
      .catch((cause: unknown) => {
        if (generation.current !== mine) return;
        showSession(undefined); setLoadingSession(false);
        setSessionError(cause instanceof Error ? cause.message : "Could not load the conversations.");
      });
  }, [threadKey, namedSessionId, loadSession, showSession]);

  // The stored turns follow the bridge: a finished run lands there and takes the live bubble's place.
  useEffect(() => read.onAgentSessionsChanged(() => { if (sessionRef.current) void loadSession(sessionRef.current, { quiet: true }); }), [loadSession]);

  const turns = mergeTurns(session?.turns ?? EMPTY, run, labelOf);
  const running = run !== undefined && run.outcome === undefined;
  const threadId = run?.threadId ?? session?.threadId;

  const ask = useCallback(async (task: AgentTask, text: string) => {
    setAskFailure(undefined);
    const request = { context: contextRef.current, task, text, ...(threadId ? { threadId } : {}), ...(sessionRef.current ? { sessionId: sessionRef.current } : {}) };
    // Without a session the run shows under a key of this panel's; the store re-keys it when the bridge names the session.
    const key = request.sessionId ? undefined : newPendingKey();
    pendingKey.current = key;
    const forget = () => { if (pendingKey.current === key) pendingKey.current = undefined; };
    try {
      const result = await agentStore.ask(request, key);
      if (result.ok) {
        if (result.sessionId !== sessionRef.current) { sessionRef.current = result.sessionId; setSessionId(result.sessionId); void loadSession(result.sessionId, { quiet: true }); }
        return;
      }
      forget();
      setAskFailure({ code: result.code, message: result.message, task, text });
    } catch (cause: unknown) {
      forget();
      setAskFailure({ code: "TURN_FAILED", message: cause instanceof Error ? cause.message : "The agent did not answer.", task, text });
    }
  }, [threadId, loadSession]);

  /** Sends a turn's question again (a timeout, a refusal) as a new turn. */
  const retry = useCallback((turn: Pick<AgentTurnState, "task" | "prompt">) => ask(turn.task, turn.prompt), [ask]);

  const stop = useCallback(async () => {
    const id = sessionRef.current;
    if (!id) return;
    setStopError(undefined);
    try { await agentStore.interrupt(id); }
    catch (cause: unknown) { setStopError(cause instanceof Error ? cause.message : "Could not stop the agent."); }
  }, []);

  const authRequired = askFailure?.code === "AUTH_REQUIRED" || (status?.available === false && /sign in|log in|login/i.test(status.reason ?? ""));

  return {
    status, statusError, refreshStatus: agentStore.refreshStatus, login: agentStore.login,
    turns, running, sessionId, sessionError, loadingSession, askFailure, stopError, authRequired,
    ask, retry, stop, loadSession, newConversation,
  };
}
