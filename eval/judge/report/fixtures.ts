// Small in-memory judge results for the report tests: the legacy shape (no opinions on disk), the
// hybrid shape (screen + confirm opinions) and a failed case. Nothing here comes from a real page.
import type { FailedCase, JudgedCase, JudgedIssue, Opinion } from "../cache";
import { buildReportData, type BaselineEntry, type CorpusEntry, type ReportData } from "./data";

export const RUBRIC = "2026-09-23.3";
export const AT = "2026-09-23T10:00:00.000Z";

export const issue = (kind: JudgedIssue["kind"], severity: JudgedIssue["severity"] = "minor", extra: Partial<JudgedIssue> = {}): JudgedIssue => ({ kind, severity, evidence: `quote for ${kind}`, note: `${kind} is wrong`, verified: true, ...extra });

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
