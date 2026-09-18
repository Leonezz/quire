import { randomBytes } from "node:crypto";
import type { AgentContext, AgentRequest, AgentSession, AgentSessionSummary, AgentTurnRecord } from "../../shared/contracts";
import type { Database } from "./db";

// The agent's conversations, kept so the panel can reopen one. The Codex thread id is stored with
// the session; when the thread cannot be resumed the transcript is still here.

const TITLE_LENGTH = 60;
type SessionRow = { id: string; title: string; context: string; thread_id: string | null; created_at: string; updated_at: string; turn_count: number };
type TurnRow = { id: string; role: string; text: string; task: string | null; tools: string | null; status: string | null; at: string };

export type TurnInput = Omit<AgentTurnRecord, "id" | "at">;

/** The reader's words, or "<Task> · <material title | Library>" for a canned task without any. */
export function titleFor(request: Pick<AgentRequest, "task" | "text">, materialTitle?: string): string {
  const text = request.text.replace(/\s+/g, " ").trim();
  if (text) return text.length > TITLE_LENGTH ? `${text.slice(0, TITLE_LENGTH - 1).trimEnd()}…` : text;
  const task = request.task.charAt(0).toUpperCase() + request.task.slice(1);
  return `${task} · ${materialTitle ?? "Library"}`;
}

function toSummary(row: SessionRow): AgentSessionSummary {
  return { id: row.id, title: row.title, context: JSON.parse(row.context) as AgentContext, createdAt: row.created_at, updatedAt: row.updated_at, turnCount: row.turn_count };
}

function toTurn(row: TurnRow): AgentTurnRecord {
  return {
    id: row.id, role: row.role as AgentTurnRecord["role"], text: row.text, at: row.at,
    ...(row.task ? { task: row.task as AgentTurnRecord["task"] } : {}),
    ...(row.tools ? { tools: JSON.parse(row.tools) as AgentTurnRecord["tools"] } : {}),
    ...(row.status ? { status: row.status as AgentTurnRecord["status"] } : {}),
  };
}

const SESSION_COLUMNS = "s.id, s.title, s.context, s.thread_id, s.created_at, s.updated_at, (SELECT COUNT(*) FROM agent_turns t WHERE t.session_id = s.id) AS turn_count";

export class SessionStore {
  constructor(private readonly db: Database, private readonly now: () => Date = () => new Date()) {}

  create(context: AgentContext, title: string): AgentSession {
    const id = randomBytes(8).toString("hex");
    const at = this.now().toISOString();
    this.db.prepare("INSERT INTO agent_sessions (id, title, context, thread_id, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?)").run(id, title.trim() || "Untitled", JSON.stringify(context), at, at);
    return this.get(id) as AgentSession;
  }

  /** Most recently updated first. */
  list(): AgentSessionSummary[] {
    return (this.db.prepare(`SELECT ${SESSION_COLUMNS} FROM agent_sessions s ORDER BY s.updated_at DESC, s.rowid DESC`).all() as unknown as SessionRow[]).map(toSummary);
  }

  get(id: string): AgentSession | undefined {
    const row = this.db.prepare(`SELECT ${SESSION_COLUMNS} FROM agent_sessions s WHERE s.id = ?`).get(id) as unknown as SessionRow | undefined;
    if (!row) return undefined;
    const turns = (this.db.prepare("SELECT id, role, text, task, tools, status, at FROM agent_turns WHERE session_id = ? ORDER BY at, rowid").all(id) as unknown as TurnRow[]).map(toTurn);
    return { ...toSummary(row), ...(row.thread_id ? { threadId: row.thread_id } : {}), turns };
  }

  appendTurn(sessionId: string, turn: TurnInput): AgentTurnRecord {
    if (!this.exists(sessionId)) throw new Error("SESSION_NOT_FOUND");
    const record: AgentTurnRecord = { ...turn, id: randomBytes(8).toString("hex"), at: this.now().toISOString() };
    this.db.exec("BEGIN");
    try {
      this.db.prepare("INSERT INTO agent_turns (id, session_id, role, text, task, tools, status, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(record.id, sessionId, record.role, record.text, record.task ?? null, record.tools ? JSON.stringify(record.tools) : null, record.status ?? null, record.at);
      this.db.prepare("UPDATE agent_sessions SET updated_at = ? WHERE id = ?").run(record.at, sessionId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return record;
  }

  setThread(sessionId: string, threadId: string): void {
    if (!this.exists(sessionId)) throw new Error("SESSION_NOT_FOUND");
    this.db.prepare("UPDATE agent_sessions SET thread_id = ? WHERE id = ?").run(threadId, sessionId);
  }

  delete(id: string): void {
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM agent_turns WHERE session_id = ?").run(id);
      this.db.prepare("DELETE FROM agent_sessions WHERE id = ?").run(id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private exists(id: string): boolean {
    return this.db.prepare("SELECT 1 FROM agent_sessions WHERE id = ?").get(id) !== undefined;
  }
}
