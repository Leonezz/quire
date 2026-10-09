// The program's half of the standard (docs/design/eval-rubric.md §5): every reason an issue is
// invalid, the cases where an image or embed claim stands, and the per-layer and overall verdicts.
import { describe, expect, it } from "vitest";
import type { Embed, ReferenceImage, RenderedCode, RenderedImage, RenderedTable } from "../render/types";
import { BOUNDARY_SERVICES, boundaryService, plainText, embedId, evidenceOccurs, inArticle, isBoundaryExternalDrop, extractedKeepsLineBreaks, hasEmptyCells, layerByFacts, layerVerdicts, LARGE_IMAGE_PX, normalizeIssue, overallVerdict, validateIssue, type FactInventory, type Invalidity, type JudgeIssue } from "./verdict";

const TEXTS = ["SOURCE: Figure 3 shows the loss. By Ada.", "EXTRACTED: # Title", "RENDERED: Figure 1: the setup"];
const reader = (id: string, broken = false): RenderedImage => ({ id, tile: 1, src: `https://x.test/${id}.png`, alt: "", caption: "", broken });
const original = (id: string, matchedBy: string | null, width = 640, height = 420, context = "Training setup"): ReferenceImage => ({ id, tile: 2, src: `https://x.test/${id}.png`, candidates: [], alt: "", width, height, matchedBy, context });
const embed = (representedInReader: boolean): Embed => ({ kind: "iframe", tag: "iframe", src: "https://www.youtube.com/embed/v", host: "www.youtube.com", context: "Training setup", representedInReader });
const table = (id: string, cells: number, emptyCells: number): RenderedTable => ({ id, tile: 3, rows: 4, cols: 5, cells, emptyCells, head: "Metric | LCP" });
const code = (id: string, collapsed: boolean, head: string): RenderedCode => ({ id, tile: 2, lines: collapsed ? 1 : 3, chars: collapsed ? 150 : 40, collapsed, head });
const facts = (overrides: Partial<FactInventory> = {}): FactInventory => ({
  rendered: [reader("r1"), reader("r2", true)],
  reference: [original("o1", "r1"), original("o2", "r2"), original("o3", null), original("o4", null, 120, 80)],
  embeds: [embed(false), embed(true)],
  tables: [table("t1", 20, 13), table("t2", 8, 0), table("t3", 3, 3)],
  code: [code("c1", true, "z = np.maximum(0, np.dot(W, x)) # forward passdW = np.outer(z > 0, x)"), code("c2", false, "import os")],
  extracted: "# Title\n\nTraining setup\n\n```python\nz = np.maximum(0, np.dot(W, x)) # forward pass\ndW = np.outer(z > 0, x) # backward\n```\n",
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

describe("the article's head and kept-boundary content (§5.2)", () => {
  const EXTRACTED = "<!-- extractor metadata -->\ntitle: How is LLaMa.cpp possible?\nbyline: Vicki Boykis\npublishedAt: 2024-02-28T00:00:00.000Z\n<!-- end extractor metadata -->\n\n# How is LLaMa.cpp possible?\n\nThe GGUF format packs a model into one file.\n";

  it("counts an image or embed right after the title, the byline or a short date line as in the article (real contexts)", () => {
    expect(inArticle("Feb 28 2024", EXTRACTED)).toBe(true); // vickiboykis-gguf o1
    expect(inArticle("June 5th, 2021 — 11 min read", EXTRACTED)).toBe(true); // kentcdodds-context e1
    expect(inArticle("2019年9月5日 · 5 min read", EXTRACTED)).toBe(true);
    expect(inArticle("How is LLaMa.cpp possible?", EXTRACTED)).toBe(true);
    expect(inArticle("LLaMa.cpp", EXTRACTED)).toBe(true);
    expect(inArticle("By Vicki Boykis", EXTRACTED)).toBe(true);
    expect(inArticle("Vicki", EXTRACTED)).toBe(true);
  });

  it("keeps out what is not the head: a dek or language notice not in EXTRACTED, share chrome, copyright, short lowercase prose", () => {
    expect(inArticle("GitHub Copilot is evolving to bring chat and voice interfaces, support pull requests, answer questions on docs, and adopt OpenAI’s GPT-4 for a more personalize…", EXTRACTED)).toBe(false); // githubblog-copilotx o8
    expect(inArticle("This post is also available in 繁體中文 and 简体中文.", EXTRACTED)).toBe(false); // cloudflare-pingora o1
    expect(inArticle("Copy & share: sive.rs/ff", EXTRACTED)).toBe(false); // sivers-ff e1
    expect(inArticle("© 2024 Example Inc.", EXTRACTED)).toBe(false);
    expect(inArticle("you may want this", EXTRACTED)).toBe(false);
  });

  it("caps a kept-boundary (extra_content) issue at minor, remembering what the model said", () => {
    expect(normalizeIssue(issue({ kind: "extra_content", layer: "rendering", severity: "major", refs: ["r1"] }), facts())).toMatchObject({ severity: "minor", originalSeverity: "major" });
    const minor = issue({ kind: "extra_content", severity: "minor", refs: [] });
    expect(normalizeIssue(minor, facts())).toBe(minor);
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

describe("the article boundary (§2, §5.2)", () => {
  const ARTICLE = "# Understanding LSTMs\n\nRecurrent networks loop over their input.\n\nThe repeating module in an LSTM contains four layers, interacting in a very special way.\n";
  const withContexts = (overrides: Partial<FactInventory> = {}) => facts({
    extracted: ARTICLE,
    reference: [original("o1", null, 640, 420, "The repeating module in an LSTM contains four layers, interacting in a very special way."), original("o2", null, 640, 420, "More posts from this blog: Visualizing Representations"), original("o3", null, 640, 420, "")],
    embeds: [
      { kind: "iframe", tag: "iframe", src: "https://www.youtube.com/embed/v", host: "www.youtube.com", context: "Recurrent networks loop over their input.", representedInReader: false },
      { kind: "iframe", tag: "iframe", src: "https://example.substack.com/embed", host: "example.substack.com", context: "Recurrent networks loop over their input.", representedInReader: false },
      { kind: "iframe", tag: "iframe", src: "https://widgets.wp.com/likes/index.html?ver=1", host: "widgets.wp.com", context: "Share this: Twitter Facebook", representedInReader: false },
    ],
    ...overrides,
  });
  const claim = (refs: string[], overrides: Partial<JudgeIssue> = {}) => issue({ kind: "images", severity: "major", evidence: "Figure 3 shows the loss", refs, ...overrides });

  it("inArticle: the context, or its last 60 characters, in EXTRACTED's visible text; unknown without a context", () => {
    expect(inArticle("The repeating module in an LSTM contains four layers, interacting in a very special way.", ARTICLE)).toBe(true);
    // A context whose start is not article text (cut at 160 characters, or led by a label) still counts by its last 60 characters.
    expect(inArticle("Posted by colah. The repeating module in an LSTM contains four layers, interacting in a very special way.", ARTICLE)).toBe(true);
    // EXTRACTED is markdown; the context is visible page text.
    expect(inArticle("The repeating module in an LSTM contains four layers.", "The repeating module in an LSTM contains **four** layers.")).toBe(true);
    expect(inArticle("It’s here", "It's here")).toBe(true);
    // Comparisons in code are not tags: the text between them stays; an autolink keeps its URL.
    expect(inArticle("The sign of the state tracks whether the signal is high.", "```c\nif (a < b) x = 1;\n```\n\nThe sign of the state tracks whether the signal is high.\n\n```c\nif (c > d) y = 2;\n```")).toBe(true);
    expect(inArticle("check it out at https://github.com/pytorch-labs/gpt-fast!", "check it out at <https://github.com/pytorch-labs/gpt-fast>!")).toBe(true);
    expect(plainText("<td>LCP</td> and <a href=\"x\">link</a>")).toBe("LCP and link");
    // A context the capture cut at 160 characters ends with an ellipsis that is not page text.
    expect(inArticle("If your weight matrix W is initialized too large, the output of the matrix multiply could have a very large range (e.g. numbers between -400 and 400), which wi…", "If your weight matrix **W** is initialized too large, the output of the matrix multiply could have a very large range (e.g. numbers between -400 and 400), which will make all outputs binary.")).toBe(true);
    expect(inArticle("More posts from this blog", ARTICLE)).toBe(false);
    // Nothing precedes it: above the title (a logo, a page header) — out. No context field at all — unknown.
    expect(inArticle("", ARTICLE)).toBe(false);
    expect(inArticle(undefined, ARTICLE)).toBeUndefined();
  });

  it("a missing image claim citing only originals outside the article is outside-boundary; one in the article stands", () => {
    expect(validateIssue(claim(["o2"]), TEXTS, withContexts())).toMatchObject({ reason: "outside-boundary", detail: expect.stringContaining("o2 is not in the article") });
    expect(validateIssue(claim(["o1"]), TEXTS, withContexts())).toBeUndefined();
    expect(validateIssue(claim(["o1", "o2"]), TEXTS, withContexts())).toBeUndefined();
    // o3 has an empty context: nothing precedes it, so it is above the title (a logo) — out.
    expect(validateIssue(claim(["o3"]), TEXTS, withContexts())).toMatchObject({ reason: "outside-boundary" });
    // Any missing-claim kind, at any severity; not a kept-chrome (extra_content) issue.
    expect(validateIssue(claim(["o2"], { kind: "missing_content", severity: "minor" }), TEXTS, withContexts())).toMatchObject({ reason: "outside-boundary" });
    expect(validateIssue(claim(["o2"], { kind: "extra_content", severity: "minor" }), TEXTS, withContexts())).toBeUndefined();
  });

  it("an embed claim citing a subscribe/comment/like/share service is outside-boundary; one citing an in-article video stands", () => {
    expect(validateIssue(claim(["e2"], { kind: "missing_content" }), TEXTS, withContexts())).toMatchObject({ reason: "outside-boundary", detail: expect.stringContaining("e2 is a Substack subscribe embed;") });
    expect(validateIssue(claim(["e3"], { kind: "other" }), TEXTS, withContexts())).toMatchObject({ reason: "outside-boundary", detail: expect.stringContaining("WordPress.com / Jetpack") });
    expect(validateIssue(claim(["e1"], { kind: "missing_content" }), TEXTS, withContexts())).toBeUndefined();
  });

  it("knows the documented services by their src", () => {
    const service = (src: string) => boundaryService({ src, host: new URL(src).host });
    for (const src of ["https://newsletter.languagemodels.co/embed", "https://buttondown.email/x", "https://app.convertkit.com/forms/1", "https://x.us1.list-manage.com/subscribe", "https://embeds.beehiiv.com/abc", "https://www.getrevue.co/profile/x", "https://example.com/#/portal/signup", "https://disqus.com/embed/comments", "https://utteranc.es/client.js", "https://giscus.app/client.js", "https://commento.io/js", "https://www.facebook.com/plugins/like.php", "https://platform.twitter.com/widgets/follow_button.html", "https://s7.addthis.com/js", "https://platform-api.sharethis.com/js", "https://www.googletagmanager.com/ns.html", "https://ad.doubleclick.net/x"]) expect(service(src), src).toBeDefined();
    for (const src of ["https://www.youtube.com/embed/v", "https://codepen.io/x/embed/y", "https://newsletter.example.com/p/a-post", "https://twitter.com/a/status/1", "https://observablehq.com/embed/x"]) expect(service(src), src).toBeUndefined();
    expect(BOUNDARY_SERVICES.length).toBeGreaterThan(10);
  });

  it("a missing-content claim quoting a citation / BibTeX block is outside-boundary, like a licence footer", () => {
    const texts = ["Cited as:\nWeng, Lilian. (Jun 2023). LLM-powered Autonomous Agents.", "@article{weng2023agent,\n  title = \"LLM-powered Autonomous Agents\"", "Please cite this work as", "BibTeX citation"];
    for (const evidence of ["Cited as:", "@article{weng2023agent,", "Please cite this work as", "BibTeX citation"]) {
      expect(validateIssue(issue({ kind: "missing_content", evidence, refs: [] }), texts, facts())).toMatchObject({ reason: "outside-boundary", detail: expect.stringContaining("BibTeX") });
    }
    expect(validateIssue(issue({ kind: "missing_content", evidence: "Weng, Lilian. (Jun 2023)", refs: [] }), texts, facts())).toBeUndefined();
  });
});
