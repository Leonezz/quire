import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentContext, AgentEvent, AgentResult, AgentSession, AgentStatus, AgentTask, AgentTurnRecord } from "../../shared/contracts";
import { read } from "./api";
import { contextKeyOf } from "./useAgentSessions";

export interface ToolActivity { key: string; name: string; status: "running" | "done" | "failed"; summary?: string | undefined }
export type AgentFailureCode = Extract<AgentResult, { ok: false }>["code"];

/** One exchange: what was asked, and the answer as it streams in and once it is final. */
export interface AgentTurnState {
  /** Local id, assigned before the bridge answers; `turnId` arrives with the `started` event. */
  id: string;
  turnId?: string | undefined;
  task: AgentTask;
  prompt: string;
  /** What the user bubble shows, fixed when the turn was sent (the context may change afterwards). */
  label: string;
  answer: string;
  tools: ToolActivity[];
  status: "running" | "done" | "failed" | "interrupted";
  error?: string | undefined;
  /** The bridge's failure code, when it gave one: a timeout offers Retry, sign-in offers Sign in. */
  code?: AgentFailureCode | undefined;
  /** Set when the failure means the user has to sign in first. */
  authRequired?: boolean | undefined;
  /** The material ids the agent retrieved in this turn — the only trustworthy citations. Undefined for stored turns. */
  sources?: readonly string[] | undefined;
}

export type LabelOf = (task: AgentTask, text: string) => string;

const BUSY_POLL_MS = 2000;
const newId = () => `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

function applyEvent(turn: AgentTurnState, event: AgentEvent): AgentTurnState {
  switch (event.type) {
    case "started": return { ...turn, turnId: event.turnId };
    case "delta": return { ...turn, answer: turn.answer + event.delta };
    case "tool": {
      const running = turn.tools.findIndex((tool) => tool.name === event.name && tool.status === "running");
      const next: ToolActivity = { key: running >= 0 ? turn.tools[running]!.key : newId(), name: event.name, status: event.status, summary: event.summary };
      return { ...turn, tools: running >= 0 ? turn.tools.map((tool, index) => (index === running ? next : tool)) : [...turn.tools, next] };
    }
    case "completed": return turn.status === "running" ? { ...turn, status: "done", sources: event.sources } : { ...turn, sources: event.sources };
    case "failed": return { ...turn, status: "failed", error: event.message };
  }
}

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
      : { ...open, tools, status: "done", answer: record.text, error: undefined };
    return [...turns.slice(0, -1), closed];
  }, []);
}

interface Options {
  /** Open this stored session instead of the context's most recent one (read once per context). */
  sessionId?: string | undefined;
  /** What the user bubble says for a stored turn (the panel knows the subject). */
  labelOf: LabelOf;
  onSessionChange?: ((sessionId: string | undefined) => void) | undefined;
}

/**
 * The conversation behind one agent panel: status, the stored session it continues, turns,
 * streaming, interrupt. Events are matched to the turn they belong to; the `agentAsk` result is
 * authoritative at the end. A new context loads its most recent session; `newConversation`
 * starts an empty one whose id arrives with the first answer.
 */
export function useAgent(context: AgentContext, { sessionId: initialSessionId, labelOf, onSessionChange }: Options) {
  const [status, setStatus] = useState<AgentStatus | undefined>(undefined);
  const [statusError, setStatusError] = useState<string | undefined>(undefined);
  const [turns, setTurns] = useState<AgentTurnState[]>([]);
  const [sessionId, setSessionId] = useState<string | undefined>(undefined);
  const [sessionError, setSessionError] = useState<string | undefined>(undefined);
  const [loadingSession, setLoadingSession] = useState(true);
  const threadId = useRef<string | undefined>(undefined);
  const sessionRef = useRef<string | undefined>(undefined);
  const threadKey = contextKeyOf(context);
  const contextRef = useRef(context);
  contextRef.current = context;
  const labelRef = useRef(labelOf);
  labelRef.current = labelOf;
  const initialRef = useRef(initialSessionId);
  const onSessionChangeRef = useRef(onSessionChange);
  onSessionChangeRef.current = onSessionChange;
  // Session loads race with context changes and "New conversation": only the latest one lands.
  const generation = useRef(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { onSessionChangeRef.current?.(sessionId); }, [sessionId]);

  const refreshStatus = useCallback(async () => {
    try {
      const next = await read.agentStatus();
      if (mounted.current) { setStatus(next); setStatusError(undefined); }
    } catch (cause: unknown) {
      if (mounted.current) setStatusError(cause instanceof Error ? cause.message : "Could not reach the agent.");
    }
  }, []);
  useEffect(() => { void refreshStatus(); }, [refreshStatus]);

  const showSession = useCallback((session: AgentSession | undefined) => {
    threadId.current = session?.threadId;
    sessionRef.current = session?.id;
    setSessionId(session?.id);
    setTurns(session ? turnsOfSession(session.turns, labelRef.current) : []);
  }, []);

  const loadSession = useCallback(async (id: string | undefined) => {
    const mine = ++generation.current;
    setLoadingSession(true); setSessionError(undefined);
    try {
      const session = id ? await read.getAgentSession(id) : undefined;
      if (generation.current !== mine || !mounted.current) return;
      if (id && !session) { showSession(undefined); setSessionError("That conversation is no longer stored."); return; }
      showSession(session);
    } catch (cause: unknown) {
      if (generation.current === mine && mounted.current) { showSession(undefined); setSessionError(cause instanceof Error ? cause.message : "Could not load the conversation."); }
    } finally { if (generation.current === mine && mounted.current) setLoadingSession(false); }
  }, [showSession]);

  const newConversation = useCallback(() => {
    generation.current += 1;
    setLoadingSession(false); setSessionError(undefined);
    showSession(undefined);
  }, [showSession]);

  // A new context shows its most recent stored conversation (or the one the caller named, once).
  useEffect(() => {
    const named = initialRef.current;
    initialRef.current = undefined;
    if (named) { void loadSession(named); return; }
    const mine = ++generation.current;
    setLoadingSession(true); setSessionError(undefined);
    read.listAgentSessions()
      .then((sessions) => {
        if (generation.current !== mine || !mounted.current) return;
        const recent = sessions.find((session) => contextKeyOf(session.context) === threadKey);
        if (recent) void loadSession(recent.id); else { showSession(undefined); setLoadingSession(false); }
      })
      .catch((cause: unknown) => {
        if (generation.current !== mine || !mounted.current) return;
        showSession(undefined); setLoadingSession(false);
        setSessionError(cause instanceof Error ? cause.message : "Could not load the conversations.");
      });
  }, [threadKey, loadSession, showSession]);

  useEffect(() => read.onAgentEvent((event) => {
    setTurns((current) => {
      // `started` binds the bridge's turnId to the latest local turn still waiting for one.
      const index = event.type === "started"
        ? current.findLastIndex((turn) => turn.status === "running" && turn.turnId === undefined)
        : current.findIndex((turn) => turn.turnId === event.turnId);
      if (index < 0) return current;
      if (event.type === "started") threadId.current = event.threadId;
      return current.map((turn, position) => (position === index ? applyEvent(turn, event) : turn));
    });
  }), []);

  const running = turns.some((turn) => turn.status === "running");
  // Another panel (or window) has a turn in flight: the composer waits instead of failing with TURN_RUNNING.
  const busyElsewhere = status?.busy === true && !running;
  useEffect(() => {
    if (!busyElsewhere) return;
    const timer = window.setInterval(() => { void refreshStatus(); }, BUSY_POLL_MS);
    return () => window.clearInterval(timer);
  }, [busyElsewhere, refreshStatus]);

  const ask = useCallback(async (task: AgentTask, text: string, label: string) => {
    const id = newId();
    setTurns((current) => [...current, { id, task, prompt: text, label, answer: "", tools: [], status: "running" }]);
    const finish = (patch: Partial<AgentTurnState>) => { if (mounted.current) setTurns((current) => current.map((turn) => (turn.id === id ? { ...turn, ...patch } : turn))); };
    try {
      const result = await read.agentAsk({ context: contextRef.current, task, text, ...(threadId.current ? { threadId: threadId.current } : {}), ...(sessionRef.current ? { sessionId: sessionRef.current } : {}) });
      if (result.ok) {
        threadId.current = result.threadId;
        sessionRef.current = result.sessionId;
        if (mounted.current) setSessionId(result.sessionId);
        finish({ turnId: result.turnId, answer: result.text, status: "done", error: undefined, sources: result.sources });
        return;
      }
      if (result.code === "TURN_RUNNING") {
        // Not a failure of this question: the agent is busy elsewhere. The question is withdrawn and the composer waits.
        if (mounted.current) { setTurns((current) => current.filter((turn) => turn.id !== id)); setStatus((current) => (current ? { ...current, busy: true } : current)); }
        void refreshStatus();
        return;
      }
      finish({ status: result.code === "TURN_INTERRUPTED" ? "interrupted" : "failed", error: result.message, code: result.code, authRequired: result.code === "AUTH_REQUIRED" });
      if (result.code === "AGENT_UNAVAILABLE" || result.code === "AUTH_REQUIRED") void refreshStatus();
    } catch (cause: unknown) {
      finish({ status: "failed", error: cause instanceof Error ? cause.message : "The agent did not answer." });
    }
  }, [refreshStatus]);

  /** Sends a failed turn's question again (a timeout, for instance) as a new turn. */
  const retry = useCallback((turn: AgentTurnState) => ask(turn.task, turn.prompt, turn.label), [ask]);

  const stop = useCallback(async () => {
    try { await read.agentInterrupt(); }
    catch (cause: unknown) {
      const message = cause instanceof Error ? cause.message : "Could not stop the agent.";
      if (mounted.current) setTurns((current) => current.map((turn) => (turn.status === "running" ? { ...turn, error: message } : turn)));
    }
  }, []);

  const login = useCallback(async () => {
    try {
      const next = await read.agentLogin();
      if (mounted.current) { setStatus(next); setStatusError(undefined); }
    } catch (cause: unknown) {
      if (mounted.current) setStatusError(cause instanceof Error ? cause.message : "Signing in failed.");
    }
  }, []);

  return { status, statusError, refreshStatus, turns, running, busyElsewhere, sessionId, sessionError, loadingSession, ask, retry, stop, login, loadSession, newConversation };
}
