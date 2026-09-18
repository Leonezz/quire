import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SCHEMA_VERSION, createV1Database, openDatabase, type Database } from "./db";

let root = "";
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "read-db-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const version = (db: Database) => (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
const columns = (db: Database, table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
const tables = (db: Database) => (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((t) => t.name);

describe("openDatabase", () => {
  it("creates a fresh database at the current version with the M3 tables", () => {
    const db = openDatabase(":memory:");
    expect(SCHEMA_VERSION).toBe(3);
    expect(version(db)).toBe(3);
    expect(tables(db)).toEqual(["agent_sessions", "agent_turns", "items", "material_meta", "reading_events", "sources"]);
    expect(columns(db, "items")).toContain("kept_at");
    db.close();
  });

  it("migrates a version-1 database in place, keeping its rows, and is idempotent", () => {
    const path = join(root, "quire.sqlite");
    const old = createV1Database(path);
    expect(version(old)).toBe(1);
    expect(columns(old, "items")).not.toContain("kept_at");
    old.prepare("INSERT INTO items (id, source_id, source_title, source_kind, external_id, title, gist, link, published_at, fetched_at, reading_minutes, signals, summary_only, state) VALUES ('i1', 's', 'S', 'feed', 'e', 'T', '', 'https://x.test', '2026-09-01T00:00:00.000Z', '2026-09-02T00:00:00.000Z', 1, '{}', 1, 'undecided')").run();
    old.close();

    const db = openDatabase(path);
    expect(version(db)).toBe(3);
    expect(columns(db, "items")).toContain("kept_at");
    expect(tables(db)).toContain("material_meta");
    expect(db.prepare("SELECT id, kept_at FROM items").all()).toEqual([{ id: "i1", kept_at: null }]);
    db.close();

    const again = openDatabase(path);
    expect(version(again)).toBe(3);
    expect(again.prepare("SELECT COUNT(*) AS n FROM items").get()).toEqual({ n: 1 });
    again.close();
  });

  it("refuses a database newer than this build", () => {
    const path = join(root, "future.sqlite");
    const db = openDatabase(path);
    db.exec("PRAGMA user_version = 99");
    db.close();
    expect(() => openDatabase(path)).toThrow(/schema version 99, newer than this build understands \(3\)/);
  });
});
