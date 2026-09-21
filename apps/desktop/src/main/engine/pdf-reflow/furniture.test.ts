import { describe, expect, it } from "vitest";
import { isPageNumber, isWatermark, removeFurniture, withoutMarkers } from "./furniture";
import { column, line, pageOf } from "./testing";

describe("removeFurniture", () => {
  it("drops running heads and page numbers that repeat at the same place on three or more pages", () => {
    const pages = [1, 2, 3, 4].map((n) => pageOf([
      line({ text: "Coding Agents with an Obstacle-Aware Harness", x: 108, y: 30, w: 233 }),
      ...column(72, 100, 450, 10, { page: n }),
      line({ text: `${n}`, x: 300, y: 770, w: 6 }),
      line({ text: `Preprint ${n}/4`, x: 400, y: 772, w: 60 }),
    ], n));
    const result = removeFurniture(pages);
    expect(result.removed).toBe(12);
    expect(result.pages.every((page) => page.lines.length === 10)).toBe(true);
  });

  it("keeps a heading that sits near the top of one page only", () => {
    const pages = [pageOf([line({ text: "Attention is not all you need", x: 72, y: 60, w: 295, size: 24 })]), pageOf([line({ text: "Second page", x: 72, y: 60, w: 200, size: 24 })], 2)];
    const result = removeFurniture(pages);
    expect(result.removed).toBe(0);
    expect(result.pages[0]?.lines).toHaveLength(1);
  });

  it("drops the arXiv margin watermark and bare page numbers even when they do not repeat", () => {
    const page = pageOf([
      line({ text: "arXiv:2609.20779v1 [cs.CL] 17 Sep 2026", x: 20, y: 300, w: 300, size: 20, rotated: true }),
      line({ text: "— 12 —", x: 290, y: 775, w: 30 }),
      line({ text: "Page 12 of 30", x: 260, y: 20, w: 80 }),
      ...column(72, 100, 450, 5),
    ]);
    expect(isWatermark(page.lines[0]!, page)).toBe(true);
    expect(isPageNumber(page.lines[1]!, page)).toBe(true);
    expect(isPageNumber(page.lines[2]!, page)).toBe(true);
    const result = removeFurniture([page]);
    expect(result.removed).toBe(3);
    expect(result.pages[0]?.lines.map((entry) => entry.text)).not.toContain("— 12 —");
    expect(result.pages[0]?.lines.some((entry) => /^arXiv:/.test(entry.text))).toBe(false);
  });

  it("does not take a rotated axis label in the middle of the page for a watermark", () => {
    const page = pageOf([line({ text: "Accuracy", x: 200, y: 300, w: 60, rotated: true })]);
    expect(isWatermark(page.lines[0]!, page)).toBe(false);
  });
});

describe("withoutMarkers", () => {
  it("drops stray superscript footnote marks but keeps small body-adjacent text", () => {
    const page = pageOf([line({ text: "1", x: 84, y: 695, w: 3, size: 6 }), line({ text: "∗", x: 120, y: 600, w: 4, size: 6 }), line({ text: "a footnote in small type that is real text", x: 72, y: 705, w: 300, size: 9 })]);
    expect(withoutMarkers([page], 11)[0]?.lines.map((entry) => entry.text)).toEqual(["a footnote in small type that is real text"]);
  });
});
