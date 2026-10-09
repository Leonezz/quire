// Cross-confirmation (docs/design/eval-rubric.md §6) as a pure function: which issues match, the
// severity a matched pair keeps, each fact that keeps a one-sided major issue major, the downgrade,
// dedupe, and that invalid issues never take part.
import { describe, expect, it } from "vitest";
import type { RenderMetrics } from "../render/types";
import type { JudgedIssue } from "./cache";
import { crossConfirm, factSupported, issuesMatch, originCounts, type MergeFacts } from "./merge";

const issue = (overrides: Partial<JudgedIssue> = {}): JudgedIssue => ({ layer: "content", kind: "missing_content", severity: "major", evidence: "a quote", note: "n", verified: true, where: null, refs: [], subject: null, ...overrides });
const metrics = (overrides: Partial<MergeFacts["metrics"]> = {}): MergeFacts["metrics"] => ({
  images: { total: 2, broken: 0, brokenSrc: [] }, emptyCellTables: { count: 0, samples: [] }, rawMarkup: { count: 0, samples: [] }, mathErrors: 0, unmarkedLists: 0, collapsedCode: 0, ...overrides,
} satisfies Pick<RenderMetrics, "images" | "emptyCellTables" | "rawMarkup" | "mathErrors" | "unmarkedLists" | "collapsedCode">);
const facts = (overrides: Partial<MergeFacts> = {}): MergeFacts => ({
  rendered: [{ id: "r1", tile: 1, src: "a", alt: "", caption: "", broken: false }, { id: "r2", tile: 2, src: "b", alt: "", caption: "", broken: true }],
  reference: [{ id: "o1", tile: 1, src: "a", candidates: [], alt: "", width: 600, height: 400, matchedBy: "r1", context: "The setup" }, { id: "o2", tile: 2, src: "c", candidates: [], alt: "", width: 600, height: 400, matchedBy: null, context: "The loss curve below shows it." }],
  embeds: [{ kind: "iframe", tag: "iframe", src: "v", host: "youtube.com", context: "Training setup", representedInReader: false }, { kind: "tweet", tag: "blockquote", src: "t", host: "twitter.com", context: "As announced", representedInReader: true }],
  extracted: "# Title\n\nThe setup\n\nThe loss curve below shows it.\n\nTraining setup\n\nAs announced",
  tables: [{ id: "t1", tile: 4, rows: 5, cols: 4, cells: 20, emptyCells: 13, head: "h" }, { id: "t2", tile: 5, rows: 2, cols: 2, cells: 4, emptyCells: 0, head: "h" }],
  code: [{ id: "c1", tile: 2, lines: 1, chars: 212, collapsed: true, head: "def f(x): return" }, { id: "c2", tile: 3, lines: 4, chars: 60, collapsed: false, head: "import os" }],
  metrics: metrics(),
  ...overrides,
});
const summary = (issues: readonly JudgedIssue[]) => issues.map((item) => `${item.layer}/${item.kind}/${item.severity}/${item.invalid ? "invalid" : item.origin}:${item.evidence}`);

describe("issuesMatch", () => {
  it("without refs on either side: needs the same layer and kind", () => {
    expect(issuesMatch(issue(), issue({ evidence: "other words", note: "other" }))).toBe(true);
    expect(issuesMatch(issue(), issue({ layer: "rendering" }))).toBe(false);
    expect(issuesMatch(issue(), issue({ kind: "tables" }))).toBe(false);
    expect(issuesMatch(issue({ refs: undefined }), issue({ refs: [] }))).toBe(true);
  });

  it("with refs on both sides: needs refs in common, whatever the kinds and layers", () => {
    expect(issuesMatch(issue({ kind: "images", refs: ["o2", "o3"] }), issue({ kind: "images", refs: ["o3"] }))).toBe(true);
    expect(issuesMatch(issue({ kind: "images", layer: "content", refs: ["o3"] }), issue({ kind: "images", layer: "rendering", refs: ["o3"] }))).toBe(true);
    // The same embed filed as missing content by one and as "other" by the other.
    expect(issuesMatch(issue({ kind: "missing_content", refs: ["e1"] }), issue({ kind: "other", refs: ["e1"] }))).toBe(true);
    expect(issuesMatch(issue({ kind: "tables", layer: "rendering", refs: ["t1"] }), issue({ kind: "tables", layer: "content", refs: ["t1"] }))).toBe(true);
    expect(issuesMatch(issue({ kind: "images", refs: ["o2"] }), issue({ kind: "images", refs: ["o3"] }))).toBe(false);
  });

  it("refs on one side only: no match", () => {
    expect(issuesMatch(issue({ kind: "images", refs: ["o2"] }), issue({ kind: "images", refs: [] }))).toBe(false);
    expect(issuesMatch(issue({ kind: "images", refs: undefined }), issue({ kind: "images", refs: ["o3"] }))).toBe(false);
  });
});

describe("factSupported", () => {
  it.each([
    ["an unmatched original image", issue({ kind: "images", refs: ["o2"] }), true],
    ["a matched original image", issue({ kind: "images", refs: ["o1"] }), false],
    ["a broken reader image", issue({ layer: "rendering", kind: "images", refs: ["r2"] }), true],
    ["a reader image that loads", issue({ kind: "other", refs: ["r1"] }), false],
    ["an embed the reader does not show", issue({ refs: ["e1"] }), true],
    ["an embed the reader shows", issue({ refs: ["e2"] }), false],
  ])("citing %s: %s", (_label, candidate, expected) => {
    expect(factSupported(candidate, facts())).toBe(expected);
  });

  it.each([
    ["a table with empty cells", issue({ kind: "tables", refs: ["t1"] }), true],
    ["a table without empty cells", issue({ kind: "tables", refs: ["t2"] }), false],
    ["a code block shown as one line", issue({ layer: "rendering", kind: "code_or_math", refs: ["c1"] }), true],
    ["a code block with its lines", issue({ layer: "rendering", kind: "code_or_math", refs: ["c2"] }), false],
  ])("citing %s: %s", (_label, candidate, expected) => {
    expect(factSupported(candidate, facts())).toBe(expected);
  });

  it("a code/math or layout issue while collapsed code was measured", () => {
    expect(factSupported(issue({ layer: "rendering", kind: "code_or_math" }), facts({ metrics: metrics({ collapsedCode: 3 }) }))).toBe(true);
    expect(factSupported(issue({ kind: "layout" }), facts({ metrics: metrics({ collapsedCode: 1 }) }))).toBe(true);
    expect(factSupported(issue({ kind: "tables" }), facts({ metrics: metrics({ collapsedCode: 1 }) }))).toBe(false);
  });

  it("an unmatched original image or unshown embed supports an issue only in the article (unknown context: no support)", () => {
    const outside = facts({ extracted: "# Title\n\nThe setup" });
    expect(factSupported(issue({ kind: "images", refs: ["o2"] }), outside)).toBe(false);
    expect(factSupported(issue({ refs: ["e1"] }), outside)).toBe(false);
    const unknown = facts({ reference: facts().reference.map((image) => ({ ...image, context: "" })), embeds: facts().embeds.map((embed) => ({ ...embed, context: "" })) });
    expect(factSupported(issue({ kind: "images", refs: ["o2"] }), unknown)).toBe(false);
    expect(factSupported(issue({ refs: ["e1"] }), unknown)).toBe(false);
    // In the article, as in the default facts: supported.
    expect(factSupported(issue({ kind: "images", refs: ["o2"] }), facts())).toBe(true);
  });

  it("a rendering image issue while some reader image is broken, but not a content one", () => {
    const rendering = issue({ layer: "rendering", kind: "images" });
    expect(factSupported(rendering, facts({ metrics: metrics({ images: { total: 2, broken: 1, brokenSrc: ["b"] } }) }))).toBe(true);
    expect(factSupported(rendering, facts())).toBe(false);
    expect(factSupported(issue({ kind: "images" }), facts({ metrics: metrics({ images: { total: 2, broken: 1, brokenSrc: ["b"] } }) }))).toBe(false);
  });

  it("a table issue while some table has empty cells, in any layer", () => {
    const withEmpty = facts({ metrics: metrics({ emptyCellTables: { count: 1, samples: [{ table: 1, empty: 6, cells: 8 }] } }) });
    expect(factSupported(issue({ layer: "rendering", kind: "tables" }), withEmpty)).toBe(true);
    expect(factSupported(issue({ kind: "tables" }), withEmpty)).toBe(true);
    expect(factSupported(issue({ layer: "rendering", kind: "tables" }), facts())).toBe(false);
  });

  it.each([
    ["raw markup", metrics({ rawMarkup: { count: 1, samples: [{ pattern: "$$", text: "x" }] } })],
    ["math errors", metrics({ mathErrors: 2 })],
    ["unmarked lists", metrics({ unmarkedLists: 1 })],
  ])("a code/math or layout issue while %s were measured", (_label, measured) => {
    expect(factSupported(issue({ layer: "rendering", kind: "code_or_math" }), facts({ metrics: measured }))).toBe(true);
    expect(factSupported(issue({ kind: "layout" }), facts({ metrics: measured }))).toBe(true);
    expect(factSupported(issue({ kind: "tables" }), facts({ metrics: measured }))).toBe(false);
  });

  it("nothing supports an issue without a capture (text mode), or a code issue on a clean page", () => {
    expect(factSupported(issue({ refs: ["e1"] }), undefined)).toBe(false);
    expect(factSupported(issue({ layer: "rendering", kind: "code_or_math" }), facts())).toBe(false);
  });
});

describe("crossConfirm", () => {
  it("counts an issue both report once, keeping the confirmer's text and the more severe severity", () => {
    const screen = [issue({ layer: "rendering", kind: "tables", severity: "major", evidence: "screener words", note: "s", where: { image: "rendered", tile: 4 } })];
    const confirm = [issue({ layer: "rendering", kind: "tables", severity: "minor", evidence: "confirmer words", note: "c", where: { image: "rendered", tile: 5 } })];
    expect(crossConfirm(screen, confirm, undefined)).toEqual([{ ...confirm[0], severity: "major", origin: "both" }]);
    expect(crossConfirm(confirm, screen, undefined)).toEqual([{ ...screen[0], severity: "major", origin: "both" }]);
  });

  it("counts a figure both report once even when they disagree on the layer, in the confirmer's layer", () => {
    const merged = crossConfirm([issue({ kind: "images", layer: "content", refs: ["o2"], evidence: "s" })], [issue({ kind: "images", layer: "rendering", refs: ["o2"], evidence: "c", severity: "minor" })], facts());
    expect(summary(merged)).toEqual(["rendering/images/major/both:c"]);
  });

  it("counts a collapsed code block once when only one side reports it: a fact keeps it major", () => {
    const merged = crossConfirm([], [issue({ layer: "rendering", kind: "code_or_math", refs: ["c1"], evidence: "def f" })], facts());
    expect(summary(merged)).toEqual(["rendering/code_or_math/major/one-sided-fact:def f"]);
  });

  it("does not match issues whose refs both exist and do not intersect: each is one-sided", () => {
    const merged = crossConfirm([issue({ kind: "images", refs: ["o2"], evidence: "s" })], [issue({ kind: "images", refs: ["o1"], evidence: "c" })], facts());
    expect(summary(merged)).toEqual(["content/images/minor/one-sided-downgraded:c", "content/images/major/one-sided-fact:s"]);
  });

  it("keeps a one-sided major issue major when a fact supports it, and downgrades it otherwise, remembering it was major", () => {
    const merged = crossConfirm([], [issue({ refs: ["e1"], evidence: "embed" }), issue({ evidence: "callout" })], facts());
    expect(summary(merged)).toEqual(["content/missing_content/major/one-sided-fact:embed", "content/missing_content/minor/one-sided-downgraded:callout"]);
    expect(merged[0]).not.toHaveProperty("originalSeverity");
    expect(merged[1]?.originalSeverity).toBe("major");
  });

  it("counts a one-sided minor issue as it is, from either side", () => {
    const merged = crossConfirm([issue({ severity: "minor", kind: "layout", evidence: "s" })], [issue({ severity: "minor", kind: "metadata", layer: "metadata", subject: "author", evidence: "c" })], facts());
    expect(summary(merged)).toEqual(["metadata/metadata/minor/one-sided:c", "content/layout/minor/one-sided:s"]);
  });

  it("matches greedily one to one, the confirmer's issues first", () => {
    const screen = [issue({ evidence: "s1" }), issue({ evidence: "s2", severity: "minor" })];
    const confirm = [issue({ evidence: "c1", severity: "minor" }), issue({ evidence: "c2", severity: "minor" }), issue({ evidence: "c3", severity: "minor" })];
    // c1 takes s1 (major wins), c2 takes s2, c3 is left alone.
    expect(summary(crossConfirm(screen, confirm, undefined))).toEqual(["content/missing_content/major/both:c1", "content/missing_content/minor/both:c2", "content/missing_content/minor/one-sided:c3"]);
  });

  it("pairs the closest issue when several match by refs, and never lifts a capped kept-boundary issue to major", () => {
    const allBroken = issue({ layer: "rendering", kind: "images", severity: "major", refs: ["r1", "r2"], evidence: "all images" });
    const keptThumbnail = issue({ layer: "rendering", kind: "extra_content", severity: "minor", refs: ["r2"], evidence: "thumbnail s" });
    const confirmThumbnail = issue({ layer: "rendering", kind: "extra_content", severity: "minor", refs: ["r2"], evidence: "thumbnail c" });
    expect(summary(crossConfirm([allBroken, keptThumbnail], [confirmThumbnail], facts()))).toEqual(["rendering/extra_content/minor/both:thumbnail c", "rendering/images/major/one-sided-fact:all images"]);
    // Even paired with a major issue of another kind, kept-boundary content stays minor; an author issue too.
    expect(summary(crossConfirm([allBroken], [confirmThumbnail], facts()))).toEqual(["rendering/extra_content/minor/both:thumbnail c"]);
    const author = issue({ layer: "metadata", kind: "metadata", subject: "author", severity: "minor", refs: ["r1"], evidence: "by" });
    expect(summary(crossConfirm([allBroken], [author], facts()))).toEqual(["metadata/metadata/minor/both:by"]);
  });

  it("dedupes one-sided issues with the same layer, kind and evidence", () => {
    const twice = issue({ kind: "layout", severity: "minor", evidence: "same", refs: ["r1"] });
    const merged = crossConfirm([twice], [twice, { ...twice, refs: ["r2"] }], facts());
    // The first confirmer copy matches the screener's; the second confirmer copy has disjoint refs and the same evidence as the pair: kept once.
    expect(summary(merged)).toEqual(["content/layout/minor/both:same"]);
  });

  it("leaves invalid issues out of the matching and keeps them last, deduped, for the record", () => {
    const bad = issue({ evidence: "paraphrase", invalid: { reason: "evidence-not-verbatim", detail: "x" } });
    const merged = crossConfirm([bad, issue({ evidence: "real", severity: "minor" })], [bad], undefined);
    expect(summary(merged)).toEqual(["content/missing_content/minor/one-sided:real", "content/missing_content/major/invalid:paraphrase"]);
    // An invalid confirmer issue does not confirm a valid screener one.
    expect(summary(crossConfirm([issue({ evidence: "s" })], [bad], undefined))).toEqual(["content/missing_content/minor/one-sided-downgraded:s", "content/missing_content/major/invalid:paraphrase"]);
  });

  it("counts origins over the counted issues only", () => {
    const merged = crossConfirm([issue({ evidence: "s" }), issue({ evidence: "x", invalid: { reason: "unknown-ref", detail: "x" } })], [issue({ evidence: "c" }), issue({ kind: "tables", evidence: "t" })], facts({ metrics: metrics({ emptyCellTables: { count: 1, samples: [] } }) }));
    expect(originCounts(merged)).toEqual({ both: 1, "one-sided-fact": 1, "one-sided-downgraded": 0, "one-sided": 0 });
  });
});
