// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SelectionToolbar, TOOLBAR_GAP, placeToolbar } from "./SelectionToolbar";

const box = { top: 100, bottom: 700, left: 200, width: 800, height: 600 };
const bar = { width: 296, height: 44 };
const rect = (top: number, height = 20, left = 500, width = 120) => ({ top, bottom: top + height, left, width, height });

afterEach(cleanup);

describe("placeToolbar", () => {
  it("stands above the selection with a clear gap, centred on it", () => {
    const placed = placeToolbar(rect(400), box, bar);
    expect(placed).toEqual({ top: 400 - 100 - (44 + TOOLBAR_GAP), left: 300 + 60, side: "above" });
  });
  it("drops below a selection on the first lines, where above would leave the frame", () => {
    const placed = placeToolbar(rect(130), box, bar);
    expect(placed).toEqual({ top: 150 - 100 + TOOLBAR_GAP, left: 360, side: "below" });
  });
  it("keeps the bar inside the frame horizontally", () => {
    expect(placeToolbar(rect(400, 20, 210, 40), box, bar)?.left).toBe(bar.width / 2 + 4);
    expect(placeToolbar(rect(400, 20, 950, 40), box, bar)?.left).toBe(800 - bar.width / 2 - 4);
  });
  it("hides for a selection scrolled out of the frame", () => {
    expect(placeToolbar(rect(20), box, bar)).toBeUndefined();
    expect(placeToolbar(rect(720), box, bar)).toBeUndefined();
  });
});

describe("SelectionToolbar", () => {
  beforeEach(() => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { callback(0); return 1; });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
  });
  afterEach(() => { vi.restoreAllMocks(); document.getSelection()?.removeAllRanges(); });

  function mount(selectionTop: number) {
    const frame = document.createElement("div");
    frame.getBoundingClientRect = () => ({ ...box, right: 1000, x: 200, y: 100, toJSON: () => undefined }) as DOMRect;
    const paragraph = document.createElement("p");
    paragraph.textContent = "Some words to select in the article body.";
    frame.append(paragraph);
    document.body.append(frame);
    // jsdom's Range has no layout: the selection rectangle is stubbed per test.
    Object.defineProperty(Range.prototype, "getBoundingClientRect", { configurable: true, value: () => ({ ...rect(selectionTop), right: 620, x: 500, y: selectionTop, toJSON: () => undefined }) as DOMRect });
    const capture = vi.fn(() => ({ locator: "text-quote:v2:x", quote: "words to select" }));
    render(<SelectionToolbar root={frame} viewport={frame} capture={capture} onHighlight={vi.fn()} onNote={vi.fn()} onCopy={vi.fn()} onAsk={vi.fn()} />);
    const range = document.createRange();
    range.setStart(paragraph.firstChild!, 5);
    range.setEnd(paragraph.firstChild!, 20);
    act(() => { document.getSelection()?.addRange(range); document.dispatchEvent(new Event("selectionchange")); });
    return screen.getByRole("toolbar", { name: "Selection" });
  }

  it("places the bar above a selection in the middle of the page", () => {
    const toolbar = mount(400);
    expect(toolbar.getAttribute("data-side")).toBe("above");
    expect(toolbar.style.top).toBe(`${400 - 100 - (44 + TOOLBAR_GAP)}px`);
  });
  it("places the bar below a selection on the first line", () => {
    const toolbar = mount(110);
    expect(toolbar.getAttribute("data-side")).toBe("below");
    expect(toolbar.style.top).toBe(`${130 - 100 + TOOLBAR_GAP}px`);
  });
});
