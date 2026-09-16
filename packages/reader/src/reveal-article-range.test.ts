import { afterEach, describe, expect, it, vi } from "vitest";
import { revealArticleRangeHorizontally } from "./reveal-article-range";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function scrollable(element: HTMLElement, width = 240, boxLeft = 100) {
  element.style.overflowX = "auto";
  Object.defineProperties(element, {
    clientLeft: { configurable: true, value: 1 },
    clientWidth: { configurable: true, value: width },
    scrollWidth: { configurable: true, value: 1_400 },
    scrollTo: {
      configurable: true,
      value: vi.fn(({ left }: ScrollToOptions) => {
        element.scrollLeft = Math.max(0, Math.min(1_400 - width, left ?? element.scrollLeft));
      }),
    },
  });
  vi.spyOn(element, "getBoundingClientRect")
    .mockImplementation(() => new DOMRect(boxLeft, 0, width + 2, 80));
  return element;
}

function fixture() {
  const outside = scrollable(document.createElement("div"), 800, 0);
  const body = document.createElement("article");
  const pre = scrollable(document.createElement("pre"));
  const code = document.createElement("code");
  code.textContent = "conditional_cache_revalidation";
  pre.append(code);
  body.append(pre);
  outside.append(body);
  document.body.append(outside);
  const range = document.createRange();
  range.selectNodeContents(code.firstChild!);
  Object.defineProperty(range, "getBoundingClientRect", {
    configurable: true,
    value: vi.fn(() => new DOMRect(900 - pre.scrollLeft, 20, 60, 18)),
  });
  return { body, code, outside, pre, range };
}

describe("revealArticleRangeHorizontally", () => {
  it("reveals right-clipped text and remembers only the scroller it moved", () => {
    const { body, outside, pre, range } = fixture();
    pre.scrollLeft = 80;
    outside.scrollLeft = 50;
    const originalContent = body.innerHTML;

    expect(revealArticleRangeHorizontally(body, range))
      .toEqual([{ element: pre, left: 80 }]);
    expect(pre.scrollLeft).toBe(643);
    expect(range.getBoundingClientRect().right).toBe(317);
    expect(outside.scrollTo).not.toHaveBeenCalled();
    expect(outside.scrollLeft).toBe(50);
    expect(body.innerHTML).toBe(originalContent);
  });

  it("reveals text clipped on the left without changing the vertical position", () => {
    const { body, pre, range } = fixture();
    pre.scrollLeft = 1_000;
    pre.scrollTop = 180;

    expect(revealArticleRangeHorizontally(body, range))
      .toEqual([{ element: pre, left: 1_000 }]);
    expect(range.getBoundingClientRect().left).toBe(125);
    expect(pre.scrollTop).toBe(180);
  });

  it("leaves already-visible quotes alone", () => {
    const { body, pre, range } = fixture();
    pre.scrollLeft = 750;
    expect(revealArticleRangeHorizontally(body, range)).toEqual([]);
    expect(pre.scrollTo).not.toHaveBeenCalled();
  });

  it("aligns the start of a quote wider than the available reading area", () => {
    const { body, pre, range } = fixture();
    vi.spyOn(range, "getBoundingClientRect")
      .mockImplementation(() => new DOMRect(900 - pre.scrollLeft, 20, 600, 18));

    revealArticleRangeHorizontally(body, range);
    expect(range.getBoundingClientRect().left).toBe(125);
  });

  it("remeasures the quote after moving each nested scroller", () => {
    const { body, pre, range } = fixture();
    const outer = scrollable(document.createElement("div"), 400, 50);
    body.replaceChildren(outer);
    outer.append(pre);
    // A live Range is reset when its nodes are detached; locate after nesting.
    range.selectNodeContents(pre.querySelector("code")!.firstChild!);
    pre.scrollLeft = 80;
    outer.scrollLeft = 90;
    vi.spyOn(pre, "getBoundingClientRect")
      .mockImplementation(() => new DOMRect(700 - outer.scrollLeft, 0, 242, 80));
    vi.spyOn(range, "getBoundingClientRect")
      .mockImplementation(() => new DOMRect(1_500 - pre.scrollLeft - outer.scrollLeft, 20, 60, 18));

    expect(revealArticleRangeHorizontally(body, range)).toEqual([
      { element: pre, left: 80 },
      { element: outer, left: 90 },
    ]);
    expect(range.getBoundingClientRect().right).toBe(427);
    expect(range.getBoundingClientRect().left)
      .toBeGreaterThanOrEqual(pre.getBoundingClientRect().left + pre.clientLeft);
  });

  it("handles element-based ranges without escaping the reader body", () => {
    const { body, outside, pre, range } = fixture();
    range.selectNodeContents(pre);
    expect(revealArticleRangeHorizontally(body, range))
      .toEqual([{ element: pre, left: 0 }]);

    range.selectNodeContents(body);
    expect(revealArticleRangeHorizontally(body, range)).toEqual([]);
    expect(outside.scrollTo).not.toHaveBeenCalled();
  });

  it("ignores detached, outside, hidden and non-scrollable content", () => {
    const { body, pre, range } = fixture();
    body.remove();
    expect(revealArticleRangeHorizontally(body, range)).toEqual([]);
    document.body.append(body);
    expect(revealArticleRangeHorizontally(document.createElement("article"), range)).toEqual([]);
    const otherBody = document.createElement("article");
    document.body.append(otherBody);
    expect(revealArticleRangeHorizontally(otherBody, range)).toEqual([]);

    pre.style.overflowX = "hidden";
    expect(revealArticleRangeHorizontally(body, range)).toEqual([]);
    pre.style.overflowX = "auto";
    vi.spyOn(range, "getBoundingClientRect").mockReturnValue(new DOMRect());
    expect(revealArticleRangeHorizontally(body, range)).toEqual([]);
    expect(pre.scrollTo).not.toHaveBeenCalled();
  });

  it("does not use a cross-block range to scroll only its first fragment", () => {
    const { body, pre, range } = fixture();
    const paragraph = document.createElement("p");
    paragraph.textContent = "Explanation outside the code block";
    body.append(paragraph);
    range.setEnd(paragraph.firstChild!, 10);
    expect(revealArticleRangeHorizontally(body, range)).toEqual([]);
    expect(pre.scrollTo).not.toHaveBeenCalled();
  });
});
