// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MaterialRecord, RenderingFeedback } from "../../shared/contracts";
import { flush, mockRead } from "./testApi";

const api = vi.hoisted(() => ({ read: {} as ReturnType<typeof import("./testApi").mockRead> }));
vi.mock("./api", () => ({ get read() { return api.read; }, isPreview: true }));

import { MaterialReader } from "./MaterialReader";
import { DEFAULT_PREFS, setReadingPrefs } from "./readingPrefs";
import { isReportShortcut } from "./keyboardMap";

// The entry points of a report, end to end through the reader: ⌥⌘R, the selection toolbar's Report and the quality
// pill all open the one panel, and what the panel submits carries where the reader is.

const quality = { completeness: "declared_full" as const, conformance: "conformant" as const, identityConfidence: "strong" as const, safety: "safe" as const, warnings: [] };
const ID = "526130b61f003c33";
const extracted = { kind: "webpage" as const, title: "CSS Custom Highlight API" };
const material: MaterialRecord = {
  id: ID, url: "https://example.org/a", finalUrl: "https://example.org/a", title: "CSS Custom Highlight API", fetchedAt: "2026-09-18T00:00:00.000Z", origin: "web", tags: [], kind: "webpage", problems: [],
  views: [{ id: "web", label: "Web", url: "https://example.org/a", mediaType: "text/html", status: "ready" }], primaryView: "web", readyViews: ["web"], mediaType: "text/html", readingMinutes: 3, quality, extracted, meta: extracted,
  capture: { byteLength: 20_000, mediaType: "text/html" },
  markdown: "## Concepts\n\nThe API provides a mechanism for styling arbitrary text ranges on a document by using JavaScript.\n\n## Usage\n\nMore words follow here.",
};
const packaged: RenderingFeedback = {
  id: "fb9", createdAt: "2026-10-13T09:00:00.000Z", materialId: ID, url: material.url, title: material.title, view: "web", kinds: [], note: "", app: { version: "test", platform: "darwin", normalize: "0.1" },
  quality, problems: [], capture: { included: true }, bundleDir: "/data/feedback/fb9",
  package: { zipPath: "/data/feedback/fb9/quire-report-css-fb9.zip", zipBytes: 2_000_000, screenshots: [], issueOpened: true, revealed: true, copiedToClipboard: true, warnings: [] },
};
const WINDOW_BOX = { top: 52, bottom: 852, left: 240, right: 1240, width: 1000, height: 800, x: 240, y: 52, toJSON: () => undefined };
const PASSAGE_BOX = { top: 400.4, bottom: 420.6, left: 500.2, right: 619.5, width: 119.3, height: 20.2, x: 500.2, y: 400.4, toJSON: () => undefined };

async function mount() {
  api.read = mockRead({
    platform: "darwin",
    getMaterial: vi.fn(async () => material), listAnnotations: vi.fn(async () => []), resolveImage: vi.fn(async (url: string) => url),
    feedbackSubmit: vi.fn(async () => packaged),
  });
  const view = render(<MaterialReader id={ID} onOpenLink={() => undefined} onOpenMaterial={() => undefined} />);
  await act(async () => { await flush(); await flush(); });
  return view;
}

function selectInBody(text: string) {
  const paragraph = [...document.querySelectorAll("p")].find((element) => element.textContent?.includes(text))!;
  const node = paragraph.firstChild!;
  const start = node.textContent!.indexOf(text);
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, start + text.length);
  act(() => { document.getSelection()?.removeAllRanges(); document.getSelection()?.addRange(range); document.dispatchEvent(new Event("selectionchange")); });
}
const pressShortcut = async () => { await act(async () => { fireEvent.keyDown(document.body, { key: "®", code: "KeyR", metaKey: true, altKey: true }); await flush(); }); };
const panel = () => screen.getByRole("dialog", { name: "Report a problem" });
const submit = async () => { await act(async () => { fireEvent.click(within(panel()).getByRole("button", { name: "Report" })); await flush(); await flush(); }); };

beforeEach(() => {
  localStorage.clear();
  setReadingPrefs(DEFAULT_PREFS);
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { callback(0); return 1; });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
  vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => undefined);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => WINDOW_BOX as DOMRect);
  Object.defineProperty(Range.prototype, "getBoundingClientRect", { configurable: true, value: () => PASSAGE_BOX as DOMRect });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); document.getSelection()?.removeAllRanges(); });

describe("isReportShortcut", () => {
  it("is ⌥⌘R (or Ctrl+Alt+R) by the physical key, never ⌘⇧R or a plain R", () => {
    const event = (init: Partial<KeyboardEvent>) => ({ metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, code: "KeyR", ...init });
    expect(isReportShortcut(event({ metaKey: true, altKey: true }))).toBe(true);
    expect(isReportShortcut(event({ ctrlKey: true, altKey: true }))).toBe(true);
    expect(isReportShortcut(event({ metaKey: true, shiftKey: true }))).toBe(false);
    expect(isReportShortcut(event({ metaKey: true, altKey: true, shiftKey: true }))).toBe(false);
    expect(isReportShortcut(event({ metaKey: true }))).toBe(false);
    expect(isReportShortcut(event({ altKey: true }))).toBe(false);
  });
});

describe("Reporting from the reader", () => {
  it("⌥⌘R opens the panel, and the report carries the reader's viewport and the reading settings", async () => {
    await mount();
    expect(screen.queryByRole("dialog")).toBeNull();
    await pressShortcut();
    expect(panel()).toBeTruthy();
    expect(within(panel()).queryByRole("figure", { name: "Selected passage" })).toBeNull();
    await submit();
    expect(api.read.feedbackSubmit).toHaveBeenCalledWith({
      materialId: ID, view: "web", kinds: [], note: "", includeCapture: true,
      viewport: { x: 240, y: 52, width: 1000, height: 800, scrollFraction: expect.any(Number) as number },
      prefs: DEFAULT_PREFS,
    });
    expect(screen.getByRole("heading", { name: "Report packaged" })).toBeTruthy();
  });

  it("⌥⌘R with text selected attaches it, with its context from the locator and its box widened to whole pixels", async () => {
    await mount();
    selectInBody("styling arbitrary text ranges");
    await pressShortcut();
    expect(within(panel()).getByRole("figure", { name: "Selected passage" }).textContent).toContain("styling arbitrary text ranges");
    // Taken off the page, so neither the selection nor its toolbar is in the screenshot of the reader.
    expect(document.getSelection()?.toString()).toBe("");
    expect(screen.queryByRole("toolbar", { name: "Selection" })).toBeNull();
    await submit();
    const draft = vi.mocked(api.read.feedbackSubmit).mock.calls[0]![0];
    expect(draft.selection?.quote).toBe("styling arbitrary text ranges");
    // The locator's context is the canonical (whitespace-free) text around the quote.
    expect(draft.selection?.prefix).toMatch(/mechanismfor$/);
    expect(draft.selection?.suffix).toMatch(/^onadocument/);
    expect(draft.selection?.rect).toEqual({ x: 500, y: 400, width: 120, height: 21 });
  });

  it("Report in the selection toolbar opens the panel with the passage attached", async () => {
    await mount();
    selectInBody("More words follow");
    await act(async () => { await flush(); });
    const toolbar = screen.getByRole("toolbar", { name: "Selection" });
    await act(async () => { fireEvent.click(within(toolbar).getByRole("button", { name: "Report" })); await flush(); });
    expect(within(panel()).getByRole("figure", { name: "Selected passage" }).textContent).toContain("More words follow");
    await submit();
    expect(vi.mocked(api.read.feedbackSubmit).mock.calls[0]![0].selection).toMatchObject({ quote: "More words follow", rect: { x: 500, y: 400, width: 120, height: 21 } });
  });

  it("the quality pill's Report rendering problem… opens the same panel, without a passage", async () => {
    await mount();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /^Quality:/ })); await flush(); });
    await act(async () => { fireEvent.click(screen.getByRole("menuitem", { name: "Report rendering problem…" })); await flush(); });
    expect(panel()).toBeTruthy();
    expect(within(panel()).queryByRole("figure", { name: "Selected passage" })).toBeNull();
  });
});
