import { describe, expect, it } from "vitest";
import { blocksOfSequence, classifyHeadings, type Block } from "../blocks";
import { column, line, PAGE } from "../testing";
import type { Line, Sequence } from "../types";
import { applyVerdicts, type ApplyContext } from "./apply";
import type { JudgeVerdict } from "./types";

const sequenceOf = (lines: Line[], extent: [number, number] = [72, 292]): Sequence => ({ page: lines[0]?.page ?? 1, items: lines.map((entry) => ({ kind: "line", line: entry })), left: extent[0], right: extent[1] });
const context: ApplyContext = { bodySize: 10, sizes: new Map([[1, PAGE], [2, PAGE]]) };
const prose = (index: number) => ["The standard metric for safety improvement in large language", "models is toxicity score reduction, which we argue rewards", "a laundering of harm into forms the classifiers do not see", "and which the paper measures across four model generations."][index % 4]!;
const blocksOf = (...groups: Line[][]) => classifyHeadings(groups.flatMap((lines) => blocksOfSequence(sequenceOf(lines), 10)), new Map([[1, 24], [2, 12]]), 10);

describe("applyVerdicts", () => {
  const blocks = blocksOf(
    [line({ text: "Proceedings of the Conference on Reading, 2026", x: 72, y: 20, w: 200, page: 1 })],
    [line({ text: "Related Work", x: 72, y: 100, w: 90, size: 10, page: 1 })],
    column(72, 120, 220, 4, { page: 1, text: prose }),
    [line({ text: "Model  Acc  F1", x: 72, y: 200, w: 120, page: 1 }), line({ text: "Ours   0.91 0.88", x: 72, y: 212, w: 120, page: 1 })],
    [line({ text: "1 Work done while at the university.", x: 72, y: 740, w: 180, page: 1 })],
    column(72, 100, 220, 3, { page: 2, text: prose }),
  );

  it("changes nothing without confident, differing verdicts", () => {
    const same: JudgeVerdict[] = blocks.map((_block, index) => ({ id: `b${index}`, kind: "body", confidence: 0.5 }));
    expect(applyVerdicts(blocks, same, context)).toEqual({ blocks, changed: 0, furnitureLines: 0 });
    expect(applyVerdicts(blocks, [{ id: "b0", kind: "furniture", confidence: 0.74 }], context).changed).toBe(0);
    expect(() => applyVerdicts(blocks, [{ id: "b99", kind: "furniture", confidence: 0.9 }], context)).toThrow(/never sent to the judge/);
  });

  it("drops furniture, promotes a heading, crops a table, and moves a footnote to the end of its page", () => {
    const verdicts: JudgeVerdict[] = [
      { id: "b0", kind: "furniture", confidence: 0.92 },
      { id: "b1", kind: "heading", confidence: 0.88 },
      { id: "b3", kind: "table", confidence: 0.8 },
      { id: "b4", kind: "footnote", confidence: 0.95 },
    ];
    const result = applyVerdicts(blocks, verdicts, context);
    expect(result.changed).toBe(4);
    expect(result.furnitureLines).toBe(1);
    expect(result.blocks.map((block) => [block.kind, block.page, block.role ?? "", block.text.slice(0, 12)])).toEqual([
      ["heading", 1, "", "Related Work"], ["paragraph", 1, "", "The standard"], ["figure", 1, "", ""], ["paragraph", 1, "footnote", "1 Work done "], ["paragraph", 2, "", "The standard"],
    ]);
    expect(result.blocks[0]?.depth).toBe(2);
    const table = result.blocks[2]!;
    expect(table.region).toMatchObject({ kind: "table", page: 1, caption: [] });
    expect(table.region?.consumed.map((entry) => entry.text)).toEqual(["Model  Acc  F1", "Ours   0.91 0.88"]);
    // The crop rect is the lines' union, padded a little, in page points.
    expect(table.region?.rect.y).toBeLessThan(200);
    expect(table.region!.rect.y + table.region!.rect.h).toBeGreaterThan(222);
  });

  it("merges a block that continues the previous one, rejoining a hyphen", () => {
    const first = blocksOf([line({ text: "The standard metric for safety improve-", x: 72, y: 700, w: 219 })]);
    const second = blocksOf([line({ text: "ment in large language models is toxicity score reduction.", x: 310, y: 100, w: 220, page: 2 })]);
    const all = [...first, ...second];
    const result = applyVerdicts(all, [{ id: "b1", kind: "body", confidence: 0.3, continues: 0.85 }], context);
    expect(result.changed).toBe(1);
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]?.text).toBe("The standard metric for safety improvement in large language models is toxicity score reduction.");
    expect(applyVerdicts(all, [{ id: "b1", kind: "body", confidence: 0.3, continues: 0.79 }], context).blocks).toHaveLength(2);
  });

  it("refuses a heading verdict for a run-in phrase and for multi-line prose, and a furniture verdict for long text mid-page", () => {
    const runIn = blocksOf([{ ...line({ text: "Identity vs. Projection Shortcuts. We have shown that", x: 72, y: 300, w: 220, page: 2 }), boldLead: true }]);
    expect(applyVerdicts(runIn, [{ id: "b0", kind: "heading", confidence: 0.95 }], context)).toEqual({ blocks: runIn, changed: 0, furnitureLines: 0 });
    const boldFirst = blocksOf([line({ text: "Ablation study.", x: 72, y: 300, w: 80, page: 2, bold: true }), line({ text: "We remove each component in turn and report the change.", x: 72, y: 312, w: 220, page: 2 })]);
    expect(boldFirst).toHaveLength(2);
    const paragraph = blocksOf(column(72, 300, 220, 4, { page: 2, text: prose }));
    expect(applyVerdicts(paragraph, [{ id: "b0", kind: "heading", confidence: 0.95 }], context).changed).toBe(0);
    const wholeBold = blocksOf([line({ text: "Related Work", x: 72, y: 300, w: 80, page: 2, bold: true })]);
    expect(applyVerdicts(wholeBold, [{ id: "b0", kind: "heading", confidence: 0.95 }], context).blocks[0]?.kind).toBe("heading");
    const toc = blocksOf([line({ text: "4.3.4. Freshening Stored Responses upon Validation of the cache entry after a conditional request has been made", x: 72, y: 300, w: 400, page: 2 })]);
    expect(applyVerdicts(toc, [{ id: "b0", kind: "furniture", confidence: 0.95 }], context).changed).toBe(0);
    const foot = blocksOf([line({ text: "4.3.4. Freshening Stored Responses upon Validation of the cache entry after a conditional request has been made", x: 72, y: 760, w: 400, page: 2 })]);
    expect(applyVerdicts(foot, [{ id: "b0", kind: "furniture", confidence: 0.95 }], context).changed).toBe(1);
  });

  it("merges table rows the judge marked one by one into one crop and gives it the nearest Table caption", () => {
    const rows = [
      [line({ text: "Model  Acc  F1", x: 72, y: 200, w: 120, page: 1 })],
      [line({ text: "Ours   0.91 0.88", x: 72, y: 213, w: 120, page: 1 })],
      [line({ text: "Theirs 0.85 0.80", x: 72, y: 226, w: 120, page: 1 })],
      [line({ text: "Table 3: Results on the test set.", x: 72, y: 250, w: 200, page: 1 })],
      [line({ text: "Far   0.1  0.2", x: 72, y: 400, w: 120, page: 1 })],
    ];
    const all = [...blocksOf(column(72, 100, 220, 4, { page: 1, text: prose })), ...blocksOf(...rows)];
    const verdicts: JudgeVerdict[] = ["b1", "b2", "b3", "b5"].map((id) => ({ id, kind: "table", confidence: 0.9 }));
    const result = applyVerdicts(all, verdicts, context);
    expect(result.blocks.map((block) => [block.kind, block.text])).toEqual([["paragraph", all[0]!.text], ["figure", "Table 3: Results on the test set."], ["figure", ""]]);
    expect(result.blocks[1]?.region?.consumed.map((entry) => entry.text)).toEqual(["Model  Acc  F1", "Ours   0.91 0.88", "Theirs 0.85 0.80"]);
    expect(result.blocks[1]?.region?.caption.map((entry) => entry.text)).toEqual(["Table 3: Results on the test set."]);
    expect(result.blocks[2]?.region?.consumed).toHaveLength(1);
  });

  it("makes a list item of a line the rules kept as a paragraph, stripping a bullet set without a space", () => {
    const all = blocksOf([line({ text: "•the request method is understood by the cache;", x: 72, y: 100, w: 200, page: 1 })], [line({ text: "2) second point", x: 72, y: 120, w: 100, page: 1 })]);
    expect(all.map((block) => block.kind)).toEqual(["paragraph", "listItem"]);
    const result = applyVerdicts(all, [{ id: "b0", kind: "list_item", confidence: 0.9 }], context);
    expect(result.blocks[0]).toMatchObject({ kind: "listItem", ordered: false, text: "the request method is understood by the cache;" });
    expect(result.blocks[0]?.pieces[0]?.line.text).toBe("•the request method is understood by the cache;");
  });

  it("attaches a caption to the nearest caption-less figure of its page, or keeps it as a marked paragraph", () => {
    const grid: Block = { kind: "figure", page: 1, pieces: [], text: "", fontSize: 10, bold: false, indented: false, centred: false, endsSentence: true, fullLast: false, math: false, region: { page: 1, kind: "table", rect: { x: 72, y: 200, w: 220, h: 60 }, caption: [], consumed: [] } };
    const captionLines = [line({ text: "Table 2 Results on the held-out set", x: 72, y: 265, w: 200, page: 1 })];
    const all = [...blocksOf(column(72, 100, 220, 4, { page: 1, text: prose })), grid, ...blocksOf(captionLines)];
    const attached = applyVerdicts(all, [{ id: "b2", kind: "caption", confidence: 0.9 }], context);
    expect(attached.blocks.map((block) => block.kind)).toEqual(["paragraph", "figure"]);
    expect(attached.blocks[1]).toMatchObject({ text: "Table 2 Results on the held-out set", region: { caption: captionLines } });
    const lone = applyVerdicts(all.filter((block) => block !== grid), [{ id: "b1", kind: "caption", confidence: 0.9 }], context);
    expect(lone.blocks[1]).toMatchObject({ kind: "paragraph", role: "caption" });
  });

  it("gives a caption-less grid's lines back to the text when the judge calls them body, and opens a References section", () => {
    const rows = [line({ text: "Alice Smith and Bob Jones. 2021. A paper. In Proc.", x: 72, y: 100, w: 220, page: 2 }), line({ text: "Carol White. 2020. Another paper. Journal.", x: 72, y: 112, w: 220, page: 2 })];
    const grid: Block = { kind: "figure", page: 2, pieces: [], text: "", fontSize: 10, bold: false, indented: false, centred: false, endsSentence: true, fullLast: false, math: false, region: { page: 2, kind: "table", rect: { x: 72, y: 100, w: 220, h: 30 }, caption: [], consumed: rows } };
    const all = [...blocksOf(column(72, 100, 220, 4, { page: 1, text: prose })), grid];
    const result = applyVerdicts(all, [{ id: "b1", kind: "reference", confidence: 0.9 }], context);
    expect(result.blocks.map((block) => [block.kind, block.text.slice(0, 10), block.role ?? ""])).toEqual([["paragraph", "The standa", ""], ["heading", "References", ""], ["paragraph", "Alice Smit", "reference"]]);
    expect(result.blocks[1]).toMatchObject({ depth: 1, pieces: [] });
    const under = [...blocksOf([line({ text: "References", x: 72, y: 80, w: 60, size: 14, page: 2 })]), grid];
    expect(applyVerdicts(under, [{ id: "b1", kind: "reference", confidence: 0.9 }], context).blocks.map((block) => block.kind)).toEqual(["heading", "paragraph"]);
  });
});
