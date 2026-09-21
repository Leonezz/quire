import { describe, expect, it } from "vitest";
import { blocksOfSequence } from "../blocks";
import { line } from "../testing";
import type { Line, Sequence } from "../types";
import { mergeSplitTitles } from "./split-titles";

const sequenceOf = (lines: Line[]): Sequence => ({ page: lines[0]?.page ?? 1, items: lines.map((entry) => ({ kind: "line", line: entry })), left: 72, right: 528 });

describe("mergeSplitTitles", () => {
  it("joins consecutive one-word bold or large lines on page 1 into one block, and leaves everything else alone", () => {
    const lines = [
      line({ text: "STRAIN", x: 200, y: 100, w: 60, size: 14, bold: true }), line({ text: "OF", x: 220, y: 116, w: 20, size: 14, bold: true }), line({ text: "FORCES", x: 200, y: 132, w: 60, size: 14, bold: true }),
      line({ text: "By A. Author", x: 200, y: 170, w: 80, size: 10 }),
      line({ text: "SUMMARY", x: 200, y: 300, w: 70, size: 14, bold: true }), line({ text: "The plate is loaded in its own plane and buckles.", x: 72, y: 330, w: 300, size: 10 }),
    ];
    // Each line lands in its own block: the font changes and the leading is wide.
    const blocks = lines.map((entry) => blocksOfSequence(sequenceOf([entry]), 10)).flat();
    const merged = mergeSplitTitles(blocks, 10);
    expect(merged.map((block) => block.text)).toEqual(["STRAIN OF FORCES", "By A. Author", "SUMMARY", "The plate is loaded in its own plane and buckles."]);
    expect(merged[0]?.pieces.map((piece) => piece.text)).toEqual(["STRAIN", " OF", " FORCES"]);
    // Not on page 1, or further apart than a line, or body-sized regular words: untouched.
    const page2 = blocks.map((block) => ({ ...block, page: 2, pieces: block.pieces.map((piece) => ({ ...piece, line: { ...piece.line, page: 2 } })) }));
    expect(mergeSplitTitles(page2, 10)).toHaveLength(6);
    const apart = [blocks[0]!, { ...blocks[1]!, pieces: [{ ...blocks[1]!.pieces[0]!, line: { ...blocks[1]!.pieces[0]!.line, baseline: 200 } }] }];
    expect(mergeSplitTitles(apart, 10)).toHaveLength(2);
  });
});
