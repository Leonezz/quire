import { describe, expect, it } from "vitest";
import { blocksOfSequence, bodyFontSize, classifyHeadings, joinHyphenated, mergeAcross, numberedDepth } from "./blocks";
import { column, line } from "./testing";
import type { Line, Sequence } from "./types";

const sequenceOf = (lines: Line[], extent: [number, number] = [72, 292]): Sequence => ({ page: lines[0]?.page ?? 1, items: lines.map((entry) => ({ kind: "line", line: entry })), left: extent[0], right: extent[1] });

describe("blocksOfSequence", () => {
  it("merges tightly leaded lines into one paragraph and rejoins hyphenated words", () => {
    const lines = [line({ text: "We provide infor-", x: 72, y: 100, w: 218 }), line({ text: "mation about GPT-", x: 72, y: 112, w: 220 }), line({ text: "5 and its harness.", x: 72, y: 124, w: 100 })];
    const blocks = blocksOfSequence(sequenceOf(lines), 10);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.text).toBe("We provide information about GPT-5 and its harness.");
    expect(blocks[0]?.pieces.map((piece) => piece.text)).toEqual(["We provide infor", "mation about GPT-", "5 and its harness."]);
  });

  it("starts a new paragraph on a wider gap, a first-line indent after a sentence, or a short last line", () => {
    const lines = [
      ...column(72, 100, 220, 3, { text: () => "running text that reaches the right edge of the column here" }),
      line({ text: "ends the paragraph.", x: 72, y: 136, w: 90 }),
      line({ text: "Next paragraph begins flush and keeps going along the line", x: 72, y: 148, w: 220 }),
      line({ text: "continues to the edge of the column and finishes a sentence.", x: 72, y: 160, w: 220 }),
      line({ text: "Indented start of another paragraph in the same column.", x: 84, y: 172, w: 208 }),
      line({ text: "After a gap comes a fourth paragraph on its own.", x: 72, y: 200, w: 200 }),
    ];
    const blocks = blocksOfSequence(sequenceOf(lines), 10);
    expect(blocks.map((block) => block.pieces.length)).toEqual([4, 2, 1, 1]);
    expect(blocks[2]?.indented).toBe(true);
  });

  it("recognises list items and strips their markers", () => {
    const lines = [line({ text: "• first item", x: 72, y: 100, w: 100 }), line({ text: "• second item", x: 72, y: 112, w: 100 }), line({ text: "1. numbered one", x: 72, y: 130, w: 100 }), line({ text: "(a) lettered", x: 72, y: 142, w: 100 })];
    const blocks = blocksOfSequence(sequenceOf(lines), 10);
    expect(blocks.map((block) => [block.kind, block.text, block.ordered])).toEqual([["listItem", "first item", false], ["listItem", "second item", false], ["listItem", "numbered one", true], ["listItem", "lettered", true]]);
  });

  it("keeps a two-line heading together even when its second line hangs indented after a colon", () => {
    const lines = [line({ text: "C Harm Laundering Detection Protocol:", x: 72, y: 100, w: 200, size: 12, bold: true }), line({ text: "Full Specification", x: 92, y: 114, w: 100, size: 12, bold: true }), line({ text: "Body text starts here and runs to the edge of the column", x: 72, y: 136, w: 220 })];
    const blocks = blocksOfSequence(sequenceOf(lines), 10);
    expect(blocks.map((block) => block.text)).toEqual(["C Harm Laundering Detection Protocol: Full Specification", "Body text starts here and runs to the edge of the column"]);
  });

  it("flags short symbol-heavy lines as math but keeps them as paragraphs", () => {
    const blocks = blocksOfSequence(sequenceOf([line({ text: "α = β + γ − ∑ x_i", x: 150, y: 100, w: 80 })]), 10);
    expect(blocks[0]).toMatchObject({ kind: "paragraph", math: true });
  });
});

describe("mergeAcross", () => {
  it("continues a cut-off paragraph into the next column and page, but not a lone short line", () => {
    const first = blocksOfSequence(sequenceOf([line({ text: "The standard metric for safety improvement in", x: 72, y: 700, w: 219 })]), 10);
    const second = blocksOfSequence(sequenceOf([line({ text: "large language models is toxicity score reduction.", x: 310, y: 100, w: 220, page: 2 })], [310, 530]), 10);
    const merged = mergeAcross([...first, ...second]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.text).toBe("The standard metric for safety improvement in large language models is toxicity score reduction.");
    expect(merged[0]?.pieces.map((piece) => piece.line.page)).toEqual([1, 2]);

    const title = blocksOfSequence(sequenceOf([line({ text: "Attention is not all you need", x: 72, y: 72, w: 295, size: 24 })], [72, 367]), 24);
    const next = blocksOfSequence(sequenceOf([line({ text: "Second page: results and discussion", x: 72, y: 72, w: 391, size: 24, page: 2 })], [72, 463]), 24);
    expect(mergeAcross([...title, ...next])).toHaveLength(2);
  });
});

describe("headings", () => {
  const body = column(72, 200, 220, 4);

  it("takes numbering for depth, larger type for the title, and bold short lines followed by prose", () => {
    const lines = [
      line({ text: "Harm Laundering in GPT Models", x: 72, y: 80, w: 453, size: 14.3, bold: true }),
      line({ text: "Abstract", x: 158, y: 120, w: 44, size: 12, bold: true }),
      ...column(88, 140, 186, 3, { text: () => "safety evaluations for large language models rely on classifiers" }),
      line({ text: "2.3 Multi-Classifier Failure", x: 72, y: 180, w: 134, size: 11, bold: true }),
      ...body,
      line({ text: "IV. Discussion", x: 72, y: 260, w: 90, size: 12 }),
      line({ text: "Contributions.", x: 72, y: 290, w: 60, size: 10, bold: true }),
      ...column(72, 302, 220, 2),
    ];
    const blocks = blocksOfSequence(sequenceOf(lines), 10);
    const classified = classifyHeadings(blocks, new Map([[1, 14.3]]), 10);
    expect(classified.filter((block) => block.kind === "heading").map((block) => [block.text, block.depth])).toEqual([
      ["Harm Laundering in GPT Models", 1], ["Abstract", 2], ["2.3 Multi-Classifier Failure", 2], ["IV. Discussion", 1],
    ]);
  });

  it("does not make headings of author lines, bold run-ins or long bold sentences", () => {
    const lines = [
      line({ text: "Sarah Wyer Sue Black Noura Al Moubayed", x: 176, y: 136, w: 247, size: 12, bold: true }),
      line({ text: "Durham University", x: 252, y: 150, w: 92, size: 12 }),
      line({ text: "Harm laundering as a construct-validity failure.", x: 72, y: 200, w: 218, size: 11, bold: true }),
      ...column(72, 214, 220, 3, { size: 11 }),
    ];
    const classified = classifyHeadings(blocksOfSequence(sequenceOf(lines, [72, 526]), 11), new Map([[1, 12]]), 11);
    expect(classified.filter((block) => block.kind === "heading")).toEqual([]);
  });

  it("reads numbered heading depth from dotted numbers, roman numerals and appendix letters", () => {
    expect(numberedDepth("1 Introduction")).toBe(1);
    expect(numberedDepth("2.3 Method")).toBe(2);
    expect(numberedDepth("4.1.2 Details")).toBe(3);
    expect(numberedDepth("IV. Results")).toBe(1);
    expect(numberedDepth("B Hardware")).toBe(1);
    expect(numberedDepth("A completion naming two axes")).toBeUndefined();
    expect(numberedDepth("2021 was the year")).toBeUndefined();
  });
});

describe("helpers", () => {
  it("picks the body size by text volume and joins hyphens only before lowercase continuations", () => {
    expect(bodyFontSize([...column(72, 100, 220, 5), line({ text: "Big", x: 72, y: 50, w: 30, size: 20 })])).toBe(10);
    expect(joinHyphenated("infor-", "mation")).toEqual({ previous: "infor", separator: "" });
    expect(joinHyphenated("GPT-", "5")).toEqual({ previous: "GPT-", separator: "" });
    expect(joinHyphenated("plain", "next")).toEqual({ previous: "plain", separator: " " });
  });
});
