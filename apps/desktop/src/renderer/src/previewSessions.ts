import type { AgentContext, AgentRequest, AgentSession, AgentSessionSummary, AgentTurnRecord } from "../../shared/contracts";

// Agent sessions for the browser preview: the transcripts the scripted agent produced, kept in
// localStorage the way the engine keeps them in SQLite, so the panel's history, the Agent view
// and the sessions menu can be exercised without Codex.

export const SESSIONS_KEY = "read:preview-agent-sessions";
const TITLE_LENGTH = 60;

const listeners = new Set<() => void>();
function notify() { for (const listener of listeners) listener(); }
export function onPreviewSessionsChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function load(): AgentSession[] {
  const raw = localStorage.getItem(SESSIONS_KEY);
  if (!raw) return [];
  try { return JSON.parse(raw) as AgentSession[]; }
  catch (error) { throw new Error(`Preview agent sessions unreadable (${(error as Error).message}); clear localStorage key ${SESSIONS_KEY}.`); }
}
function save(sessions: AgentSession[]) { localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions)); }
const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** The reader's words, or "<Task> · <material title | Library>" for a canned task without any — as the engine titles a session. */
export function titleFor(request: Pick<AgentRequest, "task" | "text">, materialTitle?: string): string {
  const text = request.text.replace(/\s+/g, " ").trim();
  if (text) return text.length > TITLE_LENGTH ? `${text.slice(0, TITLE_LENGTH - 1).trimEnd()}…` : text;
  const task = request.task.charAt(0).toUpperCase() + request.task.slice(1);
  return `${task} · ${materialTitle ?? "Library"}`;
}

function summaryOf({ turns: _turns, threadId: _thread, ...summary }: AgentSession): AgentSessionSummary { return summary; }
const byUpdated = (a: AgentSession, b: AgentSession) => b.updatedAt.localeCompare(a.updatedAt);

/** Most recently updated first. */
export function listSessions(): AgentSessionSummary[] { return [...load()].sort(byUpdated).map(summaryOf); }
export function getSession(id: string): AgentSession | undefined { return load().find((session) => session.id === id); }

export function createSession(context: AgentContext, title: string): AgentSession {
  const at = new Date().toISOString();
  const session: AgentSession = { id: newId("session"), title: title.trim() || "Untitled", context, createdAt: at, updatedAt: at, turnCount: 0, turns: [] };
  save([...load(), session]);
  notify();
  return session;
}

export function appendTurn(sessionId: string, turn: Omit<AgentTurnRecord, "id" | "at">): AgentTurnRecord {
  const record: AgentTurnRecord = { ...turn, id: newId("turn"), at: new Date().toISOString() };
  const sessions = load();
  if (!sessions.some((session) => session.id === sessionId)) throw new Error(`Session ${sessionId} no longer exists; start a new one.`);
  save(sessions.map((session) => (session.id === sessionId ? { ...session, updatedAt: record.at, turnCount: session.turnCount + 1, turns: [...session.turns, record] } : session)));
  notify();
  return record;
}

export function setThread(sessionId: string, threadId: string) {
  save(load().map((session) => (session.id === sessionId ? { ...session, threadId } : session)));
}

export function deleteSession(id: string) {
  const sessions = load();
  if (!sessions.some((session) => session.id === id)) throw new Error(`No agent session ${id}; it may already be deleted.`);
  save(sessions.filter((session) => session.id !== id));
  notify();
}
