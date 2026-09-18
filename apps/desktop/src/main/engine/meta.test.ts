import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type Database } from "./db";
import { MetaStore, normalizeTags } from "./meta";

let db: Database;
beforeEach(() => { db = openDatabase(":memory:"); });
afterEach(() => { db.close(); });

const a = "aaaaaaaaaaaaaaaa";
const b = "bbbbbbbbbbbbbbbb";

describe("normalizeTags", () => {
  it("trims, drops empties, deduplicates case-insensitively keeping the first spelling, and caps length and count", () => {
    expect(normalizeTags(["  ML ", "ml", "", "  ", "Ml", "systems"])).toEqual(["ML", "systems"]);
    expect(normalizeTags(["x".repeat(50)])).toEqual(["x".repeat(40)]);
    expect(normalizeTags([`${"y".repeat(39)} z`])).toEqual(["y".repeat(39)]);
    expect(normalizeTags(Array.from({ length: 30 }, (_, i) => `t${i}`))).toHaveLength(20);
  });
});

describe("MetaStore", () => {
  it("merges patches field by field and clears a field with an empty value", () => {
    const meta = new MetaStore(db, () => new Date("2026-09-18T10:00:00Z"));
    expect(meta.get(a)).toBeUndefined();
    expect(meta.update(a, { title: " A better title ", tags: ["ml", "ML", "papers"] })).toEqual({ title: "A better title", tags: ["ml", "papers"] });
    expect(meta.update(a, { byline: "Someone", note: "why I kept it" })).toEqual({ title: "A better title", byline: "Someone", tags: ["ml", "papers"], note: "why I kept it" });
    expect(meta.update(a, { title: "", tags: [] })).toEqual({ byline: "Someone", note: "why I kept it" });
    expect(meta.get(a)).toEqual({ byline: "Someone", note: "why I kept it" });
    expect(meta.update(a, { byline: "", note: "   " })).toEqual({});
    expect(meta.get(a)).toBeUndefined();
    expect(db.prepare("SELECT COUNT(*) AS n FROM material_meta").get()).toEqual({ n: 0 });
  });

  it("stores the published date verbatim and lists every override at once", () => {
    const meta = new MetaStore(db);
    meta.update(a, { publishedAt: "2026-01-02T00:00:00.000Z" });
    meta.update(b, { tags: ["x"] });
    expect(meta.all()).toEqual(new Map([[a, { publishedAt: "2026-01-02T00:00:00.000Z" }], [b, { tags: ["x"] }]]));
  });

  it("counts tags across materials, most used first then alphabetical, and forgets removed materials", () => {
    const meta = new MetaStore(db);
    meta.update(a, { tags: ["Systems", "ml"] });
    meta.update(b, { tags: ["ml", "Agents"] });
    meta.update("cccccccccccccccc", { tags: ["agents"] });
    expect(meta.tags()).toEqual([{ tag: "ml", count: 2 }, { tag: "Agents", count: 1 }, { tag: "agents", count: 1 }, { tag: "Systems", count: 1 }]);
    meta.remove(b);
    expect(meta.get(b)).toBeUndefined();
    expect(meta.tags()).toEqual([{ tag: "agents", count: 1 }, { tag: "ml", count: 1 }, { tag: "Systems", count: 1 }]);
    meta.remove("never-stored");
  });
});
