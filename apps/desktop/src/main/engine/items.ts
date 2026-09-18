import { createHash } from "node:crypto";
import type { ItemDecision, ItemRecord, ItemSignals, SourceKind, SourceRecord } from "../../shared/contracts";
import type { Database } from "./db";

/** Full content a feed entry carried, kept on the item so Read can fall back to it when the page cannot be fetched. */
export interface ItemContent {
  reader?: { schema: "reader.document.v1" | "reader.document.v2"; payload: string };
  markdown?: string;
  plain?: string;
}

/** What a source produces per entry; the store adds identity, state and timestamps. */
export interface ItemInput {
  externalId: string;
  title: string;
  link: string;
  publishedAt: string;
  gist: string;
  readingMinutes: number;
  signals: ItemSignals;
  summaryOnly: boolean;
  content?: ItemContent;
}

export interface SourceHealth {
  itemCount: number;
  keptCount: number;
  weeklyRate: number;
}

type ItemState = "undecided" | "queued" | "dismissed" | "opened";
type Row = Record<string, string | number | null>;

const INBOX_CAP = 500;
const SEARCH_CAP = 50;
const MAX_SEARCH_WORDS = 8;
const RATE_WINDOW_DAYS = 28;

function itemIdFor(sourceId: string, externalId: string): string {
  return createHash("sha256").update(`${sourceId}\0${externalId}`).digest("hex").slice(0, 16);
}

function stateOf(row: { queued_at: string | null; dismissed_at: string | null; opened_at: string | null }): ItemState {
  if (row.queued_at) return "queued";
  if (row.dismissed_at) return "dismissed";
  if (row.opened_at) return "opened";
  return "undecided";
}

function toRecord(row: Row): ItemRecord {
  const optional = (key: string) => (typeof row[key] === "string" ? { [key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())]: row[key] } : {});
  return {
    id: row.id as string,
    sourceId: row.source_id as string,
    sourceTitle: row.source_title as string,
    sourceKind: row.source_kind as SourceKind,
    title: row.title as string,
    gist: row.gist as string,
    link: row.link as string,
    publishedAt: row.published_at as string,
    fetchedAt: row.fetched_at as string,
    readingMinutes: row.reading_minutes as number,
    signals: JSON.parse(row.signals as string) as ItemSignals,
    summaryOnly: row.summary_only === 1,
    ...optional("opened_at"), ...optional("finished_at"), ...optional("queued_at"), ...optional("dismissed_at"), ...optional("material_id"),
    ...(typeof row.queue_position === "number" ? { queuePosition: row.queue_position } : {}),
    ...(row.introduced_by === "agent" ? { introducedBy: "agent" as const } : {}),
  };
}

const COLUMNS = "id, source_id, source_title, source_kind, external_id, title, gist, link, published_at, fetched_at, reading_minutes, signals, summary_only, opened_at, finished_at, queued_at, queue_position, dismissed_at, material_id, introduced_by";

/** Items of every source. Decisions (queue / dismiss / opened) survive re-syncs; only the entry's own fields refresh. */
export class ItemStore {
  constructor(private readonly db: Database, private readonly now: () => Date = () => new Date()) {}

  /** Inserts new entries and refreshes known ones; returns how many were new. */
  upsert(source: Pick<SourceRecord, "id" | "title" | "kind">, inputs: readonly ItemInput[]): number {
    const fetchedAt = this.now().toISOString();
    const insert = this.db.prepare(`INSERT INTO items (${COLUMNS}, state, content_reader_schema, content_reader, content_markdown, content_plain)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'undecided', ?, ?, ?, ?)
      ON CONFLICT (source_id, external_id) DO UPDATE SET
        source_title = excluded.source_title, title = excluded.title, gist = excluded.gist, link = excluded.link, published_at = excluded.published_at,
        reading_minutes = excluded.reading_minutes, signals = excluded.signals, summary_only = excluded.summary_only,
        content_reader_schema = excluded.content_reader_schema, content_reader = excluded.content_reader, content_markdown = excluded.content_markdown, content_plain = excluded.content_plain`);
    const before = this.countOf(source.id);
    this.db.exec("BEGIN");
    try {
      for (const input of inputs) {
        insert.run(
          itemIdFor(source.id, input.externalId), source.id, source.title, source.kind, input.externalId, input.title, input.gist, input.link, input.publishedAt, fetchedAt,
          input.readingMinutes, JSON.stringify(input.signals), input.summaryOnly ? 1 : 0,
          input.content?.reader?.schema ?? null, input.content?.reader?.payload ?? null, input.content?.markdown ?? null, input.content?.plain ?? null,
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.countOf(source.id) - before;
  }

  private countOf(sourceId: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM items WHERE source_id = ?").get(sourceId) as { n: number }).n;
  }

  get(id: string): ItemRecord | undefined {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM items WHERE id = ?`).get(id) as Row | undefined;
    return row ? toRecord(row) : undefined;
  }

  /** The feed's own copy of the entry, when it carried one. */
  content(id: string): ItemContent | undefined {
    const row = this.db.prepare("SELECT content_reader_schema, content_reader, content_markdown, content_plain FROM items WHERE id = ?").get(id) as Row | undefined;
    if (!row) return undefined;
    const schema = row.content_reader_schema;
    const reader = (schema === "reader.document.v1" || schema === "reader.document.v2") && typeof row.content_reader === "string"
      ? { schema: schema as "reader.document.v1" | "reader.document.v2", payload: row.content_reader } : undefined;
    const content: ItemContent = {
      ...(reader ? { reader } : {}),
      ...(typeof row.content_markdown === "string" ? { markdown: row.content_markdown } : {}),
      ...(typeof row.content_plain === "string" ? { plain: row.content_plain } : {}),
    };
    return Object.keys(content).length > 0 ? content : undefined;
  }

  inbox(): ItemRecord[] {
    return (this.db.prepare(`SELECT ${COLUMNS} FROM items WHERE state = 'undecided' ORDER BY published_at DESC, id LIMIT ?`).all(INBOX_CAP) as Row[]).map(toRecord);
  }

  queue(): ItemRecord[] {
    return (this.db.prepare(`SELECT ${COLUMNS} FROM items WHERE state = 'queued' ORDER BY queue_position ASC, id`).all() as Row[]).map(toRecord);
  }

  decide(id: string, decision: ItemDecision): ItemRecord {
    const item = this.get(id);
    if (!item) throw new Error("ITEM_NOT_FOUND");
    const now = this.now().toISOString();
    if (decision === "queue") {
      const max = (this.db.prepare("SELECT MAX(queue_position) AS m FROM items WHERE state = 'queued'").get() as { m: number | null }).m;
      this.db.prepare("UPDATE items SET queued_at = COALESCE(queued_at, ?), queue_position = COALESCE(queue_position, ?), dismissed_at = NULL WHERE id = ?").run(now, (max ?? -1) + 1, id);
    } else if (decision === "unqueue") {
      this.db.prepare("UPDATE items SET queued_at = NULL, queue_position = NULL WHERE id = ?").run(id);
    } else if (decision === "dismiss") {
      this.db.prepare("UPDATE items SET dismissed_at = COALESCE(dismissed_at, ?), queued_at = NULL, queue_position = NULL WHERE id = ?").run(now, id);
    } else {
      this.db.prepare("UPDATE items SET dismissed_at = NULL WHERE id = ?").run(id);
    }
    this.refreshState(id);
    return this.get(id) as ItemRecord;
  }

  /** `ids` must be exactly the current queue, in the new order. */
  reorder(ids: readonly string[]): void {
    const current = this.queue().map((item) => item.id);
    const same = current.length === ids.length && new Set(ids).size === ids.length && ids.every((id) => current.includes(id));
    if (!same) throw new Error("QUEUE_ORDER_MISMATCH");
    const update = this.db.prepare("UPDATE items SET queue_position = ? WHERE id = ?");
    this.db.exec("BEGIN");
    try {
      ids.forEach((id, position) => update.run(position, id));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** The first read sets openedAt; every read records which material the item became. */
  markOpened(id: string, materialId: string): ItemRecord {
    if (!this.get(id)) throw new Error("ITEM_NOT_FOUND");
    this.db.prepare("UPDATE items SET opened_at = COALESCE(opened_at, ?), material_id = ? WHERE id = ?").run(this.now().toISOString(), materialId, id);
    this.refreshState(id);
    return this.get(id) as ItemRecord;
  }

  /** A material read to completion finishes every item that was read as it; the first finish sticks. */
  markFinished(materialId: string): number {
    return Number(this.db.prepare("UPDATE items SET finished_at = ? WHERE material_id = ? AND finished_at IS NULL").run(this.now().toISOString(), materialId).changes);
  }

  /** Every word must appear in the title or the source title, case-insensitively. */
  search(query: string): ItemRecord[] {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean).slice(0, MAX_SEARCH_WORDS);
    if (words.length === 0) return [];
    const clause = words.map(() => "(LOWER(title) LIKE ? ESCAPE '\\' OR LOWER(source_title) LIKE ? ESCAPE '\\')").join(" AND ");
    const params = words.flatMap((word) => { const like = `%${word.replace(/[\\%_]/g, "\\$&")}%`; return [like, like]; });
    return (this.db.prepare(`SELECT ${COLUMNS} FROM items WHERE ${clause} ORDER BY published_at DESC LIMIT ?`).all(...params, SEARCH_CAP) as Row[]).map(toRecord);
  }

  /** Removing a source drops what nobody decided on; opened, queued and dismissed items stay. */
  removeUndecidedOf(sourceId: string): number {
    return Number(this.db.prepare("DELETE FROM items WHERE source_id = ? AND state = 'undecided'").run(sourceId).changes);
  }

  healthOf(sourceId: string): SourceHealth {
    const since = new Date(this.now().getTime() - RATE_WINDOW_DAYS * 86_400_000).toISOString();
    const row = this.db.prepare(`SELECT COUNT(*) AS itemCount, SUM(material_id IS NOT NULL) AS keptCount, SUM(published_at >= ?) AS recent FROM items WHERE source_id = ?`).get(since, sourceId) as { itemCount: number; keptCount: number | null; recent: number | null };
    return { itemCount: row.itemCount, keptCount: row.keptCount ?? 0, weeklyRate: Math.round(((row.recent ?? 0) / (RATE_WINDOW_DAYS / 7)) * 10) / 10 };
  }

  private refreshState(id: string) {
    const row = this.db.prepare("SELECT queued_at, dismissed_at, opened_at FROM items WHERE id = ?").get(id) as { queued_at: string | null; dismissed_at: string | null; opened_at: string | null };
    this.db.prepare("UPDATE items SET state = ? WHERE id = ?").run(stateOf(row), id);
  }
}
