// Small in-memory judge results for the report tests: the legacy shape (no opinions on disk), the
// hybrid shape (screen + confirm opinions) and a failed case. Nothing here comes from a real page.
import type { RenderMetrics } from "../../render/types";
import type { FailedCase, JudgedCase, JudgedIssue, Opinion } from "../cache";
import type { RenderSummary } from "../visual";
import { buildReportData, type BaselineEntry, type CorpusEntry, type ReportData } from "./data";

export const RUBRIC = "2026-09-23.3";
export const AT = "2026-09-23T10:00:00.000Z";

export const issue = (kind: JudgedIssue["kind"], severity: JudgedIssue["severity"] = "minor", extra: Partial<JudgedIssue> = {}): JudgedIssue => ({ layer: kind === "metadata" ? "metadata" : "content", kind, severity, evidence: `quote for ${kind}`, note: `${kind} is wrong`, verified: true, ...extra });

export const legacyResult = (slug: string, verdict: JudgedCase["verdict"], issues: JudgedIssue[] = [], extra: Partial<JudgedCase> = {}): JudgedCase => ({
  key: `k-${slug}`, slug, model: "default", resolvedModel: "gpt-5.6-sol", rubricVersion: RUBRIC, truncated: false, tokens: 1000, wallMs: 2000, judgedAt: AT,
  verdict, issues, summary: `${slug} reads ${verdict === "PASS" ? "cleanly" : "badly"}.`, ...extra,
});

export const opinion = (backend: Opinion["backend"], verdict: Opinion["verdict"], issues: JudgedIssue[] = [], extra: Partial<Opinion> = {}): Opinion => ({
  backend, model: backend === "claude" ? "haiku" : "default", resolvedModel: backend === "claude" ? "claude-haiku-4-5" : "gpt-5.6-sol", verdict, issues, summary: `${backend} says ${verdict}`, tokens: backend === "claude" ? 500 : 1500, wallMs: backend === "claude" ? 800 : 3000,
  ...(backend === "claude" ? { costUsd: 0.01 } : {}), ...extra,
});

/** A hybrid case: the final verdict/issues are the confirming (last) opinion's. */
export const hybridResult = (slug: string, opinions: Opinion[], extra: Partial<JudgedCase> = {}): JudgedCase => {
  const final = opinions[opinions.length - 1]!;
  const disputed = opinions.length > 1 && new Set(opinions.map((o) => o.verdict)).size > 1;
  return {
    ...legacyResult(slug, final.verdict, final.issues, { summary: final.summary, tokens: opinions.reduce((s, o) => s + (o.tokens ?? 0), 0) }),
    opinions, resolution: { policy: opinions.length > 1 ? "screen-then-confirm" : "single", from: final.backend, disputed }, ...extra,
  };
};

export const failedResult = (slug: string): FailedCase => ({ key: `k-${slug}`, slug, model: "default", rubricVersion: RUBRIC, truncated: false, wallMs: 5, judgedAt: AT, error: "codex exec exited with 1: boom" });

export const corpus: CorpusEntry[] = ["alpha-post", "beta-post", "gamma-post", "delta-post", "epsilon-post", "zeta-post"].map((slug) => ({ slug, url: `https://${slug.split("-")[0]}.example/${slug}` }));

export const baseline: Record<string, BaselineEntry> = {
  "alpha-post": { verdict: "PASS", kinds: [] },
  "beta-post": { verdict: "MAJOR", kinds: ["missing_content"] },
  "gamma-post": { verdict: "PASS", kinds: [] },
  "delta-post": { verdict: "MINOR", kinds: ["layout"] },
};

export const legacyResults = (): JudgedCase[] => [
  legacyResult("alpha-post", "PASS"),
  legacyResult("beta-post", "MINOR", [issue("layout")]),
  legacyResult("gamma-post", "MAJOR", [issue("missing_content", "major", { evidence: "x".repeat(250), verified: false }), issue("missing_content", "minor"), issue("code_or_math", "major")]),
  legacyResult("delta-post", "MAJOR", [issue("metadata", "major", { evidence: "<script>alert(1)</script> & \"quotes\"" })]),
  legacyResult("epsilon-post", "PASS", [issue("images")]),
];

export const legacyData = (): ReportData => buildReportData({ results: [...legacyResults(), failedResult("zeta-post")], baseline, corpus, generatedAt: AT });

export const hybridResults = (): JudgedCase[] => [
  hybridResult("alpha-post", [opinion("claude", "PASS")]),
  hybridResult("beta-post", [opinion("claude", "MINOR", [issue("layout")]), opinion("codex", "MAJOR", [issue("missing_content", "major")])]),
  hybridResult("gamma-post", [opinion("claude", "MAJOR", [issue("tables", "major")]), opinion("codex", "MAJOR", [issue("tables", "major"), issue("layout")])]),
  hybridResult("delta-post", [opinion("claude", "MINOR", [issue("metadata")]), opinion("codex", "PASS")]),
  legacyResult("epsilon-post", "PASS"),
];

export const hybridData = (): ReportData => buildReportData({ results: hybridResults(), baseline, corpus, generatedAt: AT });

export const emptyData = (): ReportData => buildReportData({ results: [], baseline: {}, corpus: [], generatedAt: AT });

export const renderMetrics = (overrides: Partial<RenderMetrics> = {}): RenderMetrics => ({
  images: { total: 3, broken: 0, brokenSrc: [] }, overflow: { count: 0, samples: [] }, rawMarkup: { count: 0, samples: [] },
  mathErrors: 0, unmarkedLists: 0, collapsedCode: 0, emptyCellTables: { count: 0, samples: [] }, emptyHeadings: 0, duplicateTitleHeadings: 0,
  counts: { codeBlocks: 1, tables: 0, figures: 3, lists: 2, footnotes: 0, headings: 5, words: 1200 }, height: 6000, ...overrides,
});

export const renderSummary = (metrics: RenderMetrics = renderMetrics(), extra: Partial<RenderSummary> = {}): RenderSummary => ({
  manifestKey: "mk", tiles: { rendered: ["rendered-01.png", "rendered-02.png", "rendered-03.png"], reference: ["reference-01.png", "reference-02.png"] },
  sent: { rendered: 3, reference: 1 }, truncated: { rendered: false, reference: false }, metrics, warnings: [], failedReferenceRequests: 0, ...extra,
});

export const inventories = (): Pick<RenderSummary, "images" | "embeds"> => ({
  images: {
    rendered: [{ id: "r1", tile: 1, src: "https://alpha.example/fig1.png", alt: "Figure 1", caption: "The setup", broken: false }, { id: "r2", tile: 2, src: "https://alpha.example/fig2.png", alt: "", caption: "Figure 2: the loss curve", broken: true }],
    reference: [{ id: "o1", tile: 1, src: "https://alpha.example/fig1.png", candidates: [], alt: "Figure 1", width: 640, height: 420, matchedBy: "r1" }, { id: "o2", tile: 2, src: "https://alpha.example/fig3.png", candidates: [], alt: "Figure 3", width: 800, height: 500, matchedBy: null }],
  },
  embeds: [{ kind: "iframe", tag: "iframe", src: "https://www.youtube.com/embed/x", host: "www.youtube.com", context: "Training setup and the demo video", representedInReader: false }],
});

/** Two visual cases: one with a broken image and raw markup the judge placed on tiles, one clean; plus a text-mode case. */
export const visualResults = (): JudgedCase[] => [
  hybridResult("alpha-post", [opinion("claude", "MAJOR", [issue("images", "major", { evidence: "Figure 2: the loss curve", where: { image: "rendered", tile: 2 } }), issue("code_or_math", "minor", { evidence: "$$x^2$$", where: { image: "rendered", tile: 3 } }), issue("layout", "minor", { where: null })], { images: 4 }), opinion("codex", "MAJOR", [issue("images", "major", { evidence: "Figure 2: the loss curve", where: { image: "rendered", tile: 2 } }), issue("images", "minor", { evidence: "Figure 2", where: { image: "reference", tile: 1 } })], { images: 4 })], {
    mode: "visual", rubricVersion: "2026-10-08.4",
    render: renderSummary(renderMetrics({ images: { total: 3, broken: 1, brokenSrc: ["https://alpha.example/fig2.png"] }, rawMarkup: { count: 2, samples: [{ pattern: "$$", text: "where $$x^2$$ grows" }] }, overflow: { count: 1, samples: [{ path: "article > pre", width: 1500 }] } }), inventories()),
  }),
  hybridResult("beta-post", [opinion("claude", "PASS", [], { images: 4 })], { mode: "visual", rubricVersion: "2026-10-08.4", render: renderSummary(renderMetrics({ mathErrors: 1 })) }),
  legacyResult("gamma-post", "PASS"),
];

export const visualData = (): ReportData => buildReportData({ results: visualResults(), baseline, corpus, generatedAt: AT });

/**
 * Rubric v6 cases: layer verdicts on the case and its opinions, a valid and an invalid issue each
 * (the invalid one struck out with its reason), and a baseline entry with layers to compare against.
 */
export const v6Results = (): JudgedCase[] => {
  const brokenFigure = issue("images", "major", { layer: "rendering", evidence: "Figure 2: the loss curve", where: { image: "rendered", tile: 2 }, refs: ["r2"] });
  const missingFigure = issue("images", "major", { layer: "content", evidence: "Figure 1", where: null, refs: ["o1"], invalid: { reason: "contradicts-image-facts", detail: "o1 is in the reader as r1, not broken" } });
  const byline = issue("metadata", "minor", { layer: "metadata", evidence: "By Ada", where: null, refs: [] });
  const paraphrase = issue("layout", "minor", { layer: "rendering", evidence: "not in any text", where: null, refs: [], verified: false, invalid: { reason: "evidence-not-verbatim", detail: "the evidence quote is not in SOURCE, EXTRACTED or RENDERED TEXT" } });
  const alphaLayers = { content: "PASS", metadata: "MINOR", rendering: "MAJOR" } as const;
  const betaLayers = { content: "PASS", metadata: "PASS", rendering: "PASS" } as const;
  return [
    hybridResult("alpha-post", [opinion("claude", "MAJOR", [brokenFigure, missingFigure], { layers: { content: "PASS", metadata: "PASS", rendering: "MAJOR" }, images: 4 }), opinion("codex", "MINOR", [brokenFigure, byline, missingFigure], { layers: alphaLayers, images: 4 })], {
      mode: "visual", rubricVersion: "2026-10-10.7", layers: alphaLayers, render: renderSummary(renderMetrics({ images: { total: 2, broken: 1, brokenSrc: ["https://alpha.example/fig2.png"] } }), inventories()),
      // Cross-confirmed: the broken figure from both, the byline from one side, the invalid issue kept for the record.
      verdict: "MAJOR", summary: "codex says MINOR",
      issues: [{ ...brokenFigure, origin: "both" }, { ...byline, origin: "one-sided" }, missingFigure],
      resolution: { policy: "screen-then-confirm", from: "merged", disputed: true },
    }),
    hybridResult("beta-post", [opinion("claude", "PASS", [paraphrase], { layers: betaLayers, images: 4 })], { mode: "visual", rubricVersion: "2026-10-09.6", layers: betaLayers, render: renderSummary(renderMetrics(), inventories()) }),
  ];
};

export const v6Baseline: Record<string, BaselineEntry> = {
  "alpha-post": { verdict: "MAJOR", kinds: ["images"], layers: { content: "PASS", metadata: "PASS", rendering: "MAJOR" } },
  "beta-post": { verdict: "PASS", kinds: [] },
};

export const v6Data = (): ReportData => buildReportData({ results: v6Results(), baseline: v6Baseline, corpus, generatedAt: AT });
