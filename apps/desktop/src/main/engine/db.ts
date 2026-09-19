import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { MaterialMeta } from "../../shared/contracts";

export type Database = DatabaseSync;

/**
 * Sources, items and reading events live in one SQLite file (materials stay as JSON
 * files in MaterialStore). The schema is versioned with PRAGMA user_version so later
 * milestones can migrate in place instead of guessing what an old file holds.
 */
export const SCHEMA_VERSION = 4;

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  locator TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  site_url TEXT,
  added_at TEXT NOT NULL,
  interval_minutes INTEGER NOT NULL,
  last_sync_at TEXT,
  last_success_at TEXT,
  last_error TEXT,
  failure_count INTEGER NOT NULL DEFAULT 0,
  paused_at TEXT
);
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  source_title TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  external_id TEXT NOT NULL,
  title TEXT NOT NULL,
  gist TEXT NOT NULL,
  link TEXT NOT NULL,
  published_at TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  reading_minutes INTEGER NOT NULL,
  signals TEXT NOT NULL,
  summary_only INTEGER NOT NULL,
  state TEXT NOT NULL,
  opened_at TEXT,
  finished_at TEXT,
  queued_at TEXT,
  queue_position INTEGER,
  dismissed_at TEXT,
  material_id TEXT,
  introduced_by TEXT,
  content_reader_schema TEXT,
  content_reader TEXT,
  content_markdown TEXT,
  content_plain TEXT,
  UNIQUE (source_id, external_id)
);
CREATE INDEX IF NOT EXISTS items_source_id ON items (source_id);
CREATE INDEX IF NOT EXISTS items_state ON items (state);
CREATE INDEX IF NOT EXISTS items_queue_position ON items (queue_position);
CREATE TABLE IF NOT EXISTS reading_events (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS reading_events_at ON reading_events (at);
`;

// M3: per-material overrides and the agent's stored conversations. Items gain kept_at (Keep without reading).
const SCHEMA_V2 = `
CREATE TABLE IF NOT EXISTS material_meta (
  material_id TEXT PRIMARY KEY,
  title TEXT,
  byline TEXT,
  published_at TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  note TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  context TEXT NOT NULL,
  thread_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_turns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  task TEXT,
  tools TEXT,
  status TEXT,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_turns_session ON agent_turns (session_id, at);
CREATE INDEX IF NOT EXISTS agent_sessions_updated ON agent_sessions (updated_at);
`;

function hasColumn(db: Database, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((row) => row.name === column);
}

/** Every step is idempotent, so a database that was left half-migrated is completed, not corrupted. */
function migrateToV2(db: Database) {
  if (!hasColumn(db, "items", "kept_at")) db.exec("ALTER TABLE items ADD COLUMN kept_at TEXT");
  db.exec(SCHEMA_V2);
}

/** V3: an agent turn remembers which materials it retrieved, so reopened conversations keep the strict citation rule. */
function migrateToV3(db: Database) {
  if (!hasColumn(db, "agent_turns", "sources")) db.exec("ALTER TABLE agent_turns ADD COLUMN sources TEXT");
}

// V4: bibliographic metadata. The overrides become one JSON document per material (the shape of
// MaterialMeta) instead of typed columns, and items carry what their source declared (meta).
const SCHEMA_V4_META = `
CREATE TABLE IF NOT EXISTS material_meta (
  material_id TEXT PRIMARY KEY,
  overrides TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

interface LegacyMetaRow { material_id: string; title: string | null; byline: string | null; published_at: string | null; tags: string; note: string | null; updated_at: string }

/** The v3 typed columns as a MaterialMeta document: the byline becomes authors, the date becomes `date`. */
export function legacyOverridesOf(row: Pick<LegacyMetaRow, "title" | "byline" | "published_at" | "tags" | "note">): MaterialMeta {
  const creators = (row.byline ?? "").split(/,|\band\b/).map((name) => name.trim()).filter(Boolean).map((name) => ({ role: "author" as const, name }));
  const tags = JSON.parse(row.tags) as string[];
  return {
    ...(row.title ? { title: row.title } : {}),
    ...(creators.length > 0 ? { creators } : {}),
    ...(row.published_at ? { date: row.published_at } : {}),
    ...(tags.length > 0 ? { tags } : {}),
    ...(row.note ? { note: row.note } : {}),
  };
}

function migrateToV4(db: Database) {
  if (!hasColumn(db, "items", "meta")) db.exec("ALTER TABLE items ADD COLUMN meta TEXT");
  if (hasColumn(db, "material_meta", "overrides")) return;
  const rows = db.prepare("SELECT material_id, title, byline, published_at, tags, note, updated_at FROM material_meta").all() as unknown as LegacyMetaRow[];
  db.exec("BEGIN");
  try {
    db.exec("DROP TABLE material_meta");
    db.exec(SCHEMA_V4_META);
    const insert = db.prepare("INSERT INTO material_meta (material_id, overrides, updated_at) VALUES (?, ?, ?)");
    for (const row of rows) {
      const overrides = legacyOverridesOf(row);
      if (Object.keys(overrides).length > 0) insert.run(row.material_id, JSON.stringify(overrides), row.updated_at);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** The version-1 schema as M1 shipped it; tests build old databases from it to exercise the migration. */
export function createV1Database(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA_V1);
  db.exec("PRAGMA user_version = 1");
  return db;
}

/** The version-3 schema as M3 shipped it (typed metadata columns); tests build old databases from it to exercise the v4 migration. */
export function createV3Database(path: string): Database {
  const db = createV1Database(path);
  migrateToV2(db);
  migrateToV3(db);
  db.exec("PRAGMA user_version = 3");
  return db;
}

/** Opens (creating when absent) the database at `path`; ":memory:" is accepted for tests. */
export function openDatabase(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (version > SCHEMA_VERSION) throw new Error(`The library database is schema version ${version}, newer than this build understands (${SCHEMA_VERSION}). Update Quire or restore an older database.`);
  if (version < 1) db.exec(SCHEMA_V1);
  if (version < 2) migrateToV2(db);
  if (version < 3) migrateToV3(db);
  if (version < 4) migrateToV4(db);
  if (version < SCHEMA_VERSION) db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  return db;
}
