import { describe, expect, it } from "vitest";
import { brokenImageSources, buildMetrics, buildRenderedCode, buildRenderedTables, codeLines, countCollapsedCode, isCollapsedCode, countUnmarkedLists, emptyCellTables, classifyOverflow, countDollarMath, countMathErrors, headingChecks, scanRawMarkup, wordCount } from "./metrics";
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
      prose: ["one $x$ two"], images: [{ src: "", broken: true, label: "fig", original: "", alt: "fig", caption: "", top: 0 }, { src: "blob:a", broken: false, label: "", original: "https://e.com/a.png", alt: "", caption: "", top: 10 }], links: [], media: [],
      overflow: [candidate({ exceeds: true, path: "img", width: 1300 })], math: [], strayMathErrors: 0,
      headings: [heading("Title", { inBody: false })], counts: { codeBlocks: 1, tables: 2, figures: 3, lists: 4, footnotes: 5 },
      lists: [{ marked: true, items: 3 }, { marked: false, items: 2 }, { marked: false, items: 0 }],
      tables: [{ empty: 0, cells: 6, rows: 3, cols: 2, head: "a | b", top: 0 }, { empty: 9, cells: 12, rows: 5, cols: 3, head: "x", top: 0 }],
      code: [{ text: "x".repeat(130), top: 0 }, { text: "a\nb\n", top: 0 }],
    };
    expect(buildMetrics(facts, "Title", ["https://e.com/fig.png"])).toEqual({
      images: { total: 2, broken: 1, brokenSrc: ["https://e.com/fig.png"] },
      overflow: { count: 1, samples: [{ path: "img", width: 1300 }] },
      rawMarkup: { count: 0, samples: [] },
      mathErrors: 1, collapsedCode: 1, unmarkedLists: 1, emptyCellTables: { count: 1, samples: [{ table: 2, empty: 9, cells: 12 }] }, emptyHeadings: 0, duplicateTitleHeadings: 0,
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

describe("code inventory", () => {
  it("counts visible lines without the trailing newline", () => {
    expect(codeLines("a\nb\n")).toBe(2);
    expect(codeLines("a\n\n  \n")).toBe(1);
    expect(codeLines("")).toBe(0);
    expect(codeLines("a\n\nb")).toBe(3);
  });

  it("calls a block collapsed when it shows one line of 100 characters or more", () => {
    const huber = "def huber_loss(x): return 0.5 * x ** 2 if abs(x) < 1 else abs(x) - 0.5 # forward passdx = np.clip(dx, -1, 1) # clip gradients";
    expect(huber.length).toBeGreaterThanOrEqual(100);
    expect(isCollapsedCode(huber)).toBe(true);
    expect(isCollapsedCode(`${huber}\n`)).toBe(true);
    expect(isCollapsedCode("x".repeat(99))).toBe(false);
    expect(isCollapsedCode("x".repeat(100))).toBe(true);
    expect(isCollapsedCode(`${"x".repeat(119)}\ny`)).toBe(false);
    expect(countCollapsedCode([{ text: huber }, { text: "short" }, { text: "a\nb" }])).toBe(1);
  });

  it("ids blocks and keeps the first 80 characters verbatim", () => {
    const text = `  indented  ${"y".repeat(100)}\nnext`;
    expect(buildRenderedCode([{ text, tile: 2 }, { text: "x".repeat(150), tile: null }])).toEqual([
      { id: "c1", tile: 2, lines: 2, chars: text.length, collapsed: false, head: text.slice(0, 80) },
      { id: "c2", tile: null, lines: 1, chars: 150, collapsed: true, head: "x".repeat(80) },
    ]);
  });
});

describe("table inventory", () => {
  it("uses the same cell facts as emptyCellTables, so its table n is t<n>", () => {
    const facts = [
      { empty: 0, cells: 6, rows: 4, cols: 2, head: "Name | Value", tile: 1 },
      { empty: 6, cells: 8, rows: 5, cols: 2, head: `Feature | ${"z".repeat(100)}`, tile: null },
    ];
    const tables = buildRenderedTables(facts);
    expect(tables[0]).toEqual({ id: "t1", tile: 1, rows: 4, cols: 2, cells: 6, emptyCells: 0, head: "Name | Value" });
    expect(tables[1]?.head).toHaveLength(80);
    const flagged = emptyCellTables(facts).samples.map((sample) => `t${sample.table}`);
    expect(flagged).toEqual(["t2"]);
    expect(tables.find((table) => table.id === "t2")?.emptyCells).toBe(6);
  });
});
