import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MaterialStore, imageUrlsOf } from "./materials";

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
