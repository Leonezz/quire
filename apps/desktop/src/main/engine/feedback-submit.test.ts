import { unzipSync } from "fflate";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MaterialViewContent, MaterialViewId } from "../../shared/contracts";
import { FeedbackStore, type FeedbackMaterialRecord, type FeedbackMaterials, type SubmitDraft } from "./feedback";
import type { Rect } from "./feedback-capture";
import { sizeText, submitFeedback, zipNameOf, type Capturer, type FeedbackProgress, type SubmitDeps } from "./feedback-submit";

let root = "";
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "read-feedback-submit-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const PAGE_ID = "0123456789abcdef";
const PDF_ID = "fedcba9876543210";
const quality: MaterialViewContent["quality"] = { completeness: "declared_full", conformance: "conformant", identityConfidence: "strong", safety: "safe", warnings: [] };
const html = new TextEncoder().encode("<!doctype html><html><head><title>Gondor</title></head><body><p>The siege.</p></body></html>");
const pdfBytes = new TextEncoder().encode("%PDF-1.7\n%%EOF");
const page: FeedbackMaterialRecord = {
  id: PAGE_ID, url: "https://acoup.blog/2019/05/10/gondor/", finalUrl: "https://acoup.blog/2019/05/10/gondor/", title: "Gondor", fetchedAt: "2026-09-17T15:30:32.129Z",
  mediaType: "text/html", capture: { byteLength: html.byteLength, mediaType: "text/html; charset=utf-8" }, primaryView: "web",
};
const pdf: FeedbackMaterialRecord = { id: PDF_ID, url: "https://arxiv.org/pdf/2409.12345", finalUrl: "https://arxiv.org/pdf/2409.12345", title: "Paper", fetchedAt: "2026-09-18T09:00:00.000Z", mediaType: "application/pdf", pdf: { pages: 2, byteLength: pdfBytes.byteLength, textLayer: "available" }, primaryView: "pdf" };
const content = (view: MaterialViewId, extra: Partial<MaterialViewContent> = {}): MaterialViewContent => ({ view, mediaType: "text/html", readingMinutes: 3, quality, problems: [], ...extra });

const materials: FeedbackMaterials = {
  get: async (id) => (id === PAGE_ID ? page : id === PDF_ID ? pdf : undefined),
  getView: async (id, view) => {
    if (id === PAGE_ID && view === "web") return content("web", { markdown: "# Gondor", reader: { schema: "reader.document.v2", payload: '{"type":"root","children":[],"losses":[]}' } });
    if (id === PAGE_ID && view === "markdown") return content("markdown", { markdown: "# Gondor (md)" });
    if (id === PDF_ID && view === "pdf") return content("pdf", { mediaType: "application/pdf" });
    return undefined;
  },
  captureBytes: async (id) => (id === PAGE_ID ? html : undefined),
  bytes: async (id) => (id === PDF_ID ? pdfBytes : undefined),
};

const png = (label: string) => new TextEncoder().encode(`PNG:${label}`);

/** A capturer that records what it was asked and answers with labelled bytes; `fail` makes the named step throw. */
function fakeCapturer(options: { fail?: readonly (keyof Capturer)[]; tiles?: number; tileBytes?: number; found?: boolean } = {}) {
  const calls: { viewport: (Rect | undefined)[]; tiles: unknown[]; original: { html: string; width: number; findText?: string }[]; compose: { left: string; right?: string; caption: unknown }[] } = { viewport: [], tiles: [], original: [], compose: [] };
  const failing = (step: keyof Capturer) => { if (options.fail?.includes(step)) throw new Error(`${step} broke`); };
  const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
  const capturer: Capturer = {
    captureViewport: async (rect) => { failing("captureViewport"); calls.viewport.push(rect); return png(calls.viewport.length === 1 ? "viewport" : "selection"); },
    renderReaderTiles: async (input) => {
      failing("renderReaderTiles"); calls.tiles.push(input);
      return { tiles: Array.from({ length: options.tiles ?? 2 }, (_, index) => new Uint8Array(options.tileBytes ?? 8).fill(index + 1)), truncated: false, warnings: ["images-timeout"] };
    },
    renderOriginal: async (input) => {
      failing("renderOriginal"); calls.original.push(input);
      return { top: png("original-top"), ...(input.findText && options.found !== false ? { atSelection: png("original-at") } : {}), warnings: [] };
    },
    compose: async (input) => {
      failing("compose"); calls.compose.push({ left: decode(input.left), ...(input.right ? { right: decode(input.right) } : {}), caption: input.caption });
      return png("composite");
    },
  };
  return { capturer, calls };
}

function harness(capturer: Capturer, overrides: Partial<SubmitDeps> = {}) {
  const progress: FeedbackProgress[] = [];
  const opened: string[] = [];
  const revealed: string[] = [];
  const clipboard: string[] = [];
  const store = new FeedbackStore(join(root, "feedback"), { materials, app: { version: "0.1.0-alpha.3", platform: "darwin", normalize: "0.0.1" }, warn: () => undefined });
  const deps: SubmitDeps = {
    store, capturer, repo: { owner: "Leonezz", repo: "quire" },
    progress: (item) => progress.push(item),
    openExternal: async (url) => { opened.push(url); },
    showItemInFolder: (path) => { revealed.push(path); },
    copyImageToClipboard: async (path) => { clipboard.push(path); },
    ...overrides,
  };
  return { deps, store, progress, opened, revealed, clipboard };
}

const draft = (overrides: Partial<SubmitDraft> = {}): SubmitDraft => ({
  materialId: PAGE_ID, view: "web", kinds: ["images"], note: "Figure 2 is missing.", includeCapture: true, prefs: { fontSize: 18 },
  viewport: { x: 240, y: 52, width: 760, height: 800, scrollFraction: 0.3 },
  selection: { quote: "The   siege.", prefix: "", suffix: "", rect: { x: 300, y: 400, width: 80, height: 20 } },
  ...overrides,
});

const zipFiles = async (zipPath: string) => Object.keys(unzipSync(new Uint8Array(await readFile(zipPath)))).sort();

describe("submitFeedback", () => {
  it("writes the bundle, every screenshot and the zip, then hands off to the clipboard, the issue page and Finder", async () => {
    const { capturer, calls } = fakeCapturer();
    const { deps, store, progress, opened, revealed, clipboard } = harness(capturer);
    const record = await submitFeedback(deps, draft());
    const dir = record.bundleDir;
    const pack = record.package!;

    expect(calls.viewport).toEqual([{ x: 240, y: 52, width: 760, height: 800 }, { x: 240, y: 280, width: 760, height: 260 }]);
    expect(calls.tiles).toEqual([{ materialId: PAGE_ID, width: 760, tileHeight: 1600, maxTiles: 8 }]);
    expect(calls.original).toHaveLength(1);
    expect(calls.original[0]).toMatchObject({ width: 1280, findText: "The siege." });
    expect(calls.original[0]!.html).toContain('<base href="https://acoup.blog/2019/05/10/gondor/">');
    expect(calls.compose).toEqual([{ left: "PNG:selection", right: "PNG:original-at", caption: { title: "Gondor", detail: "https://acoup.blog/2019/05/10/gondor/ · web view · images" } }]);

    expect(pack.screenshots).toEqual([
      "screenshots/reader-viewport.png", "screenshots/reader-selection.png", "screenshots/reader-full-01.jpg", "screenshots/reader-full-02.jpg",
      "screenshots/original-top.png", "screenshots/original-at-selection.png",
    ]);
    expect(pack.composite).toBe("screenshots/composite.png");
    expect(pack).toMatchObject({ issueOpened: true, revealed: true, copiedToClipboard: true });
    expect(pack.warnings).toEqual(["Full-article screenshots: images-timeout"]);
    expect(basename(pack.zipPath)).toBe(zipNameOf("acoup-blog-2019-05-10-gondor", record.id));
    expect(pack.zipBytes).toBe((await readFile(pack.zipPath)).byteLength);
    expect(await zipFiles(pack.zipPath)).toEqual([
      "extracted.md", "meta.json", "page.html.gz", "reader-document.json", "report.json",
      "screenshots/composite.png", "screenshots/original-at-selection.png", "screenshots/original-top.png",
      "screenshots/reader-full-01.jpg", "screenshots/reader-full-02.jpg", "screenshots/reader-selection.png", "screenshots/reader-viewport.png",
    ]);
    expect(await readFile(join(dir, "screenshots/reader-viewport.png"), "utf8")).toBe("PNG:viewport");

    expect(clipboard).toEqual([join(dir, "screenshots/composite.png")]);
    expect(revealed).toEqual([pack.zipPath]);
    expect(opened).toHaveLength(1);
    expect(new URL(opened[0]!).searchParams.get("note")).toContain(`press ⌘V here. Then drag ${basename(pack.zipPath)} (shown in Finder)`);
    expect(progress.map((item) => item.step)).toEqual(["capturing", "capturing", "rendering-original", "packaging", "opening"]);
    expect(progress.every((item) => item.id === record.id)).toBe(true);
    expect(record.selection).toEqual({ quote: "The   siege.", prefix: "", suffix: "" });
    expect(record.readerState).toEqual({ scrollFraction: 0.3, prefs: { fontSize: 18 } });
    expect(await store.get(record.id)).toEqual(record);
  });

  it("turns every failed screenshot into a warning and still files the report", async () => {
    const { capturer } = fakeCapturer({ fail: ["captureViewport", "renderReaderTiles", "renderOriginal", "compose"] });
    const { deps, clipboard, opened } = harness(capturer);
    const record = await submitFeedback(deps, draft());
    const pack = record.package!;
    expect(pack.screenshots).toEqual([]);
    expect(pack.composite).toBeUndefined();
    expect(pack.warnings).toEqual([
      "Reader screenshot: captureViewport broke", "Selection screenshot: captureViewport broke", "Full-article screenshots: renderReaderTiles broke",
      "Original page: renderOriginal broke", "Side-by-side screenshot: there is no reader screenshot to put in it.",
    ]);
    expect(pack).toMatchObject({ copiedToClipboard: false, issueOpened: true, revealed: true });
    expect(clipboard).toEqual([]);
    expect(new URL(opened[0]!).searchParams.get("note")).toContain(`**Attachments**\nDrag ${basename(pack.zipPath)}`);
    expect(await zipFiles(pack.zipPath)).toEqual(["extracted.md", "meta.json", "page.html.gz", "reader-document.json", "report.json"]);
  });

  it("records a failed hand-off as warnings", async () => {
    const { capturer } = fakeCapturer();
    const { deps } = harness(capturer, {
      copyImageToClipboard: async () => { throw new Error("no pasteboard"); },
      openExternal: async () => { throw new Error("no browser"); },
      showItemInFolder: () => { throw new Error("no Finder"); },
    });
    const pack = (await submitFeedback(deps, draft())).package!;
    expect(pack).toMatchObject({ copiedToClipboard: false, issueOpened: false, revealed: false });
    expect(pack.warnings).toEqual(expect.arrayContaining(["Clipboard: no pasteboard", "Issue page: no browser", "Finder: no Finder"]));
  });

  it("composes the viewport with the top of the original when there is no selection or it is not found", async () => {
    const { capturer, calls } = fakeCapturer({ found: false });
    const { deps } = harness(capturer);
    await submitFeedback(deps, draft({ selection: undefined }));
    expect(calls.viewport).toEqual([{ x: 240, y: 52, width: 760, height: 800 }]);
    expect(calls.original[0]!.findText).toBeUndefined();
    expect(calls.compose[0]).toMatchObject({ left: "PNG:viewport", right: "PNG:original-top" });
  });

  it("captures the whole window without a viewport", async () => {
    const { capturer, calls } = fakeCapturer();
    const { deps } = harness(capturer);
    await submitFeedback(deps, draft({ viewport: undefined, selection: undefined }));
    expect(calls.viewport).toEqual([undefined]);
    expect(calls.tiles[0]).toMatchObject({ width: 1280 });
  });

  it("renders no original when the reader left it out, and no full article for a view the harness does not show", async () => {
    const { capturer, calls } = fakeCapturer();
    const { deps } = harness(capturer);
    const record = await submitFeedback(deps, draft({ view: "markdown", includeCapture: false }));
    expect(calls.original).toEqual([]);
    expect(calls.tiles).toEqual([]);
    expect(calls.compose[0]).toEqual(expect.objectContaining({ left: "PNG:selection" }));
    expect(calls.compose[0]!.right).toBeUndefined();
    expect(record.package!.warnings).toEqual(["Full-article screenshots: the render harness shows the web view only, so none were taken of the markdown view."]);
  });

  it("packs the PDF itself for the pdf view, with no full-article or original-page screenshots", async () => {
    const { capturer, calls } = fakeCapturer();
    const { deps } = harness(capturer);
    const record = await submitFeedback(deps, draft({ materialId: PDF_ID, view: "pdf", selection: undefined }));
    expect(calls.tiles).toEqual([]);
    expect(calls.original).toEqual([]);
    expect(record.package!.warnings).toEqual([]);
    expect(await zipFiles(record.package!.zipPath)).toEqual(["extracted.md", "meta.json", "original.pdf", "report.json", "screenshots/composite.png", "screenshots/reader-viewport.png"]);
  });

  it("drops full-article tiles from the end to keep the zip under the budget, and removes them from the bundle too", async () => {
    const { capturer } = fakeCapturer({ tiles: 4, tileBytes: 4_000 });
    const { deps } = harness(capturer, { maxZipBytes: 11_000 });
    const record = await submitFeedback(deps, draft());
    const pack = record.package!;
    expect(pack.zipBytes).toBeLessThanOrEqual(11_000);
    expect(pack.screenshots.filter((path) => path.includes("reader-full"))).toEqual(["screenshots/reader-full-01.jpg", "screenshots/reader-full-02.jpg"]);
    expect(pack.warnings).toContain("Packaging: left out the last 2 full-article screenshots to keep the zip under 11 KB.");
    expect((await readdir(join(record.bundleDir, "screenshots"))).filter((name) => name.startsWith("reader-full"))).toEqual(["reader-full-01.jpg", "reader-full-02.jpg"]);
    expect((await zipFiles(pack.zipPath)).filter((name) => name.includes("reader-full"))).toEqual(["screenshots/reader-full-01.jpg", "screenshots/reader-full-02.jpg"]);
  });

  it("fails loudly when the bundle cannot be written, before any screenshot", async () => {
    const { capturer, calls } = fakeCapturer();
    const { deps, progress } = harness(capturer);
    await expect(submitFeedback(deps, draft({ materialId: "bbbbbbbbbbbbbbbb" }))).rejects.toThrow("is not in the library");
    expect(calls.viewport).toEqual([]);
    expect(progress).toEqual([]);
  });

  it("takes both captures of the reader's window while the step is still \"capturing\"", async () => {
    const steps: string[] = [];
    const { capturer } = fakeCapturer();
    const recording: Capturer = { ...capturer, captureViewport: async (rect) => { steps.push("shot"); return capturer.captureViewport(rect); } };
    const { deps } = harness(recording, { progress: (item) => steps.push(item.step) });
    await submitFeedback(deps, draft());
    expect(steps.slice(0, 3)).toEqual(["capturing", "shot", "shot"]);
    expect(steps.indexOf("rendering-original")).toBeGreaterThan(2);
  });
});

describe("sizeText", () => {
  it("speaks megabytes and kilobytes", () => {
    expect(sizeText(24 * 1024 * 1024)).toBe("24 MB");
    expect(sizeText(1.5 * 1024 * 1024)).toBe("1.5 MB");
    expect(sizeText(11_000)).toBe("11 KB");
  });
});
