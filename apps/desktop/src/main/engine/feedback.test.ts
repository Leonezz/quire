import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MaterialViewContent, MaterialViewId, RenderingFeedbackDraft, TextViewReport } from "../../shared/contracts";
import { FeedbackStore, extractedTextOf, slugForUrl, type CorpusMeta, type FeedbackMaterialRecord, type FeedbackMaterials } from "./feedback";

let root = "";
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "read-feedback-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const PAGE_ID = "0123456789abcdef";
const PDF_ID = "fedcba9876543210";
const PLAIN_ID = "aaaaaaaaaaaaaaaa";
const quality: MaterialViewContent["quality"] = { completeness: "declared_full", conformance: "conformant", identityConfidence: "strong", safety: "safe", warnings: [] };
const problems: MaterialViewContent["problems"] = [{ code: "MAIN_CANDIDATE_AMBIGUOUS", recoverBy: "none", scope: "candidate", severity: "warning" }];
const html = new TextEncoder().encode("<!doctype html><html><body><article><h1>Gondor</h1><p>The siege.</p></article></body></html>");
const report: TextViewReport = { pages: 2, columns: 1, furnitureLines: 4, headings: 3, paragraphs: 20, figures: 1, degradedPages: [] };

const page: FeedbackMaterialRecord = {
  id: PAGE_ID, url: "https://www.acoup.blog/2019/05/10/collections-the-siege-of-gondor/?utm=x", finalUrl: "https://acoup.blog/2019/05/10/collections-the-siege-of-gondor/",
  title: "Collections: The Siege of Gondor", fetchedAt: "2026-09-17T15:30:32.129Z", mediaType: "text/html", capture: { byteLength: html.byteLength, mediaType: "text/html; charset=UTF-8" },
};
const pdf: FeedbackMaterialRecord = { id: PDF_ID, url: "https://arxiv.org/pdf/2409.12345", finalUrl: "https://arxiv.org/pdf/2409.12345v2", title: "Retrieval Without Regret", fetchedAt: "2026-09-18T09:00:00.000Z", mediaType: "application/pdf", pdf: { pages: 2, byteLength: 4096, textLayer: "available" } };
const plainOnly: FeedbackMaterialRecord = { id: PLAIN_ID, url: "https://example.test/plain", finalUrl: "https://example.test/plain", title: "Plain", fetchedAt: "2026-09-19T00:00:00.000Z", mediaType: "text/html" };

const content = (view: MaterialViewId, extra: Partial<MaterialViewContent> = {}): MaterialViewContent => ({ view, mediaType: "text/html", readingMinutes: 3, quality, problems: [...problems], ...extra });

/** A library of three materials: a captured page (web + markdown views), a PDF with its text view, and a page that only has plain text. */
function fakeMaterials(overrides: Partial<FeedbackMaterials> = {}): FeedbackMaterials {
  const records = new Map([[PAGE_ID, page], [PDF_ID, pdf], [PLAIN_ID, plainOnly]]);
  const views = new Map<string, MaterialViewContent>([
    [`${PAGE_ID}:web`, content("web", { markdown: "# Gondor\n\nThe siege.", plain: "Gondor\nThe siege." })],
    [`${PAGE_ID}:markdown`, content("markdown", { mediaType: "text/markdown", markdown: "# Gondor (md)" })],
    [`${PDF_ID}:pdf`, content("pdf", { mediaType: "application/pdf", pdf: pdf.pdf!, problems: [] })],
    [`${PDF_ID}:text`, content("text", { mediaType: "text/x-quire-reflow", plain: "Retrieval Without Regret\n\nAbstract…", report, problems: [] })],
    [`${PLAIN_ID}:web`, content("web", { plain: "only plain text here" })],
  ]);
  return {
    get: async (id) => records.get(id),
    getView: async (id, view) => views.get(`${id}:${view}`),
    captureBytes: async (id) => (id === PAGE_ID ? html : undefined),
    ...overrides,
  };
}

let tick = 0;
function storeOf(materials = fakeMaterials(), warnings: string[] = []): FeedbackStore {
  tick = 0;
  return new FeedbackStore(join(root, "feedback"), {
    materials, app: { version: "0.1.0-alpha.3", platform: "darwin", normalize: "0.0.1" },
    now: () => new Date(Date.UTC(2026, 8, 23, 12, 0, tick++)),
    warn: (message) => warnings.push(message),
  });
}

const draft = (overrides: Partial<RenderingFeedbackDraft> = {}): RenderingFeedbackDraft => ({ materialId: PAGE_ID, view: "web", kinds: ["missing_content", "images"], note: "The last section is gone.", includeCapture: true, ...overrides });
const exists = (path: string) => stat(path).then(() => true, () => false);

describe("FeedbackStore.create", () => {
  it("writes the bundle in the corpus entry layout, with the capture gzipped", async () => {
    const store = storeOf();
    const record = await store.create(draft());
    expect(record.id).toMatch(/^[a-f0-9]{16}$/);
    expect(record.bundleDir).toBe(join(root, "feedback", record.id));
    expect((await readdir(record.bundleDir)).sort()).toEqual(["extracted.md", "meta.json", "page.html.gz", "report.json"]);
    expect(record).toMatchObject({
      createdAt: "2026-09-23T12:00:00.000Z", materialId: PAGE_ID, url: page.url, title: page.title, view: "web", kinds: ["missing_content", "images"], note: "The last section is gone.",
      app: { version: "0.1.0-alpha.3", platform: "darwin", normalize: "0.0.1" }, quality, problems,
      capture: { included: true, byteLength: html.byteLength, mediaType: "text/html; charset=UTF-8" },
    });
    expect(record.report).toBeUndefined();
    expect(JSON.parse(await readFile(join(record.bundleDir, "report.json"), "utf8"))).toEqual(record);
    expect(JSON.parse(await readFile(join(record.bundleDir, "meta.json"), "utf8"))).toEqual({
      slug: "acoup-blog-2019-05-10-collections-the-siege-of-gondor", url: page.url, finalUrl: page.finalUrl, status: 200, contentType: "text/html; charset=UTF-8",
      bytes: html.byteLength, generator: "", fetchedAt: page.fetchedAt, framework: "unknown", tags: ["missing_content", "images"],
    } satisfies CorpusMeta);
    expect(new Uint8Array(gunzipSync(await readFile(join(record.bundleDir, "page.html.gz"))))).toEqual(html);
    expect(await readFile(join(record.bundleDir, "extracted.md"), "utf8")).toBe("# Gondor\n\nThe siege.");
    expect(await exists(join(root, "feedback", `.${record.id}.partial`))).toBe(false);
  });

  it("leaves the capture out when not asked for, and still notes that one exists", async () => {
    const store = storeOf();
    const record = await store.create(draft({ includeCapture: false, view: "markdown" }));
    expect((await readdir(record.bundleDir)).sort()).toEqual(["extracted.md", "meta.json", "report.json"]);
    expect(record.capture).toEqual({ included: false, byteLength: html.byteLength, mediaType: "text/html; charset=UTF-8" });
    expect(await readFile(join(record.bundleDir, "extracted.md"), "utf8")).toBe("# Gondor (md)");
    const meta = JSON.parse(await readFile(join(record.bundleDir, "meta.json"), "utf8")) as CorpusMeta;
    expect(meta.contentType).toBe("text/html; charset=UTF-8");
  });

  it("refuses to include a capture the material does not have, and says why", async () => {
    const store = storeOf();
    await expect(store.create(draft({ materialId: PDF_ID, view: "pdf" }))).rejects.toThrow(/no saved original page/);
    expect(await readdir(join(root, "feedback")).catch(() => [])).toEqual([]);
    const missingFile = storeOf(fakeMaterials({ captureBytes: async () => undefined }));
    await expect(missingFile.create(draft())).rejects.toThrow(/its file is missing/);
  });

  it("copies the text view's report and its plain text, and takes bytes and type from the PDF", async () => {
    const store = storeOf();
    const record = await store.create(draft({ materialId: PDF_ID, view: "text", includeCapture: false, kinds: ["wrong_order"] }));
    expect(record.report).toEqual(report);
    expect(record.problems).toEqual([]);
    expect(record.capture).toEqual({ included: false });
    expect(await readFile(join(record.bundleDir, "extracted.md"), "utf8")).toBe("Retrieval Without Regret\n\nAbstract…");
    const meta = JSON.parse(await readFile(join(record.bundleDir, "meta.json"), "utf8")) as CorpusMeta;
    expect(meta).toMatchObject({ slug: "arxiv-org-pdf-2409-12345v2", contentType: "application/pdf", bytes: 4096, tags: ["wrong_order"] });
    // The report is only about the text view: the pdf view of the same material carries none.
    const onPdf = await store.create(draft({ materialId: PDF_ID, view: "pdf", includeCapture: false, kinds: ["images"] }));
    expect(onPdf.report).toBeUndefined();
    expect(await readFile(join(onPdf.bundleDir, "extracted.md"), "utf8")).toBe("");
  });

  it("falls back to plain text for extracted.md when the view has no markdown", async () => {
    const store = storeOf();
    const record = await store.create(draft({ materialId: PLAIN_ID, includeCapture: false }));
    expect(await readFile(join(record.bundleDir, "extracted.md"), "utf8")).toBe("only plain text here");
    expect(extractedTextOf({ markdown: "md", plain: "plain" })).toBe("md");
    expect(extractedTextOf({})).toBe("");
  });

  it("rejects unknown materials, unstored views, bad kinds and oversized notes loudly", async () => {
    const store = storeOf();
    await expect(store.create(draft({ materialId: "bbbbbbbbbbbbbbbb" }))).rejects.toThrow("Material bbbbbbbbbbbbbbbb is not in the library.");
    await expect(store.create(draft({ materialId: "../etc" }))).rejects.toThrow("Not a material id");
    await expect(store.create(draft({ view: "pdf" }))).rejects.toThrow(/pdf view .* is not stored/);
    await expect(store.create(draft({ kinds: [] }))).rejects.toThrow("Pick at least one thing that went wrong.");
    await expect(store.create(draft({ kinds: ["typos" as never] }))).rejects.toThrow("Unknown problem kind: typos");
    await expect(store.create(draft({ note: "x".repeat(20_001) }))).rejects.toThrow(/at most 20000 characters/);
    await expect(store.create(draft({ includeCapture: "yes" as never }))).rejects.toThrow("includeCapture must be true or false.");
    expect(await store.list()).toEqual([]);
  });

  it("keeps each kind once, in the order given", async () => {
    const record = await storeOf().create(draft({ kinds: ["images", "missing_content", "images"] }));
    expect(record.kinds).toEqual(["images", "missing_content"]);
  });
});

describe("FeedbackStore.list / get / delete / setIssueUrl", () => {
  it("lists newest first and reads one back", async () => {
    const store = storeOf();
    const first = await store.create(draft({ includeCapture: false }));
    const second = await store.create(draft({ materialId: PDF_ID, view: "text", includeCapture: false }));
    const third = await store.create(draft({ includeCapture: false, kinds: ["other"] }));
    expect((await store.list()).map((record) => record.id)).toEqual([third.id, second.id, first.id]);
    expect(await store.get(second.id)).toEqual(second);
    expect(await store.get("cccccccccccccccc")).toBeUndefined();
    expect(() => store.bundleDir("../../etc")).toThrow("Not a feedback id");
  });

  it("warns about an unreadable bundle and lists the rest", async () => {
    const warnings: string[] = [];
    const store = storeOf(fakeMaterials(), warnings);
    const good = await store.create(draft({ includeCapture: false }));
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(join(root, "feedback", "dddddddddddddddd"));
    await writeFile(join(root, "feedback", "dddddddddddddddd", "report.json"), "{not json", "utf8");
    await mkdir(join(root, "feedback", "not-an-id"));
    expect((await store.list()).map((record) => record.id)).toEqual([good.id]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/dddddddddddddddd\/report\.json is unreadable/);
  });

  it("deletes the whole bundle and refuses unknown ids", async () => {
    const store = storeOf();
    const record = await store.create(draft());
    await store.delete(record.id);
    expect(await exists(record.bundleDir)).toBe(false);
    expect(await store.list()).toEqual([]);
    await expect(store.delete(record.id)).rejects.toThrow(`Feedback ${record.id} does not exist.`);
    await expect(store.delete("nope")).rejects.toThrow("Not a feedback id");
  });

  it("keeps the issue link on the record, github.com over https only", async () => {
    const store = storeOf();
    const record = await store.create(draft({ includeCapture: false }));
    const linked = await store.setIssueUrl(record.id, "https://github.com/Leonezz/quire/issues/42");
    expect(linked.issueUrl).toBe("https://github.com/Leonezz/quire/issues/42");
    expect(await store.get(record.id)).toEqual(linked);
    expect(JSON.parse(await readFile(join(record.bundleDir, "report.json"), "utf8")).issueUrl).toBe("https://github.com/Leonezz/quire/issues/42");
    await expect(store.setIssueUrl(record.id, "http://github.com/Leonezz/quire/issues/42")).rejects.toThrow(/https:\/\/github\.com/);
    await expect(store.setIssueUrl(record.id, "https://gitlab.com/x/y/-/issues/1")).rejects.toThrow(/https:\/\/github\.com/);
    await expect(store.setIssueUrl(record.id, "not a url")).rejects.toThrow("Not a URL: not a url");
    await expect(store.setIssueUrl("cccccccccccccccc", "https://github.com/Leonezz/quire/issues/1")).rejects.toThrow("Feedback cccccccccccccccc does not exist.");
    expect((await store.get(record.id))?.issueUrl).toBe("https://github.com/Leonezz/quire/issues/42");
  });
});

describe("slugForUrl", () => {
  it("joins host and path, drops www and punctuation, and caps the length", () => {
    expect(slugForUrl("https://www.acoup.blog/2019/05/10/collections-the-siege-of-gondor/", "x")).toBe("acoup-blog-2019-05-10-collections-the-siege-of-gondor");
    expect(slugForUrl("https://example.test/", "x")).toBe("example-test");
    expect(slugForUrl("https://example.test/" + "a".repeat(200), "x")).toHaveLength(80);
    expect(slugForUrl("quire://artifact/0123456789abcdef", "x")).toBe("artifact-0123456789abcdef");
    expect(slugForUrl("not a url", "fallback")).toBe("fallback");
  });
});
