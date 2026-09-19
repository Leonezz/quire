import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FetchError, type FetchedPage, type Fetcher } from "./fetch";
import { MaterialStore } from "./materials";

let root = "";
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "read-views-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const article = (title: string) => `<!doctype html><html><head><title>${title}</title></head><body><article><h1>${title}</h1>${"<p>Two harnesses cache the tokenised prompt keyed on the question text alone, so a changed system prompt silently reuses the old one. The fix is a cache key that includes the full rendered prompt hash.</p>".repeat(12)}</article></body></html>`;
const pdfFixture = () => readFile(join(__dirname, "__fixtures__", "two-pages.pdf")).then((buffer) => new Uint8Array(buffer));

/** HTML under /html/, the fixture PDF under /pdf/; `pdfAnswer` overrides what the PDF URL does. */
function fetcherOf(pdf: Uint8Array, pdfAnswer?: (url: URL) => Promise<FetchedPage>): Fetcher & { calls: string[] } {
  const calls: string[] = [];
  return Object.assign(async (url: URL) => {
    calls.push(url.toString());
    if (url.pathname.startsWith("/pdf/")) return pdfAnswer ? pdfAnswer(url) : { bytes: pdf, mediaType: "application/pdf", finalUrl: url.toString() };
    return { bytes: new TextEncoder().encode(article("Retrieval Without Regret")), mediaType: "text/html", finalUrl: url.toString() };
  }, { calls });
}

const exists = (path: string) => stat(path).then(() => true, () => false);
const materialsDir = () => join(root, "materials");

/** A page opened as the primary web view with the PDF listed as available, as the arXiv flow leaves it. */
async function openWithPdfView(store: MaterialStore) {
  const opened = await store.openUrl("https://arxiv.org/html/2409.12345");
  if (!opened.ok) throw new Error(opened.message);
  return store.registerView(opened.material.id, { id: "pdf", label: "PDF", url: "https://arxiv.org/pdf/2409.12345", mediaType: "application/pdf", status: "available" });
}

describe("legacy records", () => {
  it("derives one ready view from the media type for records written before views existed", async () => {
    const store = new MaterialStore(root);
    await mkdir(materialsDir(), { recursive: true });
    const base = { url: "https://example.test/post", finalUrl: "https://example.test/post", title: "Old", fetchedAt: "2026-09-01T00:00:00.000Z", origin: "web", readingMinutes: 3, quality: { completeness: "declared_full", conformance: "conformant", identityConfidence: "strong", safety: "safe", warnings: [] }, problems: [] };
    await writeFile(join(materialsDir(), "aaaaaaaaaaaaaaaa.json"), JSON.stringify({ ...base, id: "aaaaaaaaaaaaaaaa", mediaType: "text/html", markdown: "Body", capture: { byteLength: 120, mediaType: "text/html" } }));
    await writeFile(join(materialsDir(), "bbbbbbbbbbbbbbbb.json"), JSON.stringify({ ...base, id: "bbbbbbbbbbbbbbbb", mediaType: "application/pdf", pdf: { pages: 4, byteLength: 900, textLayer: "available" } }));
    await writeFile(join(materialsDir(), "cccccccccccccccc.json"), JSON.stringify({ ...base, id: "cccccccccccccccc", mediaType: "text/markdown", markdown: "# Old" }));

    const web = await store.get("aaaaaaaaaaaaaaaa");
    expect(web).toMatchObject({ primaryView: "web", readyViews: ["web"], views: [{ id: "web", label: "Web page", url: "https://example.test/post", mediaType: "text/html", status: "ready", fetchedAt: "2026-09-01T00:00:00.000Z", byteLength: 120 }] });
    const pdf = await store.get("bbbbbbbbbbbbbbbb");
    expect(pdf).toMatchObject({ primaryView: "pdf", readyViews: ["pdf"], views: [{ id: "pdf", label: "PDF", status: "ready", byteLength: 900, pdf: { pages: 4, byteLength: 900, textLayer: "available" } }] });
    expect(await store.get("cccccccccccccccc")).toMatchObject({ primaryView: "markdown", views: [{ id: "markdown", label: "Markdown", status: "ready" }] });
    expect((await store.list()).map((summary) => summary.readyViews)).toEqual([["web"], ["pdf"], ["markdown"]]);
    expect(await store.getView("aaaaaaaaaaaaaaaa", "web")).toEqual({ view: "web", mediaType: "text/html", markdown: "Body", readingMinutes: 3, quality: base.quality, problems: [] });
    expect(await store.getView("aaaaaaaaaaaaaaaa", "pdf")).toBeUndefined();
  });

  it("writes the primary view explicitly for new materials and keeps view files out of the list", async () => {
    const store = new MaterialStore(root, fetcherOf(await pdfFixture()));
    const record = await openWithPdfView(store);
    const stored = JSON.parse(await readFile(join(materialsDir(), `${record.id}.json`), "utf8")) as { views: unknown[]; primaryView: string };
    expect(stored.primaryView).toBe("web");
    expect(stored.views).toHaveLength(2);
    expect(record).toMatchObject({ readyViews: ["web"], views: [{ id: "web", status: "ready" }, { id: "pdf", status: "available", url: "https://arxiv.org/pdf/2409.12345" }] });
    await expect(store.registerView(record.id, { id: "web", label: "Web page", url: "x", mediaType: "text/html", status: "available" })).rejects.toThrow(/primary view/);
    await expect(store.registerView(record.id, { id: "pdf", label: "PDF", url: "x", mediaType: "application/pdf", status: "ready" })).rejects.toThrow(/claims to be stored/);
    await expect(store.registerView("0000000000000000", { id: "pdf", label: "PDF", url: "x", mediaType: "application/pdf", status: "available" })).rejects.toThrow(/not in the library/);
  });
});

describe("MaterialStore.fetchView", () => {
  it("fetches an available PDF view, stores it beside the record and marks it ready with its pdf info", async () => {
    const pdf = await pdfFixture();
    const fetch = fetcherOf(pdf);
    const store = new MaterialStore(root, fetch);
    const { id } = await openWithPdfView(store);
    const result = await store.fetchView(id, "pdf");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(fetch.calls).toEqual(["https://arxiv.org/html/2409.12345", "https://arxiv.org/pdf/2409.12345"]);
    const view = result.material.views.find((entry) => entry.id === "pdf");
    expect(view).toMatchObject({ status: "ready", byteLength: pdf.byteLength, pdf: { pages: 2, byteLength: pdf.byteLength, textLayer: "available" } });
    expect(view?.fetchedAt).toBeDefined();
    expect(view?.error).toBeUndefined();
    expect(result.material).toMatchObject({ primaryView: "web", readyViews: ["web", "pdf"], mediaType: "text/html", title: "Retrieval Without Regret" });
    expect(await exists(join(materialsDir(), `${id}.pdf.json`))).toBe(true);
    expect(await exists(join(materialsDir(), `${id}.pdf.pdf`))).toBe(true);
    expect(await exists(join(materialsDir(), `${id}.pdf`))).toBe(false);
    expect(await store.getView(id, "pdf")).toMatchObject({ view: "pdf", mediaType: "application/pdf", pdf: { pages: 2 }, readingMinutes: 5 });
    expect((await store.getView(id, "pdf"))?.plain).toContain("Second page");
    expect((await store.getView(id, "web"))?.reader?.schema).toBe("reader.document.v2");
    expect((await store.bytes(id, "pdf"))?.byteLength).toBe(pdf.byteLength);
    expect(await store.bytes(id)).toBeUndefined();
    expect(await store.bytes(id, "web")).toBeUndefined();
    expect((await store.list())[0]?.readyViews).toEqual(["web", "pdf"]);
    expect(await store.fetchView(id, "pdf")).toMatchObject({ ok: false, code: "VIEW_ALREADY_STORED" });
  });

  it("marks the view failed with the message when the fetch breaks, and ready once a later fetch works", async () => {
    let broken = true;
    const store = new MaterialStore(root, fetcherOf(await pdfFixture(), async (url) => {
      if (broken) throw new FetchError("HTTP_503", "The page answered 503.");
      return { bytes: await pdfFixture(), mediaType: "application/pdf", finalUrl: url.toString() };
    }));
    const { id } = await openWithPdfView(store);
    expect(await store.fetchView(id, "pdf")).toEqual({ ok: false, code: "HTTP_503", message: "The page answered 503." });
    const failed = await store.get(id);
    expect(failed?.views.find((entry) => entry.id === "pdf")).toMatchObject({ status: "failed", error: "The page answered 503." });
    expect(failed?.readyViews).toEqual(["web"]);
    expect(await store.getView(id, "pdf")).toBeUndefined();
    broken = false;
    const retried = await store.fetchView(id, "pdf");
    expect(retried.ok).toBe(true);
    const view = retried.ok ? retried.material.views.find((entry) => entry.id === "pdf") : undefined;
    expect(view).toMatchObject({ status: "ready", pdf: { pages: 2 } });
    expect(view?.error).toBeUndefined();
  });

  it("refuses bytes that do not fit the view, unknown views and unknown materials", async () => {
    const store = new MaterialStore(root, fetcherOf(await pdfFixture(), async (url) => ({ bytes: new TextEncoder().encode(article("Not a PDF")), mediaType: "text/html", finalUrl: url.toString() })));
    const { id } = await openWithPdfView(store);
    expect(await store.fetchView(id, "pdf")).toMatchObject({ ok: false, code: "VIEW_TYPE_MISMATCH" });
    expect((await store.get(id))?.views.find((entry) => entry.id === "pdf")).toMatchObject({ status: "failed", error: "The pdf view answered text/html." });
    expect(await store.fetchView(id, "markdown")).toMatchObject({ ok: false, code: "VIEW_UNKNOWN" });
    expect(await store.fetchView("0000000000000000", "pdf")).toMatchObject({ ok: false, code: "MATERIAL_NOT_FOUND" });
  });
});

describe("MaterialStore.setPrimaryView", () => {
  it("swaps the record's content with the stored view's, both ways, keeping both readable", async () => {
    const pdf = await pdfFixture();
    const store = new MaterialStore(root, fetcherOf(pdf));
    const { id } = await openWithPdfView(store);
    await expect(store.setPrimaryView(id, "pdf")).rejects.toThrow(/not stored/);
    expect((await store.fetchView(id, "pdf")).ok).toBe(true);
    const before = await store.get(id);

    const asPdf = await store.setPrimaryView(id, "pdf");
    expect(asPdf).toMatchObject({ primaryView: "pdf", mediaType: "application/pdf", readingMinutes: 5, pdf: { pages: 2, byteLength: pdf.byteLength }, readyViews: ["web", "pdf"], title: "Retrieval Without Regret" });
    expect(asPdf.reader).toBeUndefined();
    expect(asPdf.markdown).toBeUndefined();
    expect(asPdf.plain).toContain("Second page");
    expect(asPdf.extracted).toEqual(before?.extracted);
    expect(await exists(join(materialsDir(), `${id}.pdf`))).toBe(true);
    expect(await exists(join(materialsDir(), `${id}.pdf.pdf`))).toBe(false);
    expect(await exists(join(materialsDir(), `${id}.pdf.json`))).toBe(false);
    expect(await exists(join(materialsDir(), `${id}.web.json`))).toBe(true);
    expect((await store.bytes(id))?.byteLength).toBe(pdf.byteLength);
    expect((await store.bytes(id, "pdf"))?.byteLength).toBe(pdf.byteLength);
    expect(await store.getView(id, "web")).toMatchObject({ view: "web", mediaType: "text/html", reader: before?.reader, readingMinutes: before?.readingMinutes });
    expect(await store.getView(id, "pdf")).toMatchObject({ view: "pdf", pdf: { pages: 2 } });
    expect((await store.list())[0]).toMatchObject({ mediaType: "application/pdf", readyViews: ["web", "pdf"] });
    expect(await store.setPrimaryView(id, "pdf")).toMatchObject({ primaryView: "pdf" });

    const asWeb = await store.setPrimaryView(id, "web");
    expect(asWeb).toMatchObject({ primaryView: "web", mediaType: "text/html", reader: before?.reader, readingMinutes: before?.readingMinutes, readyViews: ["web", "pdf"] });
    expect(asWeb.pdf).toBeUndefined();
    expect(await exists(join(materialsDir(), `${id}.pdf`))).toBe(false);
    expect(await exists(join(materialsDir(), `${id}.pdf.pdf`))).toBe(true);
    expect(await exists(join(materialsDir(), `${id}.pdf.json`))).toBe(true);
    expect(await exists(join(materialsDir(), `${id}.web.json`))).toBe(false);
    expect(await store.bytes(id)).toBeUndefined();
    expect((await store.bytes(id, "pdf"))?.byteLength).toBe(pdf.byteLength);
    expect(await store.getView(id, "pdf")).toMatchObject({ view: "pdf", pdf: { pages: 2 } });
    await expect(store.setPrimaryView(id, "markdown")).rejects.toThrow(/not stored/);
    await expect(store.setPrimaryView("0000000000000000", "web")).rejects.toThrow(/not in the library/);
  });
});

describe("MaterialStore.delete with views", () => {
  it("removes the view files with the record", async () => {
    const store = new MaterialStore(root, fetcherOf(await pdfFixture()));
    const { id } = await openWithPdfView(store);
    expect((await store.fetchView(id, "pdf")).ok).toBe(true);
    expect(await store.delete([id])).toBe(1);
    for (const name of [`${id}.json`, `${id}.html`, `${id}.pdf.json`, `${id}.pdf.pdf`]) expect(await exists(join(materialsDir(), name))).toBe(false);
    expect(await store.list()).toEqual([]);
  });
});
