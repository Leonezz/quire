import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Database = DatabaseSync;

/**
 * Sources, items and reading events live in one SQLite file (materials stay as JSON
 * files in MaterialStore). The schema is versioned with PRAGMA user_version so later
 * milestones can migrate in place instead of guessing what an old file holds.
 */
export const SCHEMA_VERSION = 1;

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

/** Opens (creating when absent) the database at `path`; ":memory:" is accepted for tests. */
export function openDatabase(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (version > SCHEMA_VERSION) throw new Error(`The library database is schema version ${version}, newer than this build understands (${SCHEMA_VERSION}). Update Quire or restore an older database.`);
  if (version < 1) {
    db.exec(SCHEMA_V1);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }
  return db;
}
