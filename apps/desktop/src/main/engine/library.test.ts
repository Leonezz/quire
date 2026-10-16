import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MaterialSummary } from "../../shared/contracts";
import { AnnotationStore } from "./annotations";
import { openDatabase, type Database } from "./db";
import { ImageCache } from "./images";
import { ItemStore } from "./items";
import { deleteMaterials, queryLibrary } from "./library";
import { MaterialStore } from "./materials";
import { MetaStore } from "./meta";

const quality = { completeness: "declared_full" as const, conformance: "conformant" as const, identityConfidence: "strong" as const, safety: "safe" as const, warnings: [] };
function summary(overrides: Partial<MaterialSummary> & { id: string; title: string }): MaterialSummary {
  return { url: `https://x.test/${overrides.id}`, fetchedAt: "2026-09-10T00:00:00.000Z", readingMinutes: 1, origin: "web", mediaType: "text/html", quality, tags: [], kind: "webpage", readyViews: ["web"], ...overrides };
}

const web = summary({ id: "1", title: "Cache keys", byline: "Ada", fetchedAt: "2026-09-12T00:00:00.000Z", publishedAt: "2026-09-01T00:00:00.000Z", tags: ["Systems"] });
const pdf = summary({ id: "2", title: "attention is not all you need", mediaType: "application/pdf", kind: "preprint", fetchedAt: "2026-09-11T00:00:00.000Z", publishedAt: "2026-09-05T00:00:00.000Z", tags: ["ml"] });
const feed = summary({ id: "3", title: "Momentum, revisited", origin: "feed", kind: "blogPost", fetchedAt: "2026-09-13T00:00:00.000Z", tags: ["ml", "systems"] });
const artifact = summary({ id: "4", title: "Synthesis: caches", origin: "agent", mediaType: "text/markdown", kind: "note", fetchedAt: "2026-09-14T00:00:00.000Z", lineage: ["1"] });
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

  it("filters by bibliographic kind, alone or together with the coarse kind", () => {
    expect(queryLibrary(all, { materialKind: "preprint" }).map((m) => m.id)).toEqual(["2"]);
    expect(queryLibrary(all, { materialKind: "webpage" }).map((m) => m.id)).toEqual(["1"]);
    expect(queryLibrary(all, { kind: "articles", materialKind: "blogPost" }).map((m) => m.id)).toEqual(["3"]);
    expect(queryLibrary(all, { kind: "pdf", materialKind: "blogPost" })).toEqual([]);
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

    const result = await deleteMaterials([id, "0000000000000000"], { store, annotations, items, images: new ImageCache(root) });
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

  it("forgets the cached pictures only the deleted material showed, and keeps those another material still shows", async () => {
    const shared = "https://img.example.test/shared.png";
    const own = "https://img.example.test/own.png";
    const unrelated = "https://img.example.test/cached-before.png";
    const figure = (src: string) => `<figure><img src="${src}" alt="A chart" width="640" height="480"><figcaption>A chart.</figcaption></figure>`;
    const page = (title: string, pictures: string[]) => `<!doctype html><html><head><title>${title}</title></head><body><article><h1>${title}</h1>${"<p>Two harnesses cache the tokenised prompt keyed on the question text alone, so a changed system prompt silently reuses the old one.</p>".repeat(6)}${pictures.map(figure).join("")}${"<p>The fix is a cache key that includes the full rendered prompt hash, so nothing stale is ever served again.</p>".repeat(6)}</article></body></html>`;
    const pages: Record<string, string> = { "https://example.test/first": page("First", [shared, own]), "https://example.test/second": page("Second", [shared]) };
    const store = new MaterialStore(root, async (url) => ({ bytes: new TextEncoder().encode(pages[url.toString()]!), mediaType: "text/html", finalUrl: url.toString() }));
    const cached = (url: string) => createHash("sha256").update(url).digest("hex");
    await mkdir(join(root, "images"), { recursive: true });
    for (const url of [shared, own, unrelated]) {
      await writeFile(join(root, "images", `${cached(url)}.bin`), Buffer.from([137, 80, 78, 71]));
      await writeFile(join(root, "images", `${cached(url)}.json`), JSON.stringify({ mediaType: "image/png", url }));
    }
    const onDisk = async () => new Set((await readdir(join(root, "images"))).map((name) => name.replace(/\.(bin|json)$/, "")));
    const deps = { store, annotations: new AnnotationStore(root), items: new ItemStore(db), images: new ImageCache(root) };
    const first = await store.openUrl("https://example.test/first");
    const second = await store.openUrl("https://example.test/second");
    if (!first.ok || !second.ok) throw new Error("the pages did not open");
    expect([...(await store.imageReferences([first.material.id]))].sort()).toEqual([own, shared]);

    await deleteMaterials([first.material.id], deps);
    expect(await onDisk()).toEqual(new Set([cached(shared), cached(unrelated)]));

    await deleteMaterials([second.material.id], deps);
    // Only what the deleted materials showed is forgotten: an image cached before stays until something sweeps it.
    expect(await onDisk()).toEqual(new Set([cached(unrelated)]));
  });

  it.each([
    ["their own", "deleted"],
    ["the rest's", "remaining"],
  ])("deletes the materials and says their pictures were kept when %s pictures cannot be read", async (_whose, failing) => {
    const store = new MaterialStore(root, async (url) => ({ bytes: new TextEncoder().encode(`# Note\n\n![Chart](https://img.example.test/chart.png)\n`), mediaType: "text/markdown", finalUrl: url.toString() }));
    const opened = await store.openUrl("https://example.test/note.md");
    if (!opened.ok) throw new Error(opened.message);
    const refused = () => Promise.reject(new Error("EACCES: permission denied, open 'materials'"));
    const unreadable = {
      delete: (ids: readonly string[]) => store.delete(ids),
      imageReferences: (ids?: readonly string[]) => ((ids ? "deleted" : "remaining") === failing ? refused() : store.imageReferences(ids)),
    };
    const forget = vi.fn(async () => 0);
    const items = new ItemStore(db);
    items.upsert({ id: "src", title: "Notes", kind: "feed" }, [{ externalId: "x", title: "Note", link: "https://example.test/note.md", publishedAt: "2026-09-10T00:00:00.000Z", gist: "", readingMinutes: 1, signals: {}, summaryOnly: true }]);
    items.markOpened(items.inbox()[0]!.id, opened.material.id);
    // The delete went through, items included; only the pictures stayed, and the result says why.
    expect(await deleteMaterials([opened.material.id], { store: unreadable, annotations: new AnnotationStore(root), items, images: { forget } }))
      .toEqual({ deleted: 1, unlinkedItems: 1, picturesKept: "The materials were deleted, but their cached pictures were kept: EACCES: permission denied, open 'materials'" });
    expect(await store.get(opened.material.id)).toBeUndefined();
    expect(forget).not.toHaveBeenCalled();
  });

  it("refuses ids that are not material ids before touching anything", async () => {
    const store = new MaterialStore(root, async () => { throw new Error("no fetch"); });
    await expect(store.delete(["../etc/passwd"])).rejects.toThrow("Not a material id: ../etc/passwd");
  });
});
