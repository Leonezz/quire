import { describe, expect, it } from "vitest";
import { layoutPage } from "./columns";
import { captionKind, figureRegionsOf } from "./figures";
import { sequencesOf } from "./sequences";
import { column, line, pageOf } from "./testing";
import { isProse } from "./types";

describe("captionKind", () => {
  it("recognises figure and table captions but not in-text references", () => {
    expect(captionKind("Figure 1: The Transformer - model architecture.")).toBe("figure");
    expect(captionKind("Fig. 2. Results over time")).toBe("figure");
    expect(captionKind("Table 3: BERTopic configuration")).toBe("table");
    expect(captionKind("图 1：系统结构")).toBe("figure");
    expect(captionKind("Algorithm 1: Training loop")).toBe("figure");
    expect(captionKind("Table 1 gives the working definition")).toBeUndefined();
    expect(captionKind("Figures are rendered")).toBeUndefined();
  });
});

describe("figureRegionsOf", () => {
  it("crops the gap above a figure caption up to the previous body line and swallows the labels inside it", () => {
    const page = pageOf([
      ...column(72, 100, 450, 5),
      line({ text: "Accuracy", x: 100, y: 200, w: 40, size: 8 }),
      line({ text: "epochs", x: 300, y: 380, w: 30, size: 8 }),
      line({ text: "Figure 1: Accuracy over training epochs.", x: 150, y: 420, w: 300 }),
      ...column(72, 450, 450, 5),
    ]);
    const regions = figureRegionsOf(page, layoutPage(page), 10);
    expect(regions).toHaveLength(1);
    const region = regions[0]!;
    expect(region.kind).toBe("figure");
    expect(region.caption.map((entry) => entry.text)).toEqual(["Figure 1: Accuracy over training epochs."]);
    expect(region.consumed.map((entry) => entry.text).sort()).toEqual(["Accuracy", "epochs"]);
    expect(region.rect.y).toBeLessThan(160);
    expect(region.rect.y + region.rect.h).toBeGreaterThan(400);
    expect(region.rect.y + region.rect.h).toBeLessThanOrEqual(436);
  });

  it("takes the rows below a table caption up to the next heading, keeping a bold header row", () => {
    const page = pageOf([
      ...column(72, 100, 450, 3),
      line({ text: "Table 2: Results by model family.", x: 150, y: 150, w: 300 }),
      line({ text: "Model Accuracy Latency", x: 120, y: 175, w: 200, size: 9, bold: true }),
      line({ text: "GPT-2 0.61 12ms", x: 120, y: 187, w: 180, size: 9 }),
      line({ text: "GPT-4 0.83 40ms", x: 120, y: 199, w: 180, size: 9 }),
      line({ text: "GPT-5 0.91 55ms", x: 120, y: 211, w: 180, size: 9 }),
      line({ text: "3.5 Positional Encoding", x: 72, y: 240, w: 110, size: 10, bold: true }),
      ...column(72, 260, 450, 3),
    ]);
    const regions = figureRegionsOf(page, layoutPage(page), 10);
    expect(regions).toHaveLength(1);
    expect(regions[0]?.kind).toBe("table");
    expect(regions[0]?.consumed.map((entry) => entry.text)).toEqual(["Model Accuracy Latency", "GPT-2 0.61 12ms", "GPT-4 0.83 40ms", "GPT-5 0.91 55ms"]);
    expect(regions[0]!.rect.y + regions[0]!.rect.h).toBeLessThanOrEqual(240 + 16);
  });

  it("ignores a caption with no room around it", () => {
    const page = pageOf([...column(72, 100, 450, 5), line({ text: "Figure 9: nothing to see.", x: 72, y: 165, w: 200 }), ...column(72, 185, 450, 5)]);
    expect(figureRegionsOf(page, layoutPage(page), 10)).toEqual([]);
  });

  it("finds a captionless grid of aligned cells but not an author block of three rows", () => {
    const grid = (rows: number, y: number) => Array.from({ length: rows }, (_, row) => [
      line({ text: `r${row}a`, x: 100, y: y + row * 12, w: 40, size: 9 }), line({ text: `r${row}b`, x: 220, y: y + row * 12, w: 40, size: 9 }), line({ text: `r${row}c`, x: 340, y: y + row * 12, w: 40, size: 9 }),
    ]).flat();
    const table = pageOf([...column(72, 100, 450, 3), ...grid(5, 150), ...column(72, 230, 450, 3)]);
    const regions = figureRegionsOf(table, layoutPage(table), 10);
    expect(regions).toHaveLength(1);
    expect(regions[0]?.consumed).toHaveLength(15);
    const authors = pageOf([line({ text: "A Title", x: 200, y: 60, w: 200, size: 17 }), ...grid(3, 100), ...column(72, 160, 450, 8)]);
    expect(figureRegionsOf(authors, layoutPage(authors), 10)).toEqual([]);
  });

  it("stands the figure in for its caption in the reading order and removes the swallowed lines", () => {
    const prose = (word: string) => (index: number) => `${word} ${index} of the running text that fills the column and keeps going`;
    const page = pageOf([...column(72, 100, 450, 3, { text: prose("before") }), line({ text: "label", x: 100, y: 200, w: 30, size: 8 }), line({ text: "Figure 1: A picture.", x: 150, y: 300, w: 200 }), ...column(72, 330, 450, 3, { text: prose("after") })]);
    const layout = layoutPage(page);
    const items = sequencesOf(layout, figureRegionsOf(page, layout, 10)).flatMap((sequence) => sequence.items);
    expect(items.map((item) => (item.kind === "line" ? item.line.text.split(" ")[0] : `[${item.region.kind}]`))).toEqual(["before", "before", "before", "[figure]", "after", "after", "after"]);
  });
});

describe("isProse", () => {
  it("separates running text from table rows and name lines", () => {
    expect(isProse("Since our model contains no recurrence, we inject positional information.")).toBe(true);
    expect(isProse("GPT-2 (4 models: gpt2, gpt2-medium, gpt2-")).toBe(true);
    expect(isProse("Recurrent O(n · d2) O(n) O(n)")).toBe(false);
    expect(isProse("Layer Type Complexity per Layer Sequential Maximum Path Length")).toBe(false);
    expect(isProse("Durham University")).toBe(false);
  });
});
