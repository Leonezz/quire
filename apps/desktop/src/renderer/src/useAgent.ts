import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentContext, AgentEvent, AgentStatus, AgentTask } from "../../shared/contracts";
import { read } from "./api";

export interface ToolActivity { key: string; name: string; status: "running" | "done" | "failed"; summary?: string | undefined }

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
  /** Set when the failure means the user has to sign in first. */
  authRequired?: boolean | undefined;
}

const newId = () => `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** The thread follows the material: a different material (or the library) is a new conversation. */
function threadKeyOf(context: AgentContext): string {
  return context.kind === "library" ? "library" : `material:${context.materialId}`;
}

function applyEvent(turn: AgentTurnState, event: AgentEvent): AgentTurnState {
  switch (event.type) {
    case "started": return { ...turn, turnId: event.turnId };
    case "delta": return { ...turn, answer: turn.answer + event.delta };
    case "tool": {
      const running = turn.tools.findIndex((tool) => tool.name === event.name && tool.status === "running");
      const next: ToolActivity = { key: running >= 0 ? turn.tools[running]!.key : newId(), name: event.name, status: event.status, summary: event.summary };
      return { ...turn, tools: running >= 0 ? turn.tools.map((tool, index) => (index === running ? next : tool)) : [...turn.tools, next] };
    }
    case "completed": return turn.status === "running" ? { ...turn, status: "done" } : turn;
    case "failed": return { ...turn, status: "failed", error: event.message };
  }
}

/**
 * The conversation behind one agent panel: status, turns, streaming, interrupt.
 * Events are matched to the turn they belong to; the `agentAsk` result is authoritative at the end.
 */
export function useAgent(context: AgentContext) {
  const [status, setStatus] = useState<AgentStatus | undefined>(undefined);
  const [statusError, setStatusError] = useState<string | undefined>(undefined);
  const [turns, setTurns] = useState<AgentTurnState[]>([]);
  const threadId = useRef<string | undefined>(undefined);
  // The stored session the turns append to; the first answer names it, follow-ups carry it back.
  const sessionId = useRef<string | undefined>(undefined);
  const threadKey = threadKeyOf(context);
  const contextRef = useRef(context);
  contextRef.current = context;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const refreshStatus = useCallback(async () => {
    try {
      const next = await read.agentStatus();
      if (mounted.current) { setStatus(next); setStatusError(undefined); }
    } catch (cause: unknown) {
      if (mounted.current) setStatusError(cause instanceof Error ? cause.message : "Could not reach the agent.");
    }
  }, []);
  useEffect(() => { void refreshStatus(); }, [refreshStatus]);

  // A new material means a new thread and an empty transcript.
  useEffect(() => { threadId.current = undefined; sessionId.current = undefined; setTurns([]); }, [threadKey]);

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

  const ask = useCallback(async (task: AgentTask, text: string, label: string) => {
    const id = newId();
    setTurns((current) => [...current, { id, task, prompt: text, label, answer: "", tools: [], status: "running" }]);
    const finish = (patch: Partial<AgentTurnState>) => { if (mounted.current) setTurns((current) => current.map((turn) => (turn.id === id ? { ...turn, ...patch } : turn))); };
    try {
      const result = await read.agentAsk({ context: contextRef.current, task, text, ...(threadId.current ? { threadId: threadId.current } : {}), ...(sessionId.current ? { sessionId: sessionId.current } : {}) });
      if (result.ok) {
        threadId.current = result.threadId;
        sessionId.current = result.sessionId;
        finish({ turnId: result.turnId, answer: result.text, status: "done", error: undefined });
      } else {
        finish({ status: result.code === "TURN_INTERRUPTED" ? "interrupted" : "failed", error: result.message, authRequired: result.code === "AUTH_REQUIRED" });
        if (result.code === "AGENT_UNAVAILABLE" || result.code === "AUTH_REQUIRED") void refreshStatus();
      }
    } catch (cause: unknown) {
      finish({ status: "failed", error: cause instanceof Error ? cause.message : "The agent did not answer." });
    }
  }, [refreshStatus]);

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

  return { status, statusError, refreshStatus, turns, running, ask, stop, login };
}
