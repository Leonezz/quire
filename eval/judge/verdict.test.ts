// The program's half of the standard (docs/design/eval-rubric.md §5): every reason an issue is
// invalid, the cases where an image or embed claim stands, and the per-layer and overall verdicts.
import { describe, expect, it } from "vitest";
import type { Embed, ReferenceImage, RenderedCode, RenderedImage, RenderedTable } from "../render/types";
import { embedId, evidenceOccurs, isBoundaryExternalDrop, extractedKeepsLineBreaks, hasEmptyCells, layerByFacts, layerVerdicts, LARGE_IMAGE_PX, normalizeIssue, overallVerdict, validateIssue, type FactInventory, type Invalidity, type JudgeIssue } from "./verdict";

const TEXTS = ["SOURCE: Figure 3 shows the loss. By Ada.", "EXTRACTED: # Title", "RENDERED: Figure 1: the setup"];
const reader = (id: string, broken = false): RenderedImage => ({ id, tile: 1, src: `https://x.test/${id}.png`, alt: "", caption: "", broken });
const original = (id: string, matchedBy: string | null, width = 640, height = 420): ReferenceImage => ({ id, tile: 2, src: `https://x.test/${id}.png`, candidates: [], alt: "", width, height, matchedBy });
const embed = (representedInReader: boolean): Embed => ({ kind: "iframe", tag: "iframe", src: "https://www.youtube.com/embed/v", host: "www.youtube.com", context: "Training setup", representedInReader });
const table = (id: string, cells: number, emptyCells: number): RenderedTable => ({ id, tile: 3, rows: 4, cols: 5, cells, emptyCells, head: "Metric | LCP" });
const code = (id: string, collapsed: boolean, head: string): RenderedCode => ({ id, tile: 2, lines: collapsed ? 1 : 3, chars: collapsed ? 150 : 40, collapsed, head });
const facts = (overrides: Partial<FactInventory> = {}): FactInventory => ({
  rendered: [reader("r1"), reader("r2", true)],
  reference: [original("o1", "r1"), original("o2", "r2"), original("o3", null), original("o4", null, 120, 80)],
  embeds: [embed(false), embed(true)],
  tables: [table("t1", 20, 13), table("t2", 8, 0), table("t3", 3, 3)],
  code: [code("c1", true, "z = np.maximum(0, np.dot(W, x)) # forward passdW = np.outer(z > 0, x)"), code("c2", false, "import os")],
  extracted: "# Title\n\n```python\nz = np.maximum(0, np.dot(W, x)) # forward pass\ndW = np.outer(z > 0, x) # backward\n```\n",
  sent: { rendered: 3, reference: 2 },
  ...overrides,
});
const issue = (overrides: Partial<JudgeIssue> = {}): JudgeIssue => ({ layer: "content", kind: "images", severity: "major", evidence: "Figure 3 shows the loss", note: "a figure is missing", where: null, refs: [], ...overrides });
const reasonOf = (invalid: Invalidity | undefined) => invalid?.reason;

describe("validateIssue", () => {
  it("(a) counts a quote that drops only markup (link syntax, escapes, tags, entities), but not one that changes words", () => {
    const source = "[Chrome User Experience Report](https://developer.chrome.com/docs/crux) | check | check | check |";
    expect(validateIssue(issue({ kind: "tables", evidence: "Chrome User Experience Report | check | check | check |", refs: ["t1"] }), [source], facts())).toBeUndefined();
    expect(validateIssue(issue({ kind: "tables", evidence: "W.T, z*(1-z)", refs: ["t1"] }), ["np.dot(W\\.T, z\\*(1-z))"], facts())).toBeUndefined();
    expect(validateIssue(issue({ kind: "tables", evidence: "LCP INP", refs: ["t1"] }), ["\\<td>LCP\\</td>\\<td>INP\\</td>"], facts())).toBeUndefined();
    expect(validateIssue(issue({ kind: "tables", evidence: "Chrome UX Report | check", refs: ["t1"] }), [source], facts())).toMatchObject({ reason: "evidence-not-verbatim" });
  });

  it("(a) rejects evidence that is not verbatim in any of the texts, in both modes", () => {
    expect(validateIssue(issue({ evidence: "Figure three shows the loss", refs: ["o3"] }), TEXTS, facts())).toEqual({ reason: "evidence-not-verbatim", detail: "the evidence quote is not in SOURCE, EXTRACTED or RENDERED TEXT" });
    expect(reasonOf(validateIssue(issue({ evidence: "  " }), TEXTS))).toBe("evidence-not-verbatim");
    // Text mode (no facts) checks the evidence only.
    expect(validateIssue(issue({ refs: undefined, where: undefined }), TEXTS)).toBeUndefined();
  });

  it("(c) rejects a tile that was not attached and ids no inventory has", () => {
    expect(validateIssue(issue({ where: { image: "rendered", tile: 4 }, refs: ["o3"] }), TEXTS, facts())).toEqual({ reason: "tile-not-sent", detail: "rendered tile 4 was not attached (3 rendered tiles sent)" });
    expect(validateIssue(issue({ where: { image: "reference", tile: 3 }, refs: ["o3"] }), TEXTS, facts())).toMatchObject({ reason: "tile-not-sent" });
    expect(validateIssue(issue({ where: { image: "reference", tile: 2 }, refs: ["o3"] }), TEXTS, facts())).toBeUndefined();
    expect(validateIssue(issue({ refs: ["o3", "o9", "e7"] }), TEXTS, facts())).toEqual({ reason: "unknown-ref", detail: "o9, e7 are in no inventory" });
    expect(validateIssue(issue({ kind: "layout", severity: "minor", refs: ["r5"] }), TEXTS, facts())).toEqual({ reason: "unknown-ref", detail: "r5 is in no inventory" });
  });

  it("(b) a major image claim citing a reader image that is present and not broken contradicts the facts", () => {
    expect(validateIssue(issue({ refs: ["r1"] }), TEXTS, facts())).toEqual({ reason: "contradicts-image-facts", detail: "r1 is in the reader, not broken" });
  });

  it("(b) a major image claim citing an original image the reader matched contradicts the facts, unless that reader image is broken", () => {
    expect(validateIssue(issue({ refs: ["o1"] }), TEXTS, facts())).toEqual({ reason: "contradicts-image-facts", detail: "o1 is in the reader as r1, not broken" });
    expect(validateIssue(issue({ refs: ["o2"] }), TEXTS, facts())).toBeUndefined();
  });

  it("an image claim citing an unmatched original image or a broken reader image stands; with several ids one backing id is enough", () => {
    expect(validateIssue(issue({ refs: ["o3"] }), TEXTS, facts())).toBeUndefined();
    // An unmatched small image is still unmatched: citing it by id is enough.
    expect(validateIssue(issue({ refs: ["o4"] }), TEXTS, facts())).toBeUndefined();
    expect(validateIssue(issue({ layer: "rendering", refs: ["r2"] }), TEXTS, facts())).toBeUndefined();
    expect(validateIssue(issue({ refs: ["o1", "o3"] }), TEXTS, facts())).toBeUndefined();
    expect(reasonOf(validateIssue(issue({ refs: ["o1", "r1"] }), TEXTS, facts()))).toBe("contradicts-image-facts");
  });

  it(`a major image claim citing no image stands only while an unmatched original of ${LARGE_IMAGE_PX} px or more on a side, or a broken reader image, exists`, () => {
    expect(validateIssue(issue(), TEXTS, facts())).toBeUndefined();
    const allMatched = facts({ rendered: [reader("r1")], reference: [original("o1", "r1"), original("o4", null, LARGE_IMAGE_PX - 1, 80)] });
    expect(validateIssue(issue(), TEXTS, allMatched)).toEqual({ reason: "contradicts-image-facts", detail: `cites no image, and every original image of ${LARGE_IMAGE_PX} px or more is in the reader and none is broken` });
    expect(validateIssue(issue(), TEXTS, { ...allMatched, reference: [original("o1", "r1"), original("o4", null, 80, LARGE_IMAGE_PX)] })).toBeUndefined();
    expect(validateIssue(issue(), TEXTS, { ...allMatched, rendered: [reader("r1", true)] })).toBeUndefined();
    // Citing only an embed is citing no image.
    expect(reasonOf(validateIssue(issue({ refs: ["e1"] }), TEXTS, allMatched))).toBe("contradicts-image-facts");
  });

  it("checks image facts only for major image issues: a minor one (a missing caption) about a present image stands", () => {
    expect(validateIssue(issue({ severity: "minor", refs: ["r1"], note: "the caption is missing" }), TEXTS, facts())).toBeUndefined();
    expect(validateIssue(issue({ kind: "missing_content", refs: ["r1"] }), TEXTS, facts())).toBeUndefined();
  });

  it("(b) an embed claim citing only embeds the reader shows contradicts the facts; one unshown embed is enough to stand", () => {
    expect(embedId(0)).toBe("e1");
    const embedIssue = (refs: string[]) => issue({ kind: "missing_content", refs, note: "the video is gone" });
    expect(validateIssue(embedIssue(["e2"]), TEXTS, facts())).toEqual({ reason: "contradicts-embed-facts", detail: "e2 is shown in the reader" });
    expect(validateIssue(embedIssue(["e1"]), TEXTS, facts())).toBeUndefined();
    expect(validateIssue(embedIssue(["e1", "e2"]), TEXTS, facts())).toBeUndefined();
    expect(validateIssue(issue({ refs: ["o3", "e2"] }), TEXTS, facts())).toMatchObject({ reason: "contradicts-embed-facts" });
  });

  it("checks in order: evidence, then tile and ids, then facts", () => {
    expect(reasonOf(validateIssue(issue({ evidence: "nope", where: { image: "rendered", tile: 9 }, refs: ["r1"] }), TEXTS, facts()))).toBe("evidence-not-verbatim");
    expect(reasonOf(validateIssue(issue({ where: { image: "rendered", tile: 9 }, refs: ["r9"] }), TEXTS, facts()))).toBe("tile-not-sent");
    expect(reasonOf(validateIssue(issue({ refs: ["r9", "r1"] }), TEXTS, facts()))).toBe("unknown-ref");
  });
});

describe("normalizeIssue (the metadata rule, §5)", () => {
  it("puts any metadata-kind or subject-bearing issue in the metadata layer, title major, author and date minor", () => {
    expect(normalizeIssue(issue({ kind: "missing_content", layer: "content", severity: "major", subject: "author" }))).toMatchObject({ layer: "metadata", severity: "minor", originalSeverity: "major" });
    expect(normalizeIssue(issue({ kind: "metadata", layer: "content", severity: "minor", subject: "title" }))).toMatchObject({ layer: "metadata", severity: "major", originalSeverity: "minor" });
    expect(normalizeIssue(issue({ kind: "metadata", layer: "metadata", severity: "minor", subject: "date" }))).not.toHaveProperty("originalSeverity");
  });

  it("leaves other issues alone, and keeps a text-mode metadata issue's severity (it has no subject)", () => {
    const other = issue({ subject: null });
    expect(normalizeIssue(other)).toBe(other);
    expect(normalizeIssue(issue({ kind: "metadata", layer: "metadata", severity: "major", subject: undefined }))).toMatchObject({ layer: "metadata", severity: "major" });
  });

  it("a metadata-kind issue with a null subject is invalid; text mode (no subject at all) is not checked", () => {
    expect(validateIssue(issue({ kind: "metadata", subject: null, evidence: "By Ada" }), TEXTS, facts())).toEqual({ reason: "metadata-without-subject", detail: "a metadata issue must say whether it is about the title, the author or the date" });
    expect(validateIssue(issue({ kind: "metadata", subject: undefined, evidence: "By Ada", refs: undefined }), TEXTS)).toBeUndefined();
    expect(validateIssue(issue({ kind: "metadata", subject: "author", evidence: "By Ada" }), TEXTS, facts())).toBeUndefined();
  });
});

describe("layerByFacts (the content/rendering dividing line, §3)", () => {
  it("puts an issue citing an unmatched original image or an unshown embed in content, keeping the model's layer", () => {
    expect(layerByFacts(issue({ layer: "rendering", refs: ["o3"] }), facts())).toMatchObject({ layer: "content", originalLayer: "rendering" });
    expect(layerByFacts(issue({ layer: "rendering", kind: "missing_content", refs: ["e1"] }), facts())).toMatchObject({ layer: "content", originalLayer: "rendering" });
  });

  it("puts an issue citing a broken reader image in rendering", () => {
    expect(layerByFacts(issue({ layer: "content", refs: ["r2"] }), facts())).toMatchObject({ layer: "rendering", originalLayer: "content" });
  });

  it("prefers content when an issue cites both, and leaves alone what the facts do not decide", () => {
    expect(layerByFacts(issue({ layer: "rendering", refs: ["r2", "o3"] }), facts())).toMatchObject({ layer: "content" });
    const decided = issue({ layer: "content", refs: ["o3"] });
    expect(layerByFacts(decided, facts())).toBe(decided);
    for (const refs of [[], ["r1"], ["o1"], ["e2"]]) { const left = issue({ layer: "rendering", refs }); expect(layerByFacts(left, facts())).toBe(left); }
    const text = issue({ layer: "rendering", refs: ["o3"] });
    expect(layerByFacts(text, undefined)).toBe(text);
  });

  it("runs after the metadata rule, which wins for metadata issues", () => {
    expect(normalizeIssue(issue({ layer: "rendering", refs: ["o3"] }), facts())).toMatchObject({ layer: "content", originalLayer: "rendering" });
    expect(normalizeIssue(issue({ kind: "metadata", layer: "content", subject: "title", refs: ["o3"] }), facts())).toMatchObject({ layer: "metadata", severity: "major", originalLayer: "content" });
    expect(normalizeIssue(issue({ kind: "missing_content", layer: "rendering", subject: "author", refs: ["e1"] }), facts())).toMatchObject({ layer: "metadata", severity: "minor" });
  });
});

describe("tables and code blocks", () => {
  it("unknown-ref covers t and c ids", () => {
    expect(validateIssue(issue({ kind: "tables", severity: "minor", refs: ["t9", "c7", "t1"] }), TEXTS, facts())).toEqual({ reason: "unknown-ref", detail: "t9, c7 are in no inventory" });
  });

  it("a major tables issue citing only tables with no empty cells contradicts the facts; a minor one, or one citing a table with empty cells, stands", () => {
    expect(validateIssue(issue({ kind: "tables", refs: ["t2"] }), TEXTS, facts())).toEqual({ reason: "contradicts-table-facts", detail: "t2 has no empty cells" });
    expect(validateIssue(issue({ kind: "tables", refs: ["t1"] }), TEXTS, facts())).toBeUndefined();
    expect(validateIssue(issue({ kind: "tables", refs: ["t1", "t2"] }), TEXTS, facts())).toBeUndefined();
    expect(validateIssue(issue({ kind: "tables", severity: "minor", refs: ["t2"] }), TEXTS, facts())).toBeUndefined();
    expect(validateIssue(issue({ kind: "tables", refs: [] }), TEXTS, facts())).toBeUndefined();
  });

  it("a table has empty cells at a quarter or more of at least four cells", () => {
    expect(hasEmptyCells({ id: "t", tile: 1, rows: 2, cols: 2, cells: 4, emptyCells: 1, head: "" })).toBe(true);
    expect(hasEmptyCells({ id: "t", tile: 1, rows: 2, cols: 2, cells: 8, emptyCells: 1, head: "" })).toBe(false);
    expect(hasEmptyCells({ id: "t", tile: 1, rows: 1, cols: 3, cells: 3, emptyCells: 3, head: "" })).toBe(false);
  });

  it("layer: a table with empty cells is content; a small or full table decides nothing", () => {
    expect(layerByFacts(issue({ kind: "tables", layer: "rendering", refs: ["t1"] }), facts())).toMatchObject({ layer: "content", originalLayer: "rendering" });
    const small = issue({ kind: "tables", layer: "rendering", refs: ["t3"] });
    expect(layerByFacts(small, facts())).toBe(small);
  });

  it("layer: a collapsed code block is rendering when EXTRACTED still has its line breaks, content when it does not or lacks the code", () => {
    expect(layerByFacts(issue({ kind: "code_or_math", layer: "content", refs: ["c1"] }), facts())).toMatchObject({ layer: "rendering", originalLayer: "content" });
    const flat = facts({ extracted: "```python\nz = np.maximum(0, np.dot(W, x)) # forward passdW = np.outer(z > 0, x)\n```\n" });
    expect(layerByFacts(issue({ kind: "code_or_math", layer: "rendering", refs: ["c1"] }), flat)).toMatchObject({ layer: "content", originalLayer: "rendering" });
    expect(layerByFacts(issue({ kind: "code_or_math", layer: "rendering", refs: ["c1"] }), facts({ extracted: "no code here" }))).toMatchObject({ layer: "content" });
    // A block that is not collapsed decides nothing.
    const fine = issue({ kind: "code_or_math", layer: "content", refs: ["c2"] });
    expect(layerByFacts(fine, facts())).toBe(fine);
  });

  it("layer: content wins when the cited ids disagree", () => {
    expect(layerByFacts(issue({ layer: "rendering", refs: ["c1", "t1"] }), facts())).toMatchObject({ layer: "content" });
    expect(layerByFacts(issue({ layer: "content", refs: ["c1", "r1"] }), facts())).toMatchObject({ layer: "rendering" });
  });

  it("extractedKeepsLineBreaks: finds the head ignoring whitespace, inside a fence or as plain text", () => {
    const head = "def f(x):return x+1";
    expect(extractedKeepsLineBreaks(head, "text\n\n```\ndef f(x):\n    return x+1\n```")).toBe(true);
    expect(extractedKeepsLineBreaks("import os", "```\nimport os\nimport sys\n```")).toBe(true);
    expect(extractedKeepsLineBreaks("import os import sys", "```\nimport os import sys\n```")).toBe(false);
    expect(extractedKeepsLineBreaks(head, "def f(x):\nreturn x+1 in plain text")).toBe(true);
    expect(extractedKeepsLineBreaks(head, "def f(x): return x+1 in plain text")).toBe(false);
    expect(extractedKeepsLineBreaks(head, "nothing like it")).toBe(false);
    expect(extractedKeepsLineBreaks("  ", "anything")).toBe(false);
    // Markdown escapes and hard-break backslashes (a code block the extractor turned into a paragraph).
    expect(extractedKeepsLineBreaks("z = 1/(1 + x) # forward passdx = np.dot(W.T, z*(1-z))", "z = 1/(1 + x) # forward pass\\\ndx = np.dot(W\\.T, z\\*(1-z))")).toBe(true);
  });
});

describe("layerVerdicts and overallVerdict", () => {
  const judged = (layer: JudgeIssue["layer"], severity: JudgeIssue["severity"], invalid?: Invalidity) => ({ ...issue({ layer, severity }), ...(invalid ? { invalid } : {}) });
  const bad: Invalidity = { reason: "evidence-not-verbatim", detail: "x" };

  it("is PASS everywhere without issues; rendering is null when not judged", () => {
    expect(layerVerdicts([], true)).toEqual({ content: "PASS", metadata: "PASS", rendering: "PASS" });
    expect(layerVerdicts([], false)).toEqual({ content: "PASS", metadata: "PASS", rendering: null });
    expect(overallVerdict(layerVerdicts([], false))).toBe("PASS");
  });

  it("per layer: any valid major is MAJOR, else any valid minor is MINOR; invalid issues never count", () => {
    const layers = layerVerdicts([judged("content", "minor"), judged("content", "major", bad), judged("metadata", "minor"), judged("metadata", "major"), judged("rendering", "major", bad)], true);
    expect(layers).toEqual({ content: "MINOR", metadata: "MAJOR", rendering: "PASS" });
    expect(overallVerdict(layers)).toBe("MAJOR");
  });

  it("overall is the worst layer, and a null rendering layer is skipped", () => {
    expect(overallVerdict({ content: "PASS", metadata: "MINOR", rendering: "PASS" })).toBe("MINOR");
    expect(overallVerdict({ content: "PASS", metadata: "PASS", rendering: "MAJOR" })).toBe("MAJOR");
    expect(overallVerdict({ content: "MINOR", metadata: "PASS", rendering: null })).toBe("MINOR");
    // A rendering issue in text mode cannot happen, but if one did it would not count without the layer.
    expect(layerVerdicts([judged("rendering", "major")], false)).toEqual({ content: "PASS", metadata: "PASS", rendering: null });
  });
});

describe("evidence tolerance and the licence-footer rule (rubric 2026-10-10.11)", () => {
  it("treats curly and straight quotes as equal and ignores a trailing ellipsis", () => {
    expect(evidenceOccurs("If you're familiar with DQN...", "If you’re familiar with DQN, you can see")).toBe(true);
    expect(evidenceOccurs("the “key point” callout…", "Read the \"key point\" callout first.")).toBe(true);
    expect(evidenceOccurs("a sentence that is not there…", "something else entirely")).toBe(false);
  });

  it("rejects a missing-content claim whose evidence is a copyright or licence notice", () => {
    expect(isBoundaryExternalDrop({ kind: "missing_content", evidence: "Except as otherwise noted, the content of this page is licensed under the Creative Commons Attribution 4.0 License" })).toBe(true);
    expect(isBoundaryExternalDrop({ kind: "missing_content", evidence: "© 2024 Example Inc. All rights reserved." })).toBe(true);
    expect(isBoundaryExternalDrop({ kind: "extra_content", evidence: "© 2024 Example Inc." })).toBe(false);
    expect(isBoundaryExternalDrop({ kind: "missing_content", evidence: "Key point: Stable metrics aren't necessarily permanent." })).toBe(false);
  });
});
