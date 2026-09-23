import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EVIDENCE_MAX, buildReportData, caseKinds, loadReportData } from "./data";
import { AT, baseline, corpus, emptyData, failedResult, hybridData, hybridResult, legacyData, legacyResult, legacyResults, opinion } from "./fixtures";

describe("buildReportData (legacy results, no opinions on disk)", () => {
  const data = legacyData();

  it("counts verdicts, errors and issues", () => {
    expect(data.generatedAt).toBe(AT);
    expect(data.totals).toEqual({ cases: 5, PASS: 2, MINOR: 1, MAJOR: 2, errors: 1, issues: 6, majorIssues: 3, unverified: 1, escalated: 0, disputed: 0 });
    expect(data.errors).toEqual([{ slug: "zeta-post", url: "https://zeta.example/zeta-post", error: "codex exec exited with 1: boom" }]);
    expect(data.cases.map((row) => row.slug)).toEqual(["alpha-post", "beta-post", "delta-post", "epsilon-post", "gamma-post"]);
  });

  it("builds one row per case with the corpus url, kinds at their worst severity and clipped evidence", () => {
    const gamma = data.cases.find((row) => row.slug === "gamma-post")!;
    expect(gamma.url).toBe("https://gamma.example/gamma-post");
    expect(gamma.kinds).toEqual([{ kind: "missing_content", severity: "major" }, { kind: "code_or_math", severity: "major" }]);
    expect(gamma.issues[0]!.evidence).toHaveLength(EVIDENCE_MAX);
    expect(gamma.issues[0]!.evidence.endsWith("…")).toBe(true);
    expect(gamma.issues[0]!.verified).toBe(false);
    expect(gamma.model).toBe("gpt-5.6-sol");
    expect(gamma.rubricVersion).toBe("2026-09-23.3");
  });

  it("treats a legacy result as one codex opinion that decided the case", () => {
    const beta = data.cases.find((row) => row.slug === "beta-post")!;
    expect(beta.decidedBy).toBe("codex");
    expect(beta.disputed).toBe(false);
    expect(beta.opinions).toEqual([{ backend: "codex", model: "gpt-5.6-sol", verdict: "MINOR", issues: beta.issues, summary: beta.summary, tokens: 1000, wallMs: 2000 }]);
    expect(data.byBackend).toEqual([{ backend: "codex", models: ["gpt-5.6-sol"], opinions: 5, decided: 5, tokens: 5000, wallMs: 10000 }]);
    expect(data.agreement).toEqual({ compared: 0, agree: 0, disagree: 0, matrix: { PASS: { PASS: 0, MINOR: 0, MAJOR: 0 }, MINOR: { PASS: 0, MINOR: 0, MAJOR: 0 }, MAJOR: { PASS: 0, MINOR: 0, MAJOR: 0 } } });
  });

  it("ranks kinds by cases, then major issues, then issues, then name", () => {
    expect(data.byKind).toEqual([
      { kind: "missing_content", cases: 1, issues: 2, major: 1, minor: 1 },
      { kind: "code_or_math", cases: 1, issues: 1, major: 1, minor: 0 },
      { kind: "metadata", cases: 1, issues: 1, major: 1, minor: 0 },
      { kind: "images", cases: 1, issues: 1, major: 0, minor: 1 },
      { kind: "layout", cases: 1, issues: 1, major: 0, minor: 1 },
    ]);
  });

  it("compares every case to the baseline", () => {
    const deltas = Object.fromEntries(data.cases.map((row) => [row.slug, [row.delta, row.baselineVerdict]]));
    expect(deltas).toEqual({ "alpha-post": ["same", "PASS"], "beta-post": ["improved", "MAJOR"], "delta-post": ["regressed", "MINOR"], "epsilon-post": ["new", undefined], "gamma-post": ["regressed", "PASS"] });
    expect(data.regressions).toEqual([{ slug: "delta-post", from: "MINOR", to: "MAJOR" }, { slug: "gamma-post", from: "PASS", to: "MAJOR" }]);
    expect(data.improvements).toEqual([{ slug: "beta-post", from: "MAJOR", to: "MINOR" }]);
  });

  it("leaves the url empty for a result the corpus does not know", () => {
    const stray = buildReportData({ results: [legacyResult("stray", "PASS")], baseline: {}, corpus: [], generatedAt: AT });
    expect(stray.cases[0]!.url).toBe("");
    expect(stray.cases[0]!.delta).toBe("new");
  });
});

describe("buildReportData (hybrid results)", () => {
  const data = hybridData();

  it("reads decidedBy, disputed and the compact opinions from the resolution", () => {
    const beta = data.cases.find((row) => row.slug === "beta-post")!;
    expect(beta.verdict).toBe("MAJOR");
    expect(beta.decidedBy).toBe("codex");
    expect(beta.disputed).toBe(true);
    expect(beta.opinions.map((o) => [o.backend, o.model, o.verdict, o.tokens, o.costUsd, o.wallMs])).toEqual([["claude", "claude-haiku-4-5", "MINOR", 500, 0.01, 800], ["codex", "gpt-5.6-sol", "MAJOR", 1500, undefined, 3000]]);
    expect(data.totals).toMatchObject({ cases: 5, PASS: 3, MINOR: 0, MAJOR: 2, escalated: 3, disputed: 2 });
  });

  it("sums tokens, cost and wall time per backend and counts what each decided", () => {
    expect(data.byBackend).toEqual([
      { backend: "claude", models: ["claude-haiku-4-5"], opinions: 4, decided: 1, tokens: 2000, costUsd: 0.04, wallMs: 3200 },
      { backend: "codex", models: ["gpt-5.6-sol"], opinions: 4, decided: 4, tokens: 5500, wallMs: 11000 },
    ]);
  });

  it("builds the screen-vs-confirm confusion matrix from the first and last opinion", () => {
    expect(data.agreement.compared).toBe(3);
    expect(data.agreement.agree).toBe(1);
    expect(data.agreement.disagree).toBe(2);
    expect(data.agreement.matrix).toEqual({ PASS: { PASS: 0, MINOR: 0, MAJOR: 0 }, MINOR: { PASS: 1, MINOR: 0, MAJOR: 1 }, MAJOR: { PASS: 0, MINOR: 0, MAJOR: 1 } });
  });

  it("keeps a legacy row alongside hybrid rows", () => {
    const epsilon = data.cases.find((row) => row.slug === "epsilon-post")!;
    expect(epsilon.opinions).toHaveLength(1);
    expect(epsilon.decidedBy).toBe("codex");
  });

  it("handles an empty run", () => {
    const empty = emptyData();
    expect(empty.cases).toEqual([]);
    expect(empty.totals.cases).toBe(0);
    expect(empty.byKind).toEqual([]);
    expect(empty.byBackend).toEqual([]);
    expect(empty.agreement.compared).toBe(0);
  });
});

describe("caseKinds", () => {
  it("keeps first-seen order and upgrades a kind to major once any issue of it is major", () => {
    expect(caseKinds([{ kind: "layout", severity: "minor", note: "", evidence: "", verified: true }, { kind: "tables", severity: "minor", note: "", evidence: "", verified: true }, { kind: "layout", severity: "major", note: "", evidence: "", verified: true }]))
      .toEqual([{ kind: "layout", severity: "major" }, { kind: "tables", severity: "minor" }]);
  });
});

describe("loadReportData", () => {
  const dirs: string[] = [];
  const tempDir = () => { const dir = mkdtempSync(join(tmpdir(), "judge-report-")); dirs.push(dir); return dir; };
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  it("reads results, baseline and corpus from disk", () => {
    const root = tempDir();
    const outDir = join(root, "out");
    mkdirSync(outDir);
    for (const result of [...legacyResults(), failedResult("zeta-post"), hybridResult("omega-post", [opinion("claude", "PASS")])]) writeFileSync(join(outDir, `${result.slug}.json`), JSON.stringify(result));
    writeFileSync(join(outDir, "notes.txt"), "ignored");
    writeFileSync(join(root, "baseline.json"), JSON.stringify(baseline));
    writeFileSync(join(root, "corpus.json"), JSON.stringify(corpus));
    const data = loadReportData({ outDir, baselinePath: join(root, "baseline.json"), corpusPath: join(root, "corpus.json"), generatedAt: AT });
    expect(data.totals).toMatchObject({ cases: 6, errors: 1 });
    expect(data.cases.find((row) => row.slug === "omega-post")!.decidedBy).toBe("claude");
    expect(data.generatedAt).toBe(AT);
  });

  it("fails loudly when the out directory, the baseline or a result file is unusable", () => {
    const root = tempDir();
    writeFileSync(join(root, "baseline.json"), "{}");
    writeFileSync(join(root, "corpus.json"), "[]");
    expect(() => loadReportData({ outDir: join(root, "missing"), baselinePath: join(root, "baseline.json"), corpusPath: join(root, "corpus.json") })).toThrow(/does not exist: run the judge first/);
    const outDir = join(root, "out");
    mkdirSync(outDir);
    writeFileSync(join(outDir, "broken.json"), "{not json");
    expect(() => loadReportData({ outDir, baselinePath: join(root, "baseline.json"), corpusPath: join(root, "corpus.json") })).toThrow(/broken\.json is not valid JSON/);
    expect(() => loadReportData({ outDir, baselinePath: join(root, "nope.json"), corpusPath: join(root, "corpus.json") })).toThrow(/nope\.json does not exist/);
  });
});
