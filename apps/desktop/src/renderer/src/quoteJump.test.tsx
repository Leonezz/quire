// @vitest-environment jsdom
import { act, cleanup, render, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MaterialRecord, MaterialViewContent } from "../../shared/contracts";
import { mockRead } from "./testApi";

const api = vi.hoisted(() => ({ read: {} as ReturnType<typeof import("./testApi").mockRead> }));
vi.mock("./api", () => ({ get read() { return api.read; }, isPreview: true }));

import { QUOTE_FLASH_MS, clearQuoteJumpReport, flashQuoteRange, reportQuoteJump, resolveQuoteRange, useQuoteJumpReport } from "./quoteJump";
import { textLayerQuoteRange } from "./pdfQuoteSearch";
import { ReaderView } from "./ReaderView";
import type { MaterialViewController } from "./useMaterialView";

afterEach(() => { cleanup(); clearQuoteJumpReport(); vi.restoreAllMocks(); vi.useRealTimers(); });

function body(html: string): HTMLElement {
  const root = document.createElement("article");
  root.innerHTML = html;
  document.body.append(root);
  return root;
}

describe("resolveQuoteRange", () => {
  it("finds the first rendered occurrence of the quote, whitespace and inline markup aside", () => {
    const root = body("<p>The API provides a mechanism for <em>styling arbitrary</em> text\n ranges on a document.</p><p>Again: styling arbitrary text ranges on a document.</p>");
    const range = resolveQuoteRange(root, "styling arbitrary text ranges on a document");
    expect(range?.toString().replace(/\s+/g, " ")).toBe("styling arbitrary text ranges on a document");
    expect(root.querySelector("p")!.contains(range!.startContainer)).toBe(true);
  });
  it("is undefined for a passage the body does not hold, or an empty one", () => {
    const root = body("<p>Nothing to see.</p>");
    expect(resolveQuoteRange(root, "styling arbitrary text ranges")).toBeUndefined();
    expect(resolveQuoteRange(root, "   ")).toBeUndefined();
  });
});

describe("flashQuoteRange", () => {
  it("marks the passage's block for a moment where the Highlight API is missing, then clears it", () => {
    vi.useFakeTimers();
    const root = body("<p>A passage to flash for a moment.</p>");
    const range = resolveQuoteRange(root, "passage to flash")!;
    flashQuoteRange(root, range);
    const paragraph = root.querySelector("p")!;
    expect(paragraph.getAttribute("data-reader-navigation-focus")).toBe("true");
    vi.advanceTimersByTime(QUOTE_FLASH_MS);
    expect(paragraph.getAttribute("data-reader-navigation-focus")).toBeNull();
  });
  it("uses the read-jump highlight when the registry is there", () => {
    vi.useFakeTimers();
    const registry = { set: vi.fn(), delete: vi.fn() };
    const win = window as unknown as { CSS: { highlights?: typeof registry }; Highlight?: unknown };
    const previous = { CSS: win.CSS, Highlight: win.Highlight };
    Object.defineProperty(window, "CSS", { configurable: true, value: { highlights: registry } });
    Object.defineProperty(window, "Highlight", { configurable: true, value: class { constructor(public range: Range) { /* one range */ } } });
    try {
      const root = body("<p>A passage to flash for a moment.</p>");
      flashQuoteRange(root, resolveQuoteRange(root, "passage to flash")!);
      expect(registry.set).toHaveBeenCalledWith("read-jump", expect.anything());
      vi.advanceTimersByTime(QUOTE_FLASH_MS);
      expect(registry.delete).toHaveBeenCalledWith("read-jump");
    } finally {
      Object.defineProperty(window, "CSS", { configurable: true, value: previous.CSS });
      Object.defineProperty(window, "Highlight", { configurable: true, value: previous.Highlight });
    }
  });
});

describe("the jump report", () => {
  it("reaches a panel that listens, until the next citation clears it", () => {
    const { result } = renderHook(() => useQuoteJumpReport());
    expect(result.current).toBeUndefined();
    act(() => reportQuoteJump({ materialId: "526130b61f003c33", quote: "a quoted passage", found: false }));
    expect(result.current?.found).toBe(false);
    act(() => clearQuoteJumpReport());
    expect(result.current).toBeUndefined();
  });
});

describe("textLayerQuoteRange", () => {
  it("spans a quote across the text layer's spans, folding spaces and case", () => {
    const layer = body('<span>The Transformer </span><span>follows this</span><br><span>overall architecture</span><span> using stacked</span>');
    const range = textLayerQuoteRange(layer, "Follows this overall Architecture");
    expect(range?.toString()).toBe("follows thisoverall architecture");
    expect(textLayerQuoteRange(layer, "stacked layers")).toBeUndefined();
  });
});

const quality = { completeness: "declared_full" as const, conformance: "conformant" as const, identityConfidence: "strong" as const, safety: "safe" as const, warnings: [] };
const ID = "526130b61f003c33";
const extracted = { kind: "webpage" as const, title: "CSS Custom Highlight API" };
const material: MaterialRecord = { id: ID, url: "https://example.org/a", finalUrl: "https://example.org/a", title: "CSS Custom Highlight API", fetchedAt: "2026-09-18T00:00:00.000Z", origin: "web", tags: [], kind: "webpage", problems: [], views: [{ id: "web", label: "Web", url: "https://example.org/a", mediaType: "text/html", status: "ready" }], primaryView: "web", readyViews: ["web"], mediaType: "text/html", readingMinutes: 3, quality, extracted, meta: extracted };
const content: MaterialViewContent = { view: "web", quality, readingMinutes: 3, mediaType: "text/html", problems: [], markdown: "## Concepts\n\nThe API provides a mechanism for styling arbitrary text ranges on a document by using JavaScript.\n\n## Usage\n\nMore words follow here." };
const views: MaterialViewController = { view: "web", views: material.views, primaryView: "web", content: { status: "ready", content }, fetching: undefined, fetchError: undefined, select: () => undefined, fetch: async () => undefined, makePrimary: async () => undefined, dismissFetchError: () => undefined };

describe("ReaderView with a quote to jump to", () => {
  it("scrolls the passage into view once the body is up and reports it found; a missing one is reported too", async () => {
    api.read = mockRead({ listAnnotations: vi.fn(async () => []), resolveImage: vi.fn(async (url: string) => url) });
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { callback(0); return 1; });
    const scrolled = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => undefined);
    const { result } = renderHook(() => useQuoteJumpReport());
    const props = { material, content, views, onJumpDone: () => undefined, onJumpAcross: () => undefined, onOpenLink: () => undefined, onOpenMaterial: () => undefined, onMaterialSaved: () => undefined, onReport: () => undefined };
    const view = render(<ReaderView {...props} jumpToQuote={{ materialId: ID, quote: "styling arbitrary text ranges on a document", nonce: 1 }} />);
    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0); }); });
    expect(view.container.textContent).toContain("styling arbitrary text ranges");
    expect(result.current).toEqual({ materialId: ID, quote: "styling arbitrary text ranges on a document", found: true });
    expect(scrolled).toHaveBeenCalledWith(expect.objectContaining({ block: "center" }));
    expect(document.querySelector('[data-reader-navigation-focus="true"]')?.textContent).toContain("styling arbitrary text ranges");
    // Another request for a passage that is not there: the material stays open, the report says so.
    view.rerender(<ReaderView {...props} jumpToQuote={{ materialId: ID, quote: "not in this document at all", nonce: 2 }} />);
    expect(result.current).toEqual({ materialId: ID, quote: "not in this document at all", found: false });
    // A request for another material is not this reader's.
    view.rerender(<ReaderView {...props} jumpToQuote={{ materialId: "deadbeefdeadbeef", quote: "styling arbitrary text ranges", nonce: 3 }} />);
    expect(result.current?.quote).toBe("not in this document at all");
  });
});
