import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "./db";
import { MaterialStore, withoutTitleHeading, imageUrlsOf } from "./materials";
import { MetaStore } from "./meta";

let root = "";
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "read-materials-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("MaterialStore", () => {
  it("reads a dropped Markdown file into a reader document and lists it", async () => {
    const store = new MaterialStore(root);
    const md = "# Momentum, revisited\n\nA paragraph with **emphasis** and `code`.\n\n## Why it is stable\n\nBecause.\n";
    const result = await store.openFile({ name: "momentum.md", mediaType: "", bytes: new TextEncoder().encode(md) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.material.title).toBe("Momentum, revisited");
    expect(result.material.origin).toBe("file");
    expect(result.material.reader?.schema).toBe("reader.document.v2");
    expect(JSON.parse(result.material.reader!.payload).type).toBe("root");
    expect(result.material.readingMinutes).toBe(1);
    const listed = await store.list();
    expect(listed.map((item) => item.title)).toEqual(["Momentum, revisited"]);
    expect(await store.get(result.material.id)).toMatchObject({ title: "Momentum, revisited" });
  });

  it("reads a dropped HTML file through the article extractor", async () => {
    const store = new MaterialStore(root);
    const html = `<!doctype html><html><head><title>Cache keys</title></head><body><article><h1>Cache keys</h1>${"<p>Two harnesses cache the tokenised prompt keyed on the question text alone, so a changed system prompt silently reuses the old one. The fix is a cache key that includes the full rendered prompt hash.</p>".repeat(12)}</article></body></html>`;
    const result = await store.openFile({ name: "cache.html", mediaType: "text/html", bytes: new TextEncoder().encode(html) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.material.title).toBe("Cache keys");
    expect(result.material.reader).toBeDefined();
    expect(result.material.quality.safety).toBe("safe");
  });

  it("refuses unsupported file types with a clear code", async () => {
    const store = new MaterialStore(root);
    const result = await store.openFile({ name: "photo.png", mediaType: "image/png", bytes: new Uint8Array([137, 80, 78, 71]) });
    expect(result).toMatchObject({ ok: false, code: "UNSUPPORTED_TYPE" });
  });

  it("refuses private and non-http URLs before fetching", async () => {
    const store = new MaterialStore(root);
    expect(await store.openUrl("http://localhost:3000/x")).toMatchObject({ ok: false, code: "URL_PRIVATE" });
    expect(await store.openUrl("http://10.0.0.8/x")).toMatchObject({ ok: false, code: "URL_PRIVATE" });
    expect(await store.openUrl("ftp://example.com/x")).toMatchObject({ ok: false, code: "URL_SCHEME" });
    expect(await store.openUrl("https://user:pw@example.com/x")).toMatchObject({ ok: false, code: "URL_CREDENTIALS" });
    expect(await store.openUrl("not a url")).toMatchObject({ ok: false, code: "URL_INVALID" });
    expect(await store.list()).toEqual([]);
  });
});

const article = (title: string) => `<!doctype html><html><head><title>${title}</title></head><body><nav>Home</nav><article><h1>${title}</h1>${"<p>Two harnesses cache the tokenised prompt keyed on the question text alone, so a changed system prompt silently reuses the old one. The fix is a cache key that includes the full rendered prompt hash.</p>".repeat(12)}</article></body></html>`;
const pageFetcher = (title: string) => async (url: URL) => ({ bytes: new TextEncoder().encode(article(title)), mediaType: "text/html", finalUrl: url.toString() });

describe("MaterialStore capture", () => {
  it("keeps the raw page next to the record when the setting is on and renders it as structured text", async () => {
    const store = new MaterialStore(root, pageFetcher("Cache keys"), { keepCapture: () => true });
    const result = await store.openUrl("https://example.test/cache");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { id } = result.material;
    expect(result.material.capture).toEqual({ byteLength: new TextEncoder().encode(article("Cache keys")).byteLength, mediaType: "text/html" });
    expect((await stat(join(root, "materials", `${id}.html`))).size).toBe(result.material.capture!.byteLength);
    const text = await store.captureText(id);
    expect(text).toMatch(/^Home\n\n# Cache keys\n\nTwo harnesses cache/);
    expect(await store.captureText("0000000000000000")).toBeUndefined();
    expect(await store.captureText("../x")).toBeUndefined();
  });

  it("writes no capture when the setting is off, and drops a stale one on re-fetch", async () => {
    let keep = true;
    const store = new MaterialStore(root, pageFetcher("Cache keys"), { keepCapture: () => keep });
    const first = await store.openUrl("https://example.test/cache");
    if (!first.ok) throw new Error(first.message);
    keep = false;
    const second = await store.openUrl("https://example.test/cache");
    if (!second.ok) throw new Error(second.message);
    expect(second.material.capture).toBeUndefined();
    expect(await store.captureText(second.material.id)).toBeUndefined();
    const markdown = await store.openFile({ name: "notes.md", mediaType: "", bytes: new TextEncoder().encode("# Notes\n\nText.") });
    expect(markdown.ok && markdown.material.capture).toBeUndefined();
  });
});

describe("MaterialStore overrides", () => {
  it("lays the metadata over the record and the list, with tags and rebuiltAs", async () => {
    const db = openDatabase(":memory:");
    const meta = new MetaStore(db);
    const store = new MaterialStore(root, pageFetcher("Cache keys"), { meta });
    const opened = await store.openUrl("https://example.test/cache");
    if (!opened.ok) throw new Error(opened.message);
    const { id } = opened.material;
    expect(opened.material.tags).toEqual([]);
    expect(opened.material).not.toHaveProperty("overrides");
    expect(opened.material).toMatchObject({ kind: "webpage", extracted: { kind: "webpage", title: "Cache keys", url: "https://example.test/cache" }, meta: { kind: "webpage", title: "Cache keys" } });
    const overrides = { title: "Cache keys, annotated", creators: [{ role: "author" as const, name: "Ada" }], date: "2026-09-01T00:00:00.000Z", tags: ["systems"], note: "keep", kind: "blogPost" as const };
    await meta.update(id, overrides);
    const record = (await store.get(id))!;
    expect(record).toMatchObject({ title: "Cache keys, annotated", byline: "Ada", publishedAt: "2026-09-01T00:00:00.000Z", tags: ["systems"], kind: "blogPost", overrides, meta: { ...overrides, url: "https://example.test/cache" } });
    expect(record.extracted).toMatchObject({ kind: "webpage", title: "Cache keys" });
    expect(JSON.parse(await readFile(join(root, "materials", `${id}.json`), "utf8"))).toMatchObject({ title: "Cache keys", extracted: { kind: "webpage", title: "Cache keys" } });
    expect((await store.list())[0]).toMatchObject({ id, title: "Cache keys, annotated", byline: "Ada", tags: ["systems"], kind: "blogPost" });
    expect((await store.list())[0]).not.toHaveProperty("rebuiltAs");
    // A partial date is kept on meta.date but yields no publishedAt; clearing the title falls back to the extracted one.
    await meta.update(id, { date: "2026-09", title: "" });
    expect(await store.get(id)).toMatchObject({ title: "Cache keys", meta: { date: "2026-09" } });
    expect(await store.get(id)).not.toHaveProperty("publishedAt");

    const artifact = await store.saveArtifact({ title: "Cache keys (rebuilt)", markdown: "# Cache keys\n\nClean.", lineage: [id] });
    expect(artifact.tags).toEqual([]);
    expect((await store.setRebuiltAs(id, artifact.id)).rebuiltAs).toBe(artifact.id);
    expect((await store.list()).find((m) => m.id === id)?.rebuiltAs).toBe(artifact.id);
    expect((await store.get(id))?.title).toBe("Cache keys");
    await expect(store.setRebuiltAs(id, "0000000000000000")).rejects.toThrow(/Artifact 0000000000000000 is not in the library/);
    await expect(store.setRebuiltAs(id, id)).rejects.toThrow(/is not in the library/);
    await expect(store.setRebuiltAs("0000000000000000", artifact.id)).rejects.toThrow(/Material 0000000000000000 is not in the library/);

    await store.delete([id]);
    expect(meta.get(id)).toBeUndefined();
    expect((await store.list()).map((m) => m.id)).toEqual([artifact.id]);
    db.close();
  });
});

const taggedArticle = `<!doctype html><html lang="en"><head><title>Calibrated abstention</title>
<meta name="citation_title" content="Calibrated Abstention for Long-Context QA"><meta name="citation_author" content="Lindqvist, Mara"><meta name="citation_author" content="Nowak, Tomasz">
<meta name="citation_journal_title" content="Journal of Retrieval"><meta name="citation_publication_date" content="2026/05/12"><meta name="citation_doi" content="10.1234/jr.2026.0042"></head>
<body><article><h1>Calibrated abstention</h1>${"<p>Two harnesses cache the tokenised prompt keyed on the question text alone, so a changed system prompt silently reuses the old one. The fix is a cache key that includes the full rendered prompt hash.</p>".repeat(12)}</article></body></html>`;

describe("MaterialStore metadata", () => {
  it("extracts the declared metadata of a page into the record, derives byline and publishedAt, and searches the new fields", async () => {
    const store = new MaterialStore(root, async (url) => ({ bytes: new TextEncoder().encode(taggedArticle), mediaType: "text/html", finalUrl: url.toString() }));
    const opened = await store.openUrl("https://journal.example.test/articles/42");
    if (!opened.ok) throw new Error(opened.message);
    expect(opened.material).toMatchObject({
      kind: "journalArticle", title: "Calibrated Abstention for Long-Context QA", byline: "Mara Lindqvist, Tomasz Nowak", publishedAt: "2026-05-12T00:00:00.000Z",
      meta: { kind: "journalArticle", publication: "Journal of Retrieval", doi: "10.1234/jr.2026.0042", date: "2026-05-12", accessed: opened.material.fetchedAt, creators: [{ family: "Lindqvist" }, { family: "Nowak" }] },
    });
    expect((await store.list())[0]).toMatchObject({ kind: "journalArticle", byline: "Mara Lindqvist, Tomasz Nowak", publishedAt: "2026-05-12T00:00:00.000Z" });
    expect((await store.search("nowak retrieval")).map((m) => m.id)).toEqual([opened.material.id]);
    expect((await store.search("10.1234/jr.2026.0042")).map((m) => m.id)).toEqual([opened.material.id]);
    expect(await store.search("nowak nothing")).toEqual([]);
  });

  it("derives the extracted layer of a record saved before the model at read time, and refreshMetadata persists a real one from the capture", async () => {
    const store = new MaterialStore(root, async (url) => ({ bytes: new TextEncoder().encode(taggedArticle), mediaType: "text/html", finalUrl: url.toString() }));
    const opened = await store.openUrl("https://journal.example.test/articles/42");
    if (!opened.ok) throw new Error(opened.message);
    const { id } = opened.material;
    const path = join(root, "materials", `${id}.json`);
    const stored = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    const { extracted: _extracted, ...legacy } = stored;
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, JSON.stringify({ ...legacy, title: "Calibrated abstention", byline: "Mara Lindqvist and Tomasz Nowak", publishedAt: "2026-05-12T00:00:00.000Z" }));
    const derived = (await store.get(id))!;
    expect(derived).toMatchObject({ kind: "webpage", title: "Calibrated abstention", byline: "Mara Lindqvist, Tomasz Nowak", publishedAt: "2026-05-12T00:00:00.000Z", extracted: { kind: "webpage", creators: [{ name: "Mara Lindqvist" }, { name: "Tomasz Nowak" }] } });
    expect(derived.meta.doi).toBeUndefined();
    const refreshed = await store.refreshMetadata(id);
    expect(refreshed).toMatchObject({ kind: "journalArticle", title: "Calibrated Abstention for Long-Context QA", meta: { doi: "10.1234/jr.2026.0042" } });
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ extracted: { kind: "journalArticle", doi: "10.1234/jr.2026.0042" } });
    await expect(store.refreshMetadata("0000000000000000")).rejects.toThrow(/is not in the library/);
  });

  it("merges the item's metadata under the page's when a subscription item is read", async () => {
    const store = new MaterialStore(root, pageFetcher("Retrieval Without Regret"));
    const item = { kind: "preprint" as const, arxivId: "2409.12345", publication: "arXiv", creators: [{ role: "author" as const, name: "Mara Lindqvist" }], abstract: "From the Atom feed.", extra: "arXiv: 2409.12345 [cs.CL]", date: "2026-09-17T17:59:12.000Z" };
    const opened = await store.openUrl("https://arxiv.org/html/2409.12345v1", "feed", item);
    if (!opened.ok) throw new Error(opened.message);
    expect(opened.material).toMatchObject({ kind: "preprint", title: "Retrieval Without Regret", byline: "Mara Lindqvist", publishedAt: "2026-09-17T17:59:12.000Z", meta: { arxivId: "2409.12345", publication: "arXiv", abstract: "From the Atom feed.", extra: "arXiv: 2409.12345 [cs.CL]" } });
    expect(JSON.parse(await readFile(join(root, "materials", `${opened.material.id}.json`), "utf8"))).toMatchObject({ itemMeta: item });
    expect((await store.refreshMetadata(opened.material.id)).meta.abstract).toBe("From the Atom feed.");
    expect(await store.exportBibtex([opened.material.id])).toMatch(/^@misc\{lindqvist2026retrieval,\n {2}author = \{Mara Lindqvist\},\n {2}title = \{\{Retrieval Without Regret\}\},\n {2}eprint = \{2409\.12345\},\n {2}archivePrefix = \{arXiv\},\n {2}primaryClass = \{cs\.CL\}/);
  });

  it("exports BibTeX in the order given, skipping unknown ids, and refuses when none resolves", async () => {
    const store = new MaterialStore(root, async (url) => ({ bytes: new TextEncoder().encode(taggedArticle), mediaType: "text/html", finalUrl: url.toString() }));
    const first = await store.openUrl("https://journal.example.test/articles/42");
    const second = await store.openFile({ name: "notes.md", mediaType: "", bytes: new TextEncoder().encode("# Notes\n\nText.") });
    if (!first.ok || !second.ok) throw new Error("setup");
    const out = await store.exportBibtex([second.material.id, "0000000000000000", first.material.id]);
    expect(out.split("\n\n").map((entry) => entry.split("\n")[0])).toEqual([`@misc{notes,`, "@article{lindqvist2026calibrated,"]);
    await expect(store.exportBibtex(["0000000000000000"])).rejects.toThrow(/None of these materials is in the library: 0000000000000000/);
    expect(await store.has(first.material.id)).toBe(true);
    expect(await store.has("0000000000000000")).toBe(false);
    expect(await store.has("../x")).toBe(false);
  });
});

describe("MaterialStore PDFs", () => {
  it("stores a dropped PDF next to its record and serves the bytes back", async () => {
    const store = new MaterialStore(root);
    const bytes = new Uint8Array(await readFile(join(__dirname, "__fixtures__", "two-pages.pdf")));
    const result = await store.openFile({ name: "paper.pdf", mediaType: "", bytes });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.material.mediaType).toBe("application/pdf");
    expect(result.material.title).toBe("Attention is not all you need");
    expect(result.material.byline).toBe("A. Researcher");
    expect(result.material.pdf).toEqual({ pages: 2, byteLength: bytes.byteLength, textLayer: "available" });
    expect(result.material.plain).toContain("Second page");
    expect(result.material.reader).toBeUndefined();
    const stored = await store.bytes(result.material.id);
    expect(stored?.byteLength).toBe(bytes.byteLength);
    expect(await store.bytes("0000000000000000")).toBeUndefined();
    expect((await store.list())[0]?.title).toBe("Attention is not all you need");
  });

  it("names a PDF without an Info title after its file and reports a missing text layer", async () => {
    const store = new MaterialStore(root);
    const source = new TextDecoder("latin1").decode(await readFile(join(__dirname, "__fixtures__", "two-pages.pdf")));
    // Blank the Info title and the page text so pdf.js sees an untitled, image-only document. Byte lengths are unchanged, so the xref stays valid.
    const untitled = source.replace("/Title (Attention is not all you need)", "/Title (                             )").replace(/\(([^)]*)\) Tj/g, (m) => `(${" ".repeat(m.length - 5)}) Tj`);
    const bytes = Uint8Array.from(untitled, (c) => c.charCodeAt(0));
    const result = await store.openFile({ name: "scan-2024.pdf", mediaType: "application/pdf", bytes });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.material.title).toBe("scan-2024");
    expect(result.material.pdf?.textLayer).toBe("absent");
  });

  it("rejects bytes that only claim to be a PDF", async () => {
    const store = new MaterialStore(root);
    const result = await store.openFile({ name: "broken.pdf", mediaType: "application/pdf", bytes: new TextEncoder().encode("%PDF-1.7 nothing here") });
    expect(result).toMatchObject({ ok: false, code: "PDF_INVALID" });
  });
});

describe("MaterialStore corpus import", () => {
  it("imports gzipped snapshots once and reports per-slug failures", async () => {
    const { gzipSync } = await import("node:zlib");
    const { mkdir, writeFile } = await import("node:fs/promises");
    const corpus = join(root, "corpus");
    const html = `<!doctype html><html><head><title>Cache keys</title></head><body><article><h1>Cache keys</h1>${"<p>Two harnesses cache the tokenised prompt keyed on the question text alone, so a changed system prompt silently reuses the old one.</p>".repeat(12)}</article></body></html>`;
    await mkdir(join(corpus, "good"), { recursive: true });
    await writeFile(join(corpus, "good", "page.html.gz"), gzipSync(Buffer.from(html)));
    await writeFile(join(corpus, "good", "meta.json"), JSON.stringify({ url: "https://example.test/cache", finalUrl: "https://example.test/cache", fetchedAt: "2026-09-17T00:00:00.000Z" }));
    await mkdir(join(corpus, "broken"), { recursive: true });
    await writeFile(join(corpus, "broken", "meta.json"), "{ not json");
    const store = new MaterialStore(root);
    const first = await store.importSnapshots(corpus);
    expect(first).toMatchObject({ imported: 1, skipped: 0 });
    expect(first.failed.map((f) => f.slug)).toEqual(["broken"]);
    expect((await store.list()).map((m) => m.title)).toEqual(["Cache keys"]);
    expect((await store.list())[0]?.fetchedAt).toBe("2026-09-17T00:00:00.000Z");
    const second = await store.importSnapshots(corpus);
    expect(second).toMatchObject({ imported: 0, skipped: 1 });
  });
});

describe("imageUrlsOf", () => {
  it("lists reader image sources in order, once each, http(s) only", () => {
    const payload = JSON.stringify({ type: "root", children: [
      { type: "paragraph", children: [{ type: "image", url: "https://x.test/a.png", alt: "" }, { type: "image", url: "https://x.test/a.png", alt: "" }] },
      { type: "figure", media: [{ type: "image", url: "https://x.test/b.png", alt: "" }], caption: [], credit: [] },
      { type: "paragraph", children: [{ type: "image", url: "data:image/png;base64,AAAA", alt: "" }] },
    ] });
    expect(imageUrlsOf({ reader: { schema: "reader.document.v2", payload } })).toEqual(["https://x.test/a.png", "https://x.test/b.png"]);
    expect(imageUrlsOf({})).toEqual([]);
  });
});

describe("MaterialStore.search", () => {
  it("matches every word across title, byline and body", async () => {
    const dir = await mkdtemp(join(tmpdir(), "quire-search-"));
    const store = new MaterialStore(dir);
    const result = await store.openFile({ name: "notes.md", mediaType: "text/markdown", bytes: new TextEncoder().encode("# Cache keys\n\nThe prompt template leaks the test set.") });
    expect(result.ok).toBe(true);
    expect((await store.search("prompt leaks")).map((m) => m.title)).toEqual(["Cache keys"]);
    expect((await store.search("cache nothing")).length).toBe(0);
    expect(await store.search("   ")).toEqual([]);
  });
});

describe("withoutTitleHeading", () => {
  it("drops a leading H1 that repeats the title and keeps any other", () => {
    expect(withoutTitleHeading("# A  Title\n\nBody", "a title")).toBe("Body");
    expect(withoutTitleHeading("# Other\n\nBody", "A title")).toBe("# Other\n\nBody");
    expect(withoutTitleHeading("Body", "A title")).toBe("Body");
  });
});
