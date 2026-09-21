// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeTextQuoteLocator, encodeTextQuoteV2Locator, resolveReaderDocument } from "@read/reader";
import { parsePdfRegionsLocator } from "@read/reader-pdf";
import type { Annotation, MaterialRecord, MaterialView } from "../../shared/contracts";
import { mockRead } from "./testApi";

const api = vi.hoisted(() => ({ read: {} as ReturnType<typeof import("./testApi").mockRead> }));
vi.mock("./api", () => ({ get read() { return api.read; }, isPreview: true }));

import { mirroredViews, resolveViewAnnotations, showsViewTags } from "./mirroredAnnotations";
import { NotesPanel } from "./NotesPanel";
import { previewTextViewContent } from "./previewTextView";

const quality = { completeness: "declared_full" as const, conformance: "conformant" as const, identityConfidence: "strong" as const, safety: "safe" as const, warnings: [] };
const ID = "5f725f31pdf00001";
const content = previewTextViewContent(ID, quality);
const pdfReady: MaterialView = { id: "pdf", label: "PDF", url: "https://example.org/a.pdf", mediaType: "application/pdf", status: "ready", fetchedAt: "2026-09-19T00:00:00.000Z", pdf: { pages: 15, byteLength: 10, textLayer: "available" } };
const textReady: MaterialView = { id: "text", label: "Text", url: "https://example.org/a.pdf", mediaType: "text/plain", status: "ready", fetchedAt: "2026-09-20T00:00:00.000Z", byteLength: 100 };
const textAvailable: MaterialView = { ...textReady, status: "available" };

const annotation = (partial: Partial<Annotation> & Pick<Annotation, "id" | "locator" | "quote">): Annotation => ({ materialId: ID, kind: "highlight", color: "#ffd400", createdAt: "2026-09-20T00:00:00.000Z", updatedAt: "2026-09-20T00:00:00.000Z", ...partial });
// The whole first line of the second page of the sample reflow.
const pdfNote = annotation({ id: "p1", view: "pdf", locator: "pdf-regions:v1:2:0.1200,0.1000,0.7600,0.0180", quote: "in conjunction with a recurrent network" });
const textQuote = "Recurrent neural networks have long been";
const textNote = annotation({ id: "t1", view: "text", quote: textQuote, locator: encodeTextQuoteV2Locator({ occurrence: 0, prefix: "1Introduction", suffix: "thestateoftheartinsequence" }) });

function record(views: MaterialView[]): MaterialRecord {
  const extracted = { kind: "preprint" as const, title: "Attention Is All You Need" };
  return { id: ID, url: "https://example.org/a.pdf", finalUrl: "https://example.org/a.pdf", title: "Attention Is All You Need", fetchedAt: "2026-09-18T00:00:00.000Z", origin: "web", tags: [], kind: "preprint", problems: [], views, primaryView: "pdf", readyViews: views.filter((view) => view.status === "ready").map((view) => view.id), extracted, meta: extracted, mediaType: "application/pdf", readingMinutes: 30, quality };
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear(); });

describe("the preview text view", () => {
  it("is a valid reader document whose anchors tile its plain text in order", () => {
    expect(resolveReaderDocument(content.reader!.schema, content.reader!.payload).status).toBe("ready");
    const anchors = content.anchors!;
    expect(anchors.length).toBeGreaterThan(10);
    for (const [index, anchor] of anchors.entries()) {
      expect(content.plain!.slice(anchor.start, anchor.end)).not.toMatch(/^\s|\s$/);
      if (index > 0) expect(anchor.start).toBeGreaterThanOrEqual(anchors[index - 1]!.end);
    }
    expect(new Set(anchors.map((anchor) => anchor.page))).toEqual(new Set([1, 2]));
    expect(content.report).toMatchObject({ pages: 2, columns: 1, headings: 2, paragraphs: 4, figures: 1, degradedPages: [] });
  });
});

describe("resolveViewAnnotations", () => {
  it("carries a PDF note into the text view as the quote under its regions", () => {
    const shown = resolveViewAnnotations([pdfNote, textNote], "text", "pdf", content);
    expect(shown.map((entry) => entry.id)).toEqual(["p1", "t1"]);
    expect(shown[0]!.quote).toBe("in conjunction with a recurrent network rather than in its place.");
    expect(decodeTextQuoteLocator(shown[0]!.locator)?.suffix).toMatch(/^Inthisworkweproposethe/);
    expect(shown[1]).toBe(textNote);
  });

  it("carries a text note into the PDF view as clipped regions on its page", () => {
    const shown = resolveViewAnnotations([pdfNote, textNote], "pdf", "pdf", content);
    expect(shown.map((entry) => entry.id)).toEqual(["p1", "t1"]);
    expect(shown[0]).toBe(pdfNote);
    const regions = parsePdfRegionsLocator(shown[1]!.locator);
    expect(regions).toHaveLength(1);
    expect(regions[0]).toMatchObject({ page: 1, x: 0.12, y: 0.3 });
    // The quote is the first 40 characters of the line under it.
    const line = content.anchors!.find((anchor) => anchor.page === 1 && anchor.rect[1] === 0.3)!;
    expect(regions[0]!.width).toBeCloseTo(0.76 * (textQuote.length / (line.end - line.start)), 3);
  });

  it("shows only the view's own notes while the text view is not loaded, and none of the web view's", () => {
    expect(resolveViewAnnotations([pdfNote, textNote], "pdf", "pdf", undefined)).toEqual([pdfNote]);
    expect(resolveViewAnnotations([pdfNote, textNote], "text", "pdf", undefined)).toEqual([textNote]);
    expect(resolveViewAnnotations([pdfNote, textNote, annotation({ id: "w1", view: "web", locator: "text-quote:v2:e30=", quote: "x" })], "pdf", "pdf", content).map((entry) => entry.id)).toEqual(["p1", "t1"]);
    expect(mirroredViews("pdf", content)).toEqual(["text"]);
    expect(mirroredViews("text", content)).toEqual(["pdf"]);
    expect(mirroredViews("web", content)).toEqual([]);
    expect(mirroredViews("pdf", undefined)).toEqual([]);
  });

  it("drops a note whose regions cover no line", () => {
    const off = annotation({ id: "p2", view: "pdf", locator: "pdf-regions:v1:2:0.1,0.9,0.5,0.02", quote: "footer" });
    expect(resolveViewAnnotations([off], "text", "pdf", content)).toEqual([]);
  });
});

describe("NotesPanel with both renderings of a PDF", () => {
  const panel = (material: MaterialRecord, mirrored: readonly ("pdf" | "text")[]) => (
    <NotesPanel material={material} view="pdf" mirroredViews={mirrored} annotations={[pdfNote, textNote]} error={undefined} activeId={undefined} draft={null} onDraftChange={() => undefined} onJump={() => undefined} onUpdateNote={() => undefined} onDelete={() => undefined} sectionFor={() => undefined} />
  );

  it("tags each note with its view and keeps jumps in place for a mirrored view", () => {
    api.read = mockRead();
    expect(showsViewTags([pdfReady, textReady])).toBe(true);
    expect(showsViewTags([pdfReady, textAvailable])).toBe(false);
    render(panel(record([pdfReady, textReady]), ["text"]));
    expect(screen.getByTitle("Made in the PDF view").textContent).toBe("PDF");
    expect(screen.getByTitle("Made in the Text view").textContent).toBe("Text");
    expect(screen.getByRole("heading", { name: "Text" })).toBeTruthy();
    expect(screen.queryByText(/jumping switches the view/)).toBeNull();
  });

  it("says a jump switches the view when the text view is not mirrored, and tags nothing while it is not built", () => {
    api.read = mockRead();
    render(panel(record([pdfReady, textAvailable]), []));
    expect(screen.queryByTitle("Made in the PDF view")).toBeNull();
    expect(screen.getByRole("heading", { name: "Text · jumping switches the view" })).toBeTruthy();
  });
});
