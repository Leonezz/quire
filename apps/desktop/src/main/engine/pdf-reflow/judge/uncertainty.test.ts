import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildTextView } from "../index";
import { column, line, PAGE } from "../testing";
import { blocksOfSequence, classifyHeadings, type Block } from "../blocks";
import type { PageLayout } from "../columns";
import type { Line, Sequence } from "../types";
import { RulesJudge } from "./rules";
import type { BlockJudge, JudgePage } from "./types";
import { isCertain, isRunIn, judgePagesOf, type UncertaintyContext } from "./uncertainty";
import { wordCountOf } from "../types";

const fixture = (name: string) => readFile(join(__dirname, "..", "..", "__fixtures__", name)).then((buffer) => new Uint8Array(buffer));
const sink = { write: async (id: string, index: number) => `quire-figure://${id}/${index}.png` };

/** The rules judge, remembering what it was asked. */
function recordingJudge(): BlockJudge & { pages: JudgePage[] } {
  const rules = new RulesJudge();
  const recorder: BlockJudge & { pages: JudgePage[] } = { provider: "rules", pages: [], judge: async (pages) => { recorder.pages = [...pages]; return rules.judge(pages); } };
  return recorder;
}

const sequenceOf = (lines: Line[], extent: [number, number] = [72, 292]): Sequence => ({ page: lines[0]?.page ?? 1, items: lines.map((entry) => ({ kind: "line", line: entry })), left: extent[0], right: extent[1] });
const layout: PageLayout = { page: 1, bands: [], columns: 1, extents: [[72, 528]] };
const context: UncertaintyContext = { bodySize: 10, sizes: new Map([[1, PAGE], [2, PAGE]]), layouts: new Map([[1, layout], [2, { ...layout, page: 2 }]]) };
const prose = (index: number) => ["The standard metric for safety improvement in large language", "models is toxicity score reduction, which we argue rewards", "a laundering of harm into forms the classifiers do not see", "and which the paper measures across four model generations."][index % 4]!;
const blocksOf = (lines: Line[]) => classifyHeadings(blocksOfSequence(sequenceOf(lines), 10), new Map([[1, 24], [2, 12]]), 10);

describe("isCertain", () => {
  it("is sure of long body-sized prose in the middle of a page, and of numbered headings and captioned figures", () => {
    const [paragraph] = blocksOf(column(72, 300, 220, 6, { page: 2, text: prose }));
    expect(isCertain(paragraph!, context, [undefined, undefined])).toBe(true);
    const [heading] = blocksOf([line({ text: "3.2 Positional Encoding", x: 72, y: 300, w: 150, size: 12, bold: true, page: 2 })]);
    expect(heading?.kind).toBe("heading");
    expect(isCertain(heading!, context, [undefined, undefined])).toBe(true);
    const caption: Block = { kind: "figure", page: 2, pieces: [], text: "Figure 1: The model.", fontSize: 9, bold: false, indented: false, centred: false, endsSentence: true, fullLast: false, math: false, region: { page: 2, kind: "figure", rect: { x: 72, y: 100, w: 220, h: 100 }, caption: [line({ text: "Figure 1: The model.", x: 72, y: 210, w: 100, page: 2 })], consumed: [] } };
    expect(isCertain(caption, context, [undefined, undefined])).toBe(true);
    expect(isCertain({ ...caption, text: "", region: { ...caption.region!, caption: [] } }, context, [undefined, undefined])).toBe(false);
  });

  it("doubts short lines, short bold blocks, unnumbered headings, page edges, first-page front matter, figure neighbours and equation numbers", () => {
    const short = blocksOf([line({ text: "Proceedings of the conference", x: 72, y: 300, w: 150, page: 2 })])[0]!;
    expect(isCertain(short, context, [undefined, undefined])).toBe(false);
    const boldPair = blocksOf([...column(72, 300, 220, 2, { page: 2, text: (index) => `${prose(index)} and then some words more` }).map((entry) => ({ ...entry, bold: true }))])[0]!;
    expect(wordCountOf(boldPair.text)).toBeGreaterThanOrEqual(25);
    expect(isCertain(boldPair, context, [undefined, undefined])).toBe(false);
    // A long paragraph whose font the extractor flagged bold is prose all the same.
    const boldLong = blocksOf([...column(72, 300, 220, 6, { page: 2, text: prose }).map((entry) => ({ ...entry, bold: true }))])[0]!;
    expect(isCertain(boldLong, context, [undefined, undefined])).toBe(true);
    const unnumbered = blocksOf([line({ text: "Related Work", x: 72, y: 300, w: 150, size: 14, page: 2 }), ...column(72, 320, 220, 3, { page: 2, text: prose })])[0]!;
    expect(unnumbered.kind).toBe("heading");
    expect(isCertain(unnumbered, context, [undefined, undefined])).toBe(false);
    const footer = blocksOf(column(72, 740, 220, 2, { page: 2, text: (index) => `${prose(index)} and then some words more` }))[0]!;
    expect(isCertain(footer, context, [undefined, undefined])).toBe(false);
    expect(isCertain(blocksOf(column(72, 740, 220, 3, { page: 2, text: prose }))[0]!, context, [undefined, undefined])).toBe(true);
    const front = blocksOf(column(72, 100, 220, 6, { page: 1, text: prose }))[0]!;
    expect(isCertain(front, context, [undefined, undefined])).toBe(false);
    const body = blocksOf(column(72, 300, 220, 4, { page: 2, text: prose }))[0]!;
    const figure: Block = { ...body, kind: "figure", region: { page: 2, kind: "table", rect: { x: 0, y: 0, w: 1, h: 1 }, caption: [], consumed: [] } };
    expect(isCertain(body, context, [figure, undefined])).toBe(false);
    expect(isCertain(blocksOf(column(72, 300, 220, 8, { page: 2, text: prose }))[0]!, context, [figure, undefined])).toBe(true);
    const equation = blocksOf([...column(72, 300, 220, 6, { page: 2, text: (index) => (index === 0 ? "(1) where the loss is the sum over tokens of the" : prose(index)) })])[0]!;
    expect(isCertain(equation, context, [undefined, undefined])).toBe(false);
  });

  it("is sure of multi-line entries under a References line even though they read as names, not prose", () => {
    const entry = (index: number) => ["Emily M Bender, Timnit Gebru, Angelina McMillan-Major, and Shmargaret", "Shmitchell. 2021. On the Dangers of Stochastic Parrots. In FAccT."][index % 2]!;
    const blocks = blocksOf([line({ text: "References", x: 72, y: 100, w: 60, size: 11, bold: true, page: 2 }), ...column(72, 130, 220, 2, { page: 2, text: entry })]);
    const pages = judgePagesOf(blocks, context);
    expect(pages[0]!.blocks.map((block) => block.certain)).toEqual([false, true]);
    expect(isCertain(blocks[1]!, context, [undefined, undefined])).toBe(false);
  });

  it("flags run-in phrases: a bold lead span, or a bold first line followed by regular lines, but not a bold block", () => {
    const lead = blocksOf([{ ...line({ text: "Identity vs. Projection Shortcuts. We have shown that", x: 72, y: 300, w: 220, page: 2 }), boldLead: true }])[0]!;
    expect(isRunIn(lead)).toBe(true);
    const mixed: Block = { ...lead, pieces: [{ line: line({ text: "Ablation.", x: 72, y: 300, w: 60, page: 2, bold: true }), text: "Ablation." }, { line: line({ text: "We remove parts.", x: 72, y: 312, w: 100, page: 2 }), text: " We remove parts." }], text: "Ablation. We remove parts.", bold: false };
    expect(isRunIn(mixed)).toBe(true);
    expect(isRunIn({ ...mixed, bold: true })).toBe(false);
    expect(judgePagesOf([lead], context)[0]!.blocks[0]!.runIn).toBe(true);
  });

  it("describes blocks with their column, position, size and head, grouped by page", () => {
    const pages = judgePagesOf(blocksOf([line({ text: "3.2 Positional Encoding", x: 72, y: 300, w: 150, size: 12, bold: true, page: 2 }), ...column(72, 320, 220, 6, { page: 2, text: prose })]), context);
    expect(pages).toHaveLength(1);
    expect(pages[0]!.page).toBe(2);
    expect(pages[0]!.blocks.map((block) => [block.id, block.kind, block.certain])).toEqual([["b0", "heading", true], ["b1", "body", true]]);
    expect(pages[0]!.blocks[0]).toMatchObject({ column: 0, columns: 1, y: 0.375, sizeRatio: 1.2, bold: true, lines: 1, words: 3, head: "3.2 Positional Encoding" });
    expect(pages[0]!.blocks[1]!.head.length).toBeLessThanOrEqual(160);
  });
});

describe("gating on a real paper", () => {
  it("asks the judge about at most a quarter of the blocks of the two-column arXiv fixture", async () => {
    const judge = recordingJudge();
    const content = await buildTextView(await fixture("arxiv-two-column.pdf"), "8667175ac66aac06", { figures: sink, judge });
    const blocks = judge.pages.flatMap((page) => page.blocks);
    const asked = blocks.filter((block) => !block.certain);
    expect(blocks.length).toBeGreaterThan(200);
    expect(asked.length / blocks.length).toBeLessThanOrEqual(0.25);
    // Numbered headings and long prose are never asked about; the title, the authors and the abstract label are.
    expect(asked.some((block) => /^1 Introduction/.test(block.head))).toBe(false);
    expect(asked.some((block) => block.kind === "body" && block.words >= 80 && block.y > 0.12 && block.y < 0.88 && block.page > 1)).toBe(false);
    expect(asked.some((block) => block.page === 1 && /Harm Laundering/.test(block.head))).toBe(true);
    // The rules judge changes nothing: the report is the rules' own.
    expect(content.report?.judged).toBeUndefined();
  }, 60_000);
});
