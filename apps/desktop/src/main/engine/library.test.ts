import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MaterialSummary } from "../../shared/contracts";
import { AnnotationStore } from "./annotations";
import { openDatabase, type Database } from "./db";
import { ItemStore } from "./items";
import { deleteMaterials, queryLibrary } from "./library";
import { MaterialStore } from "./materials";
import { MetaStore } from "./meta";

const quality = { completeness: "declared_full" as const, conformance: "conformant" as const, identityConfidence: "strong" as const, safety: "safe" as const, warnings: [] };
function summary(overrides: Partial<MaterialSummary> & { id: string; title: string }): MaterialSummary {
  return { url: `https://x.test/${overrides.id}`, fetchedAt: "2026-09-10T00:00:00.000Z", readingMinutes: 1, origin: "web", mediaType: "text/html", quality, tags: [], ...overrides };
}

const web = summary({ id: "1", title: "Cache keys", byline: "Ada", fetchedAt: "2026-09-12T00:00:00.000Z", publishedAt: "2026-09-01T00:00:00.000Z", tags: ["Systems"] });
const pdf = summary({ id: "2", title: "attention is not all you need", mediaType: "application/pdf", fetchedAt: "2026-09-11T00:00:00.000Z", publishedAt: "2026-09-05T00:00:00.000Z", tags: ["ml"] });
const feed = summary({ id: "3", title: "Momentum, revisited", origin: "feed", fetchedAt: "2026-09-13T00:00:00.000Z", tags: ["ml", "systems"] });
const artifact = summary({ id: "4", title: "Synthesis: caches", origin: "agent", mediaType: "text/markdown", fetchedAt: "2026-09-14T00:00:00.000Z", lineage: ["1"] });
const all = [web, pdf, feed, artifact];

describe("queryLibrary", () => {
  it("sorts by fetched date, newest first, when no filter is given", () => {
    expect(queryLibrary(all, {}).map((m) => m.id)).toEqual(["4", "3", "1", "2"]);
    expect(queryLibrary(all, { kind: "all", sort: "fetched" }).map((m) => m.id)).toEqual(["4", "3", "1", "2"]);
  });

  it("filters by kind: articles are text materials that are not artifacts", () => {
    expect(queryLibrary(all, { kind: "articles" }).map((m) => m.id)).toEqual(["3", "1"]);
    expect(queryLibrary(all, { kind: "pdf" }).map((m) => m.id)).toEqual(["2"]);
    expect(queryLibrary(all, { kind: "artifact" }).map((m) => m.id)).toEqual(["4"]);
    expect(queryLibrary(all, { kind: "feed" }).map((m) => m.id)).toEqual(["3"]);
  });

  it("filters by tag case-insensitively and by every word of the query over title, byline and tags", () => {
    expect(queryLibrary(all, { tag: "systems" }).map((m) => m.id)).toEqual(["3", "1"]);
    expect(queryLibrary(all, { tag: "ML" }).map((m) => m.id)).toEqual(["3", "2"]);
    expect(queryLibrary(all, { query: "cache" }).map((m) => m.id)).toEqual(["4", "1"]);
    expect(queryLibrary(all, { query: "cache ada" }).map((m) => m.id)).toEqual(["1"]);
    expect(queryLibrary(all, { query: "ML momentum" }).map((m) => m.id)).toEqual(["3"]);
    expect(queryLibrary(all, { query: "   " }).map((m) => m.id)).toEqual(["4", "3", "1", "2"]);
    expect(queryLibrary(all, { kind: "pdf", tag: "systems" })).toEqual([]);
  });

  it("sorts by published date with undated materials last, and by title ignoring case", () => {
    expect(queryLibrary(all, { sort: "published" }).map((m) => m.id)).toEqual(["2", "1", "4", "3"]);
    expect(queryLibrary(all, { sort: "title" }).map((m) => m.title)).toEqual(["attention is not all you need", "Cache keys", "Momentum, revisited", "Synthesis: caches"]);
  });

  it("does not mutate its input", () => {
    const input = [...all];
    queryLibrary(input, { sort: "title" });
    expect(input.map((m) => m.id)).toEqual(["1", "2", "3", "4"]);
  });
});

describe("deleteMaterials", () => {
  let root = "";
  let db: Database;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "read-library-")); db = openDatabase(":memory:"); });
  afterEach(async () => { db.close(); await rm(root, { recursive: true, force: true }); });

  it("removes the record and its bytes, annotations and overrides, and unlinks the items that were read as it", async () => {
    const meta = new MetaStore(db);
    const html = `<!doctype html><html><head><title>Cache keys</title></head><body><article><h1>Cache keys</h1>${"<p>Two harnesses cache the tokenised prompt keyed on the question text alone, so a changed system prompt silently reuses the old one.</p>".repeat(12)}</article></body></html>`;
    const store = new MaterialStore(root, async (url) => ({ bytes: new TextEncoder().encode(html), mediaType: "text/html", finalUrl: url.toString() }), { meta });
    const annotations = new AnnotationStore(root);
    const items = new ItemStore(db);
    const opened = await store.openUrl("https://example.test/cache");
    if (!opened.ok) throw new Error(opened.message);
    const id = opened.material.id;
    await annotations.save({ id: "a1a1a1a1a1a1a1a1", materialId: id, locator: "loc", quote: "q", kind: "highlight", color: "#ffd400", createdAt: "", updatedAt: "" });
    meta.update(id, { tags: ["keep"] });
    items.upsert({ id: "src", title: "Notes", kind: "feed" }, [{ externalId: "x", title: "Cache keys", link: "https://example.test/cache", publishedAt: "2026-09-10T00:00:00.000Z", gist: "", readingMinutes: 1, signals: {}, summaryOnly: true }]);
    const item = items.inbox()[0]!;
    items.markOpened(item.id, id);
    expect((await stat(join(root, "materials", `${id}.html`))).isFile()).toBe(true);

    const result = await deleteMaterials([id, "0000000000000000"], { store, annotations, items });
    expect(result).toEqual({ deleted: 1, unlinkedItems: 1 });
    expect(await store.get(id)).toBeUndefined();
    expect(await store.list()).toEqual([]);
    expect(await store.captureText(id)).toBeUndefined();
    await expect(stat(join(root, "materials", `${id}.html`))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await annotations.list(id)).toEqual([]);
    expect(meta.get(id)).toBeUndefined();
    const after = items.get(item.id)!;
    expect(after.materialId).toBeUndefined();
    expect(after.openedAt).toBeDefined();
    expect(items.inbox()).toEqual([]);
  });

  it("refuses ids that are not material ids before touching anything", async () => {
    const store = new MaterialStore(root, async () => { throw new Error("no fetch"); });
    await expect(store.delete(["../etc/passwd"])).rejects.toThrow("Not a material id: ../etc/passwd");
  });
});
