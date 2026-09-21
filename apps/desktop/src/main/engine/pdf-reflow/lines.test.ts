import { describe, expect, it } from "vitest";
import { isDegradedText, runsOfPage, type ViewportLike } from "./extract";
import { linesOfRuns } from "./lines";
import { run } from "./testing";

describe("linesOfRuns", () => {
  it("joins runs on one baseline, inserting the spaces the PDF never drew", () => {
    const lines = linesOfRuns(1, [run("Safety", 72, 700, 30), run("evaluations", 105, 700, 55), run(" ", 160, 700, 3), run("for", 163, 700, 15), run("LLMs", 181, 700, 25)]);
    expect(lines.map((line) => line.text)).toEqual(["Safety evaluations for LLMs"]);
    expect(lines[0]?.rect).toEqual({ x: 72, y: 692, w: 134, h: 10 });
  });

  it("splits a baseline into cells where the gap exceeds an em, and keeps rotated runs apart", () => {
    const lines = linesOfRuns(1, [run("left column text", 72, 700, 200), run("right column text", 300, 700, 200), run("arXiv:2609.20779v1", 20, 400, 200, 10, { rotated: true })]);
    expect(lines.map((line) => [line.text, line.rotated])).toEqual([["arXiv:2609.20779v1", true], ["left column text", false], ["right column text", false]]);
  });

  it("clusters slightly different baselines together and separates real lines", () => {
    const lines = linesOfRuns(1, [run("ρ", 72, 700.3, 6), run("= 0.55", 81, 700, 30), run("next line", 72, 688, 40)]);
    expect(lines.map((line) => line.text)).toEqual(["next line", "ρ = 0.55"]);
  });

  it("calls a line bold only when nearly all of it is, and sizes it by its larger fair share", () => {
    const runIn = linesOfRuns(1, [run("Contributions.", 72, 700, 60, 10, { bold: true }), run("We make four", 135, 700, 60)]);
    expect(runIn[0]?.bold).toBe(false);
    const heading = linesOfRuns(1, [run("2", 72, 700, 6, 12, { bold: true }), run("Related Work", 82, 700, 70, 12, { bold: true })]);
    expect(heading[0]).toMatchObject({ bold: true, fontSize: 12 });
    const smallCaps = linesOfRuns(1, [run("1 I", 72, 700, 16, 12), run("NTRODUCTION", 88, 700, 60, 9.5)]);
    expect(smallCaps[0]?.fontSize).toBe(12);
  });
});

describe("runsOfPage", () => {
  const viewport: ViewportLike = { width: 600, height: 800, convertToViewportPoint: (x, y) => [x, 800 - y] };
  const item = (str: string, transform: number[], width: number, fontName = "f1") => ({ str, transform, width, height: transform[3] ?? 0, fontName });

  it("maps upright items to top-left rects with the font's ascent and descent, and reads bold from the font name", () => {
    const runs = runsOfPage({ page: 1, items: [item("Hello", [10, 0, 0, 10, 72, 700], 30)], styles: { f1: { ascent: 0.8, descent: -0.2 } }, viewport, fontNameOf: () => "NimbusRomNo9L-Medi" });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ text: "Hello", baseline: 100, fontSize: 10, bold: true, italic: false, rotated: false });
    expect(runs[0]?.rect).toEqual({ x: 72, y: 92, w: 30, h: 10 });
  });

  it("marks rotated items and gives them a tall bounding box", () => {
    const runs = runsOfPage({ page: 1, items: [item("arXiv:2609.20779v1", [0, 20, -20, 0, 32, 300], 340)], styles: {}, viewport, fontNameOf: () => undefined });
    expect(runs[0]?.rotated).toBe(true);
    expect(runs[0]!.rect.h).toBeGreaterThan(runs[0]!.rect.w);
    expect(runs[0]!.rect.x).toBeLessThan(40);
  });

  it("drops empty items", () => {
    expect(runsOfPage({ page: 1, items: [item("", [10, 0, 0, 10, 72, 700], 0)], styles: {}, viewport, fontNameOf: () => undefined })).toEqual([]);
  });
});

describe("isDegradedText", () => {
  it("flags empty, replacement-heavy and unspaced text layers", () => {
    expect(isDegradedText("")).toBe(true);
    expect(isDegradedText("���ab ��")).toBe(true);
    expect(isDegradedText("x".repeat(400))).toBe(true);
    expect(isDegradedText("Safety evaluations for large language models rely on surface-form classifiers. ".repeat(4))).toBe(false);
    expect(isDegradedText("short")).toBe(false);
  });
});
