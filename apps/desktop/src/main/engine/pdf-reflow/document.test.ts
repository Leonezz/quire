import { readerDocumentV2Schema } from "@read/normalize/contract";
import { describe, expect, it } from "vitest";
import { blocksOfSequence, classifyHeadings, mergeAcross, type Block } from "./blocks";
import { assembleDocument, type DocumentBlock } from "./document";
import { column, line, PAGE } from "./testing";
import type { FigureRegion, Line, Sequence } from "./types";

const sizes = new Map([[1, PAGE], [2, PAGE]]);
const sequenceOf = (lines: Line[], extent: [number, number] = [72, 292]): Sequence => ({ page: lines[0]?.page ?? 1, items: lines.map((entry) => ({ kind: "line", line: entry })), left: extent[0], right: extent[1] });

function sampleBlocks(): Block[] {
  const page1 = [
    line({ text: "A Paper Title", x: 72, y: 80, w: 200, size: 16, bold: true }),
    line({ text: "1 Introduction", x: 72, y: 120, w: 90, size: 12, bold: true }),
    line({ text: "We provide infor-", x: 72, y: 140, w: 218 }),
    line({ text: "mation about the harness and keep writing until", x: 72, y: 152, w: 220 }),
  ];
  const page2 = [
    line({ text: "the sentence ends on the next page.", x: 72, y: 100, w: 160, page: 2 }),
    line({ text: "• first item", x: 72, y: 130, w: 100, page: 2 }),
    line({ text: "• second item", x: 72, y: 142, w: 100, page: 2 }),
    line({ text: "1.1 Details", x: 72, y: 170, w: 90, size: 12, bold: true, page: 2 }),
    ...column(72, 190, 220, 2, { page: 2, text: (index) => `detail paragraph line ${index + 1} of the section body.` }),
  ];
  const blocks = mergeAcross([...blocksOfSequence(sequenceOf(page1), 10), ...blocksOfSequence(sequenceOf(page2), 10)]);
  return classifyHeadings(blocks, new Map([[1, 16], [2, 12]]), 10);
}

describe("assembleDocument", () => {
  it("writes one plain line per block and anchors every source line back to exactly its slice of plain", () => {
    const { plain, anchors } = assembleDocument(sampleBlocks(), sizes);
    expect(plain.split("\n\n")).toEqual([
      "A Paper Title", "1 Introduction",
      "We provide information about the harness and keep writing until the sentence ends on the next page.",
      "first item", "second item", "1.1 Details", "detail paragraph line 1 of the section body. detail paragraph line 2 of the section body.",
    ]);
    expect(anchors).toHaveLength(10);
    const sliced = anchors.map((anchor) => plain.slice(anchor.start, anchor.end));
    expect(sliced).toEqual(["A Paper Title", "1 Introduction", "We provide infor", "mation about the harness and keep writing until", "the sentence ends on the next page.", "first item", "second item", "1.1 Details", "detail paragraph line 1 of the section body.", "detail paragraph line 2 of the section body."]);
    expect(anchors.map((anchor) => anchor.page)).toEqual([1, 1, 1, 1, 2, 2, 2, 2, 2, 2]);
    expect(anchors[0]?.rect).toEqual([0.12, 0.1, 0.3333, 0.02]);
    for (let index = 1; index < anchors.length; index += 1) expect(anchors[index]!.start).toBeGreaterThanOrEqual(anchors[index - 1]!.end);
  });

  it("nests sections by heading depth, groups list items and emits Markdown for the same blocks", () => {
    const { document, markdown } = assembleDocument(sampleBlocks(), sizes);
    expect(readerDocumentV2Schema.safeParse(document).success).toBe(true);
    // The title and "1 Introduction" are both depth 1, so they are sibling sections; 1.1 nests under the introduction.
    expect(document.children.map((node) => node.type)).toEqual(["section", "section"]);
    const intro = document.children[1]!;
    if (intro.type !== "section") return;
    expect(intro.children.map((node) => node.type)).toEqual(["heading", "paragraph", "list", "section"]);
    const details = intro.children[3]!;
    if (details.type !== "section") return;
    expect(details.children.map((node) => node.type)).toEqual(["heading", "paragraph"]);
    expect(markdown.split("\n\n").slice(0, 5)).toEqual(["# A Paper Title", "# 1 Introduction", "We provide information about the harness and keep writing until the sentence ends on the next page.", "- first item", "- second item"]);
    expect(markdown).toContain("## 1.1 Details");
  });

  it("renders a figure with its crop and caption, or a bracketed placeholder line when no crop exists", () => {
    const caption = line({ text: "Figure 1: The architecture.", x: 150, y: 400, w: 200 });
    const region: FigureRegion = { page: 1, kind: "figure", rect: { x: 60, y: 200, w: 480, h: 190 }, caption: [caption], consumed: [] };
    const base: DocumentBlock = { kind: "figure", page: 1, pieces: [{ line: caption, text: caption.text }], text: caption.text, fontSize: 10, bold: false, indented: false, centred: true, endsSentence: true, fullLast: false, math: false, region, number: 1 };
    const withCrop = assembleDocument([{ ...base, asset: { url: "quire-figure://0123456789abcdef/1.png", width: 960, height: 380 } }], sizes);
    expect(readerDocumentV2Schema.safeParse(withCrop.document).success).toBe(true);
    expect(withCrop.document.children[0]).toMatchObject({ type: "figure", media: [{ type: "image", url: "quire-figure://0123456789abcdef/1.png", alt: "Figure 1: The architecture.", width: 960, height: 380 }] });
    expect(withCrop.plain).toBe("Figure 1: The architecture.");
    expect(withCrop.markdown).toBe("![Figure 1: The architecture.](quire-figure://0123456789abcdef/1.png)\n\nFigure 1: The architecture.");
    expect(withCrop.anchors).toEqual([{ page: 1, rect: [0.25, 0.5, 0.3333, 0.0125], start: 0, end: 27 }]);

    const placeholder = assembleDocument([base], sizes);
    expect(placeholder.plain).toBe("[Figure 1: Figure 1: The architecture.]");
    expect(placeholder.document.children[0]).toMatchObject({ type: "paragraph" });
    expect(placeholder.anchors).toEqual([{ page: 1, rect: [0.1, 0.25, 0.8, 0.2375], start: 0, end: 39 }]);
  });
});

describe("assembleDocument title", () => {
  it("keeps a heading that repeats the material title in plain but not in the tree", () => {
    const sizes = new Map([[1, { width: 600, height: 800 }]]);
    const heading = { kind: "heading" as const, depth: 1 as const, text: "A  Title", pieces: [], page: 1, rect: [0, 0, 1, 0.05] as [number, number, number, number] };
    const para = { kind: "paragraph" as const, text: "Body.", pieces: [], page: 1, rect: [0, 0.1, 1, 0.05] as [number, number, number, number] };
    const out = assembleDocument([heading as never, para as never], sizes, "a title");
    expect(out.plain.startsWith("A  Title")).toBe(true);
    expect(JSON.stringify(out.document)).not.toContain("A  Title");
    expect(out.markdown.startsWith("Body.")).toBe(true);
  });
});
