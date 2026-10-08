import { describe, expect, it } from "vitest";
import { brokenImageSources, buildMetrics, countUnmarkedLists, emptyCellTables, classifyOverflow, countDollarMath, countMathErrors, headingChecks, scanRawMarkup, wordCount } from "./metrics";
import type { HeadingFact, OverflowCandidate, PageFacts } from "./page-facts";

const candidate = (over: Partial<OverflowCandidate>): OverflowCandidate => ({ path: "p", parent: -1, width: 800, exceeds: false, overflowX: "visible", scrollWidth: 800, clientWidth: 800, insideClipper: false, ...over });
const heading = (text: string, over: Partial<HeadingFact> = {}): HeadingFact => ({ text, level: 2, inBody: true, generated: false, hasMedia: false, ...over });

describe("scanRawMarkup", () => {
  it("finds each pattern with a short sample", () => {
    const result = scanRawMarkup(["see [docs](https://x.y) and a \\<b\\>", "$$x^2$$ then \\frac{a}{b} and \\begin{align}", "<table> &lt;tag&gt; &amp;amp"]);
    expect(result.samples.map((s) => s.pattern).sort()).toEqual(["$$", "&amp;", "&lt;", "<table", "\\<", "\\begin{", "\\frac", "](http"].sort());
    expect(result.count).toBe(8);
  });

  it("counts a $$…$$ pair once and keeps samples within 120 characters", () => {
    const long = `${"word ".repeat(60)}$$a+b$$${" tail".repeat(60)}`;
    const result = scanRawMarkup([long]);
    expect(result.count).toBe(1);
    expect(result.samples[0]?.text.length).toBeLessThanOrEqual(120);
    expect(result.samples[0]?.text.startsWith("…")).toBe(true);
    expect(result.samples[0]?.text).toContain("$$a+b$$");
  });

  it("finds nothing in clean prose", () => {
    expect(scanRawMarkup(["A < B & C, costs $5."])).toEqual({ count: 0, samples: [] });
  });
});

describe("countDollarMath", () => {
  it("counts TeX-looking $…$ and $$…$$ runs", () => {
    expect(countDollarMath(["let $x$ be", "and $\\alpha_t$ so", "$$\\sum_i x_i$$", "with $a^2 + b^2 = c^2$."])).toBe(4);
  });

  it("does not count money, escaped dollars or plain words between dollars", () => {
    expect(countDollarMath(["costs $5 and $10", "from $5-$10", "\\$x\\$", "$ spaced $", "pay $USD$ now"])).toBe(0);
  });
});

describe("countMathErrors", () => {
  it("adds source-only and erroring reader math, stray error nodes and $…$ text", () => {
    expect(countMathErrors({ math: [{ status: "rendered", error: false }, { status: "source", error: false }, { status: "rendered", error: true }], strayMathErrors: 2, prose: ["a $x$ here"] })).toBe(5);
  });
});

describe("classifyOverflow", () => {
  it("reports elements wider than the column, outermost only", () => {
    const result = classifyOverflow([candidate({ path: "table", exceeds: true, width: 1100 }), candidate({ path: "table > tr", parent: 0, exceeds: true, width: 1100 })]);
    expect(result).toEqual({ count: 1, samples: [{ path: "table", width: 1100 }] });
  });

  it("ignores scroll containers that fit and anything they scroll", () => {
    const result = classifyOverflow([
      candidate({ path: "pre", overflowX: "auto", scrollWidth: 1400, clientWidth: 680 }),
      candidate({ path: "pre > code", parent: 0, exceeds: true, width: 1400, insideClipper: true }),
    ]);
    expect(result.count).toBe(0);
  });

  it("reports a scroll container that is itself too wide, and content clipped with no scrollbar", () => {
    const result = classifyOverflow([
      candidate({ path: "div.wrap", overflowX: "auto", exceeds: true, width: 900 }),
      candidate({ path: "div.box", overflowX: "hidden", scrollWidth: 1200, clientWidth: 680 }),
      candidate({ path: "div.tiny", overflowX: "hidden", scrollWidth: 681, clientWidth: 680 }),
    ]);
    expect(result.samples).toEqual([{ path: "div.wrap", width: 900 }, { path: "div.box [clipped]", width: 1200 }]);
  });
});

describe("headingChecks", () => {
  it("counts empty headings, body headings repeating the title, and body headings without the reader's own", () => {
    const result = headingChecks([heading("My Post", { inBody: false, level: 1 }), heading("my post."), heading(""), heading("", { hasMedia: true }), heading("Intro"), heading("Notes", { generated: true })], "My Post");
    expect(result).toEqual({ empty: 1, duplicateTitle: 1, body: 4 });
  });

  it("discounts the title heading itself when there is no body wrapper", () => {
    expect(headingChecks([heading("T", { inBody: false }), heading("T", { inBody: false })], "T").duplicateTitle).toBe(1);
  });
});

describe("wordCount", () => {
  it("counts Latin words and CJK characters", () => {
    expect(wordCount("hello world 你好")).toBe(4);
  });
});

describe("brokenImageSources", () => {
  it("names proxy failures, then broken real srcs, then unnamed placeholders by alt", () => {
    const images = [
      { src: "", broken: true, label: "A cat" },
      { src: "blob:x", broken: false, label: "" },
      { src: "https://e.com/b.png", broken: true, label: "" },
      { src: "", broken: true, label: "" },
    ];
    expect(brokenImageSources(images, ["https://e.com/a.png"])).toEqual(["https://e.com/a.png", "https://e.com/b.png", "(no src: A cat)"]);
    expect(brokenImageSources(images, [])).toEqual(["https://e.com/b.png", "(no src: A cat)", "(no src)"]);
  });
});

describe("buildMetrics", () => {
  it("assembles RenderMetrics from page facts", () => {
    const facts: PageFacts = {
      found: true, box: { left: 0, top: 0, width: 1280, height: 4000.4 }, documentScrolls: true, documentHeight: 4000, text: "Title\none two three",
      prose: ["one $x$ two"], images: [{ src: "", broken: true, label: "fig" }, { src: "blob:a", broken: false, label: "" }],
      overflow: [candidate({ exceeds: true, path: "img", width: 1300 })], math: [], strayMathErrors: 0,
      headings: [heading("Title", { inBody: false })], counts: { codeBlocks: 1, tables: 2, figures: 3, lists: 4, footnotes: 5 },
      lists: [{ marked: true, items: 3 }, { marked: false, items: 2 }, { marked: false, items: 0 }],
      tables: [{ empty: 0, cells: 6 }, { empty: 9, cells: 12 }],
    };
    expect(buildMetrics(facts, "Title", ["https://e.com/fig.png"])).toEqual({
      images: { total: 2, broken: 1, brokenSrc: ["https://e.com/fig.png"] },
      overflow: { count: 1, samples: [{ path: "img", width: 1300 }] },
      rawMarkup: { count: 0, samples: [] },
      mathErrors: 1, unmarkedLists: 1, emptyCellTables: { count: 1, samples: [{ table: 2, empty: 9, cells: 12 }] }, emptyHeadings: 0, duplicateTitleHeadings: 0,
      counts: { codeBlocks: 1, tables: 2, figures: 3, lists: 4, footnotes: 5, headings: 1, words: 4 },
      height: 4000,
    });
  });
});

describe("list and table facts", () => {
  it("counts only visible lists with items that draw no marker", () => {
    expect(countUnmarkedLists([{ marked: true, items: 4 }, { marked: false, items: 2 }, { marked: false, items: 0 }])).toBe(1);
  });

  it("flags tables with at least 4 body cells of which a quarter or more are empty", () => {
    expect(emptyCellTables([{ empty: 1, cells: 3 }, { empty: 1, cells: 8 }, { empty: 2, cells: 8 }, { empty: 30, cells: 40 }])).toEqual({ count: 2, samples: [{ table: 3, empty: 2, cells: 8 }, { table: 4, empty: 30, cells: 40 }] });
  });
});
