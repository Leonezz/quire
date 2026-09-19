import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SCHEMA_VERSION, createV1Database, createV3Database, legacyOverridesOf, openDatabase, type Database } from "./db";
import { MetaStore } from "./meta";

let root = "";
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "read-db-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const version = (db: Database) => (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
const columns = (db: Database, table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
const tables = (db: Database) => (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((t) => t.name);

describe("openDatabase", () => {
  it("creates a fresh database at the current version with the M3 tables", () => {
    const db = openDatabase(":memory:");
    expect(SCHEMA_VERSION).toBe(4);
    expect(version(db)).toBe(4);
    expect(tables(db)).toEqual(["agent_sessions", "agent_turns", "items", "material_meta", "reading_events", "sources"]);
    expect(columns(db, "items")).toContain("kept_at");
    expect(columns(db, "items")).toContain("meta");
    expect(columns(db, "material_meta")).toEqual(["material_id", "overrides", "updated_at"]);
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
    expect(version(db)).toBe(4);
    expect(columns(db, "items")).toContain("kept_at");
    expect(columns(db, "items")).toContain("meta");
    expect(tables(db)).toContain("material_meta");
    expect(db.prepare("SELECT id, kept_at, meta FROM items").all()).toEqual([{ id: "i1", kept_at: null, meta: null }]);
    db.close();

    const again = openDatabase(path);
    expect(version(again)).toBe(4);
    expect(again.prepare("SELECT COUNT(*) AS n FROM items").get()).toEqual({ n: 1 });
    again.close();
  });

  it("migrates version-3 typed metadata columns into one overrides document per material", () => {
    const path = join(root, "v3.sqlite");
    const old = createV3Database(path);
    expect(version(old)).toBe(3);
    expect(columns(old, "material_meta")).toContain("byline");
    const insert = old.prepare("INSERT INTO material_meta (material_id, title, byline, published_at, tags, note, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
    insert.run("aaaaaaaaaaaaaaaa", "Cache keys, annotated", "Ada Lovelace, Charles Babbage and Alan Turing", "2026-09-01T00:00:00.000Z", '["systems","ml"]', "keep", "2026-09-10T00:00:00.000Z");
    insert.run("bbbbbbbbbbbbbbbb", null, null, null, "[]", null, "2026-09-10T00:00:00.000Z");
    insert.run("cccccccccccccccc", null, null, null, '["x"]', null, "2026-09-11T00:00:00.000Z");
    old.close();

    const db = openDatabase(path);
    expect(version(db)).toBe(4);
    expect(columns(db, "material_meta")).toEqual(["material_id", "overrides", "updated_at"]);
    const meta = new MetaStore(db);
    expect(meta.get("aaaaaaaaaaaaaaaa")).toEqual({
      title: "Cache keys, annotated",
      creators: [{ role: "author", name: "Ada Lovelace" }, { role: "author", name: "Charles Babbage" }, { role: "author", name: "Alan Turing" }],
      date: "2026-09-01T00:00:00.000Z", tags: ["systems", "ml"], note: "keep",
    });
    expect(meta.get("bbbbbbbbbbbbbbbb")).toBeUndefined();
    expect(meta.get("cccccccccccccccc")).toEqual({ tags: ["x"] });
    expect(db.prepare("SELECT updated_at FROM material_meta WHERE material_id = 'cccccccccccccccc'").get()).toEqual({ updated_at: "2026-09-11T00:00:00.000Z" });
    db.close();

    const again = openDatabase(path);
    expect(new MetaStore(again).get("cccccccccccccccc")).toEqual({ tags: ["x"] });
    again.close();
  });

  it("refuses a database newer than this build", () => {
    const path = join(root, "future.sqlite");
    const db = openDatabase(path);
    db.exec("PRAGMA user_version = 99");
    db.close();
    expect(() => openDatabase(path)).toThrow(/schema version 99, newer than this build understands \(4\)/);
  });
});

describe("legacyOverridesOf", () => {
  it("turns the typed columns into a document and leaves out what was empty", () => {
    expect(legacyOverridesOf({ title: null, byline: "  ", published_at: null, tags: "[]", note: null })).toEqual({});
    expect(legacyOverridesOf({ title: "T", byline: "Solo Author", published_at: "2026", tags: '["a"]', note: "n" })).toEqual({ title: "T", creators: [{ role: "author", name: "Solo Author" }], date: "2026", tags: ["a"], note: "n" });
  });
});
