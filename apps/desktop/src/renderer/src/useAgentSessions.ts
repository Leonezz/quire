import { useCallback, useEffect, useState } from "react";
import type { AgentContext, AgentSessionSummary } from "../../shared/contracts";
import { read } from "./api";

/**
 * Which conversations belong together: the library, or one material (a selection inside a material
 * continues that material's conversation, as the panel's thread does).
 */
export function contextKeyOf(context: AgentContext): string {
  return context.kind === "library" ? "library" : `material:${context.materialId}`;
}

/** "Library", the material's title (or its id when the title is unknown), or the selection's material. */
export function sessionContextLabel(context: AgentContext, titleOf: (id: string) => string | undefined): string {
  if (context.kind === "library") return "Library";
  const title = titleOf(context.materialId) ?? `Material ${context.materialId.slice(0, 8)}`;
  return context.kind === "selection" ? `selection · ${title}` : title;
}

export interface AgentSessions {
  /** Every stored session, most recently updated first. */
  sessions: AgentSessionSummary[];
  loaded: boolean;
  error: string | undefined;
  refresh: () => Promise<void>;
  /** Deletes a session; the list refreshes through the change event and the returned promise. Throws on failure. */
  remove: (id: string) => Promise<void>;
  /** The sessions of one context, most recent first. */
  forContext: (context: AgentContext) => AgentSessionSummary[];
}

/** The stored agent sessions: loaded on mount and whenever the main side reports a change. */
export function useAgentSessions(): AgentSessions {
  const [sessions, setSessions] = useState<AgentSessionSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const refresh = useCallback(async () => {
    try {
      setSessions(await read.listAgentSessions());
      setError(undefined);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "Could not load the agent's conversations.");
    } finally { setLoaded(true); }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => read.onAgentSessionsChanged(() => { void refresh(); }), [refresh]);

  const remove = useCallback(async (id: string) => {
    await read.deleteAgentSession(id);
    await refresh();
  }, [refresh]);

  const forContext = useCallback((context: AgentContext) => {
    const key = contextKeyOf(context);
    return sessions.filter((session) => contextKeyOf(session.context) === key);
  }, [sessions]);

  return { sessions, loaded, error, refresh, remove, forContext };
}
