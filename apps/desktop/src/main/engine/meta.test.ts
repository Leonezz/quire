import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type Database } from "./db";
import { MetaStore, MetaValidationError, mergeOverrides, normalizeTags, validateMetaPatch } from "./meta";

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

describe("validateMetaPatch", () => {
  it("accepts every field of the model, trims strings, keeps empties as clears and lowercases DOIs", () => {
    expect(validateMetaPatch({ kind: "journalArticle", title: " T ", creators: [{ role: "author", name: " Ada ", family: "Lovelace" }], doi: "10.1234/ABC", date: "2026-09", tags: ["x", "X"], related: ["0123456789abcdef", "0123456789abcdef"], abstract: "", volume: "" }))
      .toEqual({ kind: "journalArticle", title: "T", creators: [{ role: "author", name: "Ada", family: "Lovelace" }], doi: "10.1234/abc", date: "2026-09", tags: ["x"], related: ["0123456789abcdef"], abstract: "", volume: "" });
    expect(validateMetaPatch({ kind: "", date: "", doi: "", arxivId: "2409.12345v2", isbn: "978-0-306-40615-7", issn: "1234-567X", accessed: "2026-09-18T12:00:00.000Z" }))
      .toEqual({ kind: "", date: "", doi: "", arxivId: "2409.12345v2", isbn: "978-0-306-40615-7", issn: "1234-567X", accessed: "2026-09-18T12:00:00.000Z" });
  });

  it("refuses unknown fields, wrong kinds and roles, malformed dates and identifiers, and oversized values", () => {
    const refuse = (patch: unknown, message: RegExp) => expect(() => validateMetaPatch(patch)).toThrow(message);
    refuse({ byline: "x" }, /unknown field\(s\): byline/);
    refuse({ kind: "poem" }, /kind must be one of/);
    refuse({ creators: [{ role: "singer", name: "x" }] }, /creators\[0\]\.role/);
    refuse({ creators: [{ role: "author", name: "  " }] }, /name must not be empty/);
    refuse({ creators: [{ role: "author", name: "x", orcid: "1" }] }, /unknown field\(s\): orcid/);
    refuse({ creators: Array.from({ length: 51 }, () => ({ role: "author", name: "x" })) }, /more than 50/);
    refuse({ date: "12/05/2024" }, /date must be YYYY/);
    refuse({ date: "2024-5" }, /date must be YYYY/);
    refuse({ doi: "abc" }, /doi does not look like a doi/);
    refuse({ arxivId: "https://arxiv.org/abs/1" }, /arxivId does not look like/);
    refuse({ related: ["nope"] }, /not a material id/);
    refuse({ title: "x".repeat(2001) }, /longer than 2000/);
    refuse({ note: "x".repeat(20_001) }, /longer than 20000/);
    refuse({ tags: "x" }, /tags must be an array/);
    refuse([], /must be an object/);
    expect(() => validateMetaPatch({ kind: 1 })).toThrow(MetaValidationError);
  });
});

describe("mergeOverrides", () => {
  it("replaces present values, removes cleared ones and leaves the rest", () => {
    expect(mergeOverrides({ title: "A", tags: ["x"], date: "2026" }, { title: "", tags: ["y", "z"], creators: [{ role: "author", name: "N" }], date: undefined }))
      .toEqual({ tags: ["y", "z"], creators: [{ role: "author", name: "N" }], date: "2026" });
  });
});

describe("MetaStore", () => {
  it("merges patches field by field, clears a field with an empty value and drops the empty row", async () => {
    const meta = new MetaStore(db, { now: () => new Date("2026-09-18T10:00:00Z") });
    expect(meta.get(a)).toBeUndefined();
    expect(await meta.update(a, { title: " A better title ", tags: ["ml", "ML", "papers"] })).toEqual({ title: "A better title", tags: ["ml", "papers"] });
    expect(await meta.update(a, { creators: [{ role: "author", name: "Someone" }], note: "why I kept it" })).toEqual({ title: "A better title", creators: [{ role: "author", name: "Someone" }], tags: ["ml", "papers"], note: "why I kept it" });
    expect(await meta.update(a, { title: "", tags: [] })).toEqual({ creators: [{ role: "author", name: "Someone" }], note: "why I kept it" });
    expect(meta.get(a)).toEqual({ creators: [{ role: "author", name: "Someone" }], note: "why I kept it" });
    expect(await meta.update(a, { creators: [], note: "   " })).toEqual({});
    expect(meta.get(a)).toBeUndefined();
    expect(db.prepare("SELECT COUNT(*) AS n FROM material_meta").get()).toEqual({ n: 0 });
  });

  it("stores the date verbatim and lists every override at once", async () => {
    const meta = new MetaStore(db);
    await meta.update(a, { date: "2026-01-02T00:00:00.000Z", kind: "preprint" });
    await meta.update(b, { tags: ["x"] });
    expect(meta.all()).toEqual(new Map([[a, { date: "2026-01-02T00:00:00.000Z", kind: "preprint" }], [b, { tags: ["x"] }]]));
  });

  it("checks related ids against the library and refuses self-relations", async () => {
    const meta = new MetaStore(db, { materialExists: async (id) => id === b });
    expect(await meta.update(a, { related: [b] })).toEqual({ related: [b] });
    await expect(meta.update(a, { related: ["cccccccccccccccc"] })).rejects.toThrow(/not in the library: cccccccccccccccc/);
    await expect(meta.update(a, { related: [a] })).rejects.toThrow(/cannot relate to itself/);
    expect(meta.get(a)).toEqual({ related: [b] });
    await expect(new MetaStore(db).update(a, { related: [b] })).rejects.toThrow(/cannot be checked/);
    expect(await meta.update(a, { related: [] })).toEqual({});
  });

  it("rejects an invalid patch before touching the row", async () => {
    const meta = new MetaStore(db);
    await meta.update(a, { title: "keep" });
    await expect(meta.update(a, { kind: "poem" as never })).rejects.toThrow(MetaValidationError);
    expect(meta.get(a)).toEqual({ title: "keep" });
  });

  it("counts tags across materials, most used first then alphabetical, and forgets removed materials", async () => {
    const meta = new MetaStore(db);
    await meta.update(a, { tags: ["Systems", "ml"] });
    await meta.update(b, { tags: ["ml", "Agents"] });
    await meta.update("cccccccccccccccc", { tags: ["agents"] });
    expect(meta.tags()).toEqual([{ tag: "ml", count: 2 }, { tag: "Agents", count: 1 }, { tag: "agents", count: 1 }, { tag: "Systems", count: 1 }]);
    meta.remove(b);
    expect(meta.get(b)).toBeUndefined();
    expect(meta.tags()).toEqual([{ tag: "agents", count: 1 }, { tag: "ml", count: 1 }, { tag: "Systems", count: 1 }]);
    meta.remove("never-stored");
  });
});
