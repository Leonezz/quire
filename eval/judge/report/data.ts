// The structured report: every judged case in eval/judge/out folded into one plain object that the
// HTML page, the GitHub issue and the publisher read. Pure apart from loadReportData, which only
// reads the three files. Runtime imports are deliberately none (types only): publish.mjs loads this
// module straight through Node's type stripping, which cannot resolve the extensionless imports of
// the judge's other modules.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { BackendId, JudgeResult, JudgedCase, JudgedIssue, Opinion } from "../cache";
import type { Severity, Verdict } from "../rubric";

export const VERDICT_ORDER: readonly Verdict[] = ["PASS", "MINOR", "MAJOR"];
export const EVIDENCE_MAX = 200;
export type Delta = "regressed" | "improved" | "same" | "new";

export interface CaseKind { kind: string; severity: Severity }
export interface CaseIssue { kind: string; severity: Severity; note: string; evidence: string; verified: boolean }
/** One backend's answer, compact; legacy results (no opinions on disk) get one synthesized from the case itself. */
export interface CaseOpinion {
  backend: BackendId;
  model: string;
  verdict: Verdict;
  issues: CaseIssue[];
  summary: string;
  tokens?: number;
  costUsd?: number;
  wallMs: number;
}
export interface CaseRow {
  slug: string;
  url: string;
  verdict: Verdict;
  /** Distinct kinds, each with the worst severity reported for it. */
  kinds: CaseKind[];
  summary: string;
  issues: CaseIssue[];
  decidedBy: BackendId;
  disputed: boolean;
  opinions: CaseOpinion[];
  baselineVerdict?: Verdict;
  delta: Delta;
  model: string;
  rubricVersion: string;
  judgedAt: string;
  truncated: boolean;
  tokens?: number;
  wallMs: number;
}
export interface ErrorRow { slug: string; url: string; error: string }
export interface Totals {
  cases: number;
  PASS: number;
  MINOR: number;
  MAJOR: number;
  errors: number;
  issues: number;
  majorIssues: number;
  unverified: number;
  /** Cases that gathered two or more opinions. */
  escalated: number;
  disputed: number;
}
export interface KindStat { kind: string; cases: number; issues: number; major: number; minor: number }
export interface BackendStat {
  backend: BackendId;
  models: string[];
  opinions: number;
  /** Cases whose final verdict is this backend's. */
  decided: number;
  tokens: number;
  /** Undefined when no opinion of this backend reported a cost (Codex reports none). */
  costUsd?: number;
  wallMs: number;
}
export interface Agreement {
  compared: number;
  agree: number;
  disagree: number;
  /** matrix[screen verdict][confirm verdict] = cases; screen is the first opinion asked, confirm the last. */
  matrix: Record<Verdict, Record<Verdict, number>>;
}
export interface VerdictChange { slug: string; from: Verdict; to: Verdict }
export interface ReportData {
  generatedAt: string;
  cases: CaseRow[];
  totals: Totals;
  byKind: KindStat[];
  byBackend: BackendStat[];
  agreement: Agreement;
  regressions: VerdictChange[];
  improvements: VerdictChange[];
  errors: ErrorRow[];
}

export interface BaselineEntry { verdict: Verdict; kinds: string[] }
export interface CorpusEntry { slug: string; url: string }
export interface BuildInput {
  results: readonly JudgeResult[];
  baseline: Readonly<Record<string, BaselineEntry>>;
  corpus: readonly CorpusEntry[];
  generatedAt?: string;
}

const RANK: Record<Verdict, number> = { PASS: 0, MINOR: 1, MAJOR: 2 };
const isJudged = (result: JudgeResult): result is JudgedCase => "verdict" in result;
const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);
const clipEvidence = (text: string) => (text.length <= EVIDENCE_MAX ? text : `${text.slice(0, EVIDENCE_MAX - 1)}…`);

const toIssue = (issue: JudgedIssue): CaseIssue => ({ kind: issue.kind, severity: issue.severity, note: issue.note, evidence: clipEvidence(issue.evidence), verified: issue.verified });

/** Distinct kinds in first-seen order, each carrying "major" when any of its issues is major. */
export function caseKinds(issues: readonly CaseIssue[]): CaseKind[] {
  return issues.reduce<CaseKind[]>((kinds, issue) => {
    const known = kinds.find((entry) => entry.kind === issue.kind);
    if (!known) return [...kinds, { kind: issue.kind, severity: issue.severity }];
    if (known.severity === "major" || issue.severity === "minor") return kinds;
    return kinds.map((entry) => (entry.kind === issue.kind ? { ...entry, severity: "major" } : entry));
  }, []);
}

const toOpinion = (opinion: Opinion): CaseOpinion => ({
  backend: opinion.backend, model: opinion.resolvedModel ?? opinion.model, verdict: opinion.verdict,
  issues: opinion.issues.map(toIssue), summary: opinion.summary, wallMs: opinion.wallMs,
  ...(opinion.tokens !== undefined ? { tokens: opinion.tokens } : {}),
  ...(opinion.costUsd !== undefined ? { costUsd: opinion.costUsd } : {}),
});

/** The opinions on disk, or the case itself as one Codex opinion when it predates the hybrid judge. */
function opinionsOf(result: JudgedCase): CaseOpinion[] {
  if (result.opinions?.length) return result.opinions.map(toOpinion);
  return [{
    backend: "codex", model: result.resolvedModel ?? result.model, verdict: result.verdict,
    issues: result.issues.map(toIssue), summary: result.summary, wallMs: result.wallMs,
    ...(result.tokens !== undefined ? { tokens: result.tokens } : {}),
  }];
}

function deltaOf(verdict: Verdict, baseline: BaselineEntry | undefined): Delta {
  if (!baseline) return "new";
  if (RANK[verdict] > RANK[baseline.verdict]) return "regressed";
  if (RANK[verdict] < RANK[baseline.verdict]) return "improved";
  return "same";
}

function toRow(result: JudgedCase, url: string, baseline: BaselineEntry | undefined): CaseRow {
  const issues = result.issues.map(toIssue);
  const opinions = opinionsOf(result);
  return {
    slug: result.slug, url, verdict: result.verdict, kinds: caseKinds(issues), summary: result.summary, issues,
    decidedBy: result.resolution?.from ?? "codex", disputed: result.resolution?.disputed ?? false, opinions,
    ...(baseline ? { baselineVerdict: baseline.verdict } : {}),
    delta: deltaOf(result.verdict, baseline),
    model: result.resolvedModel ?? result.model, rubricVersion: result.rubricVersion, judgedAt: result.judgedAt, truncated: result.truncated,
    ...(result.tokens !== undefined ? { tokens: result.tokens } : {}),
    wallMs: result.wallMs,
  };
}

function kindStats(cases: readonly CaseRow[]): KindStat[] {
  const kinds = [...new Set(cases.flatMap((row) => row.issues.map((issue) => issue.kind)))];
  return kinds.map((kind) => {
    const issues = cases.flatMap((row) => row.issues.filter((issue) => issue.kind === kind));
    const major = issues.filter((issue) => issue.severity === "major").length;
    return { kind, cases: cases.filter((row) => row.issues.some((issue) => issue.kind === kind)).length, issues: issues.length, major, minor: issues.length - major };
  }).sort((a, b) => b.cases - a.cases || b.major - a.major || b.issues - a.issues || a.kind.localeCompare(b.kind));
}

function backendStats(cases: readonly CaseRow[]): BackendStat[] {
  const backends = [...new Set(cases.flatMap((row) => row.opinions.map((opinion) => opinion.backend)))].sort();
  return backends.map((backend) => {
    const opinions = cases.flatMap((row) => row.opinions.filter((opinion) => opinion.backend === backend));
    const costs = opinions.map((opinion) => opinion.costUsd).filter((cost): cost is number => cost !== undefined);
    return {
      backend, models: [...new Set(opinions.map((opinion) => opinion.model))].sort(), opinions: opinions.length,
      decided: cases.filter((row) => row.decidedBy === backend).length,
      tokens: sum(opinions.map((opinion) => opinion.tokens ?? 0)),
      ...(costs.length ? { costUsd: Math.round(sum(costs) * 1e6) / 1e6 } : {}),
      wallMs: sum(opinions.map((opinion) => opinion.wallMs)),
    };
  });
}

const emptyMatrix = (): Agreement["matrix"] => Object.fromEntries(VERDICT_ORDER.map((row) => [row, Object.fromEntries(VERDICT_ORDER.map((column) => [column, 0]))])) as Agreement["matrix"];

function agreementOf(cases: readonly CaseRow[]): Agreement {
  const compared = cases.filter((row) => row.opinions.length >= 2);
  const matrix = emptyMatrix();
  for (const row of compared) {
    const screen = row.opinions[0]!.verdict;
    const confirm = row.opinions[row.opinions.length - 1]!.verdict;
    matrix[screen][confirm] += 1;
  }
  const agree = compared.filter((row) => row.opinions[0]!.verdict === row.opinions[row.opinions.length - 1]!.verdict).length;
  return { compared: compared.length, agree, disagree: compared.length - agree, matrix };
}

/** The report from results already in memory; loadReportData reads them from disk. */
export function buildReportData({ results, baseline, corpus, generatedAt }: BuildInput): ReportData {
  const urls = new Map(corpus.map((entry) => [entry.slug, entry.url]));
  const sorted = [...results].sort((a, b) => a.slug.localeCompare(b.slug));
  const cases = sorted.filter(isJudged).map((result) => toRow(result, urls.get(result.slug) ?? "", baseline[result.slug]));
  const errors = sorted.filter((result): result is Exclude<JudgeResult, JudgedCase> => !isJudged(result)).map((result) => ({ slug: result.slug, url: urls.get(result.slug) ?? "", error: result.error }));
  const count = (verdict: Verdict) => cases.filter((row) => row.verdict === verdict).length;
  const issues = cases.flatMap((row) => row.issues);
  const change = (delta: Delta) => cases.filter((row) => row.delta === delta).map((row) => ({ slug: row.slug, from: row.baselineVerdict!, to: row.verdict }));
  return {
    generatedAt: generatedAt ?? new Date().toISOString(),
    cases,
    totals: {
      cases: cases.length, PASS: count("PASS"), MINOR: count("MINOR"), MAJOR: count("MAJOR"), errors: errors.length,
      issues: issues.length, majorIssues: issues.filter((issue) => issue.severity === "major").length,
      unverified: issues.filter((issue) => !issue.verified).length,
      escalated: cases.filter((row) => row.opinions.length >= 2).length, disputed: cases.filter((row) => row.disputed).length,
    },
    byKind: kindStats(cases),
    byBackend: backendStats(cases),
    agreement: agreementOf(cases),
    regressions: change("regressed"),
    improvements: change("improved"),
    errors,
  };
}

export interface LoadOptions { outDir: string; baselinePath: string; corpusPath: string; generatedAt?: string }

/** Reads eval/judge/out/*.json, the baseline and the corpus; every missing file is an error, never an empty report. */
export function loadReportData({ outDir, baselinePath, corpusPath, generatedAt }: LoadOptions): ReportData {
  if (!existsSync(outDir)) throw new Error(`${outDir} does not exist: run the judge first (pnpm --filter @read/eval judge)`);
  if (!existsSync(baselinePath)) throw new Error(`${baselinePath} does not exist`);
  if (!existsSync(corpusPath)) throw new Error(`${corpusPath} does not exist`);
  const results = readdirSync(outDir).filter((name) => name.endsWith(".json")).sort().map((name) => {
    const path = join(outDir, name);
    try { return JSON.parse(readFileSync(path, "utf8")) as JudgeResult; }
    catch (error) { throw new Error(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`); }
  });
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as Record<string, BaselineEntry>;
  const corpus = JSON.parse(readFileSync(corpusPath, "utf8")) as CorpusEntry[];
  if (!Array.isArray(corpus)) throw new Error(`${corpusPath} is not an array`);
  return buildReportData({ results, baseline, corpus, ...(generatedAt ? { generatedAt } : {}) });
}
