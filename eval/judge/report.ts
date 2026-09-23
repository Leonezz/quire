// eval/judge/report.md: counts, what the hybrid judge cost (opinions, tokens, dollars per backend,
// escalations, disputes), issue kinds ranked (what to fix next), one row per case with the backend
// that decided it. Only verdicts, kinds and the judge's own summary go in; evidence quotes from
// third-party pages stay in out/.
import { isJudged, type JudgedCase, type JudgeResult, type Opinion } from "./cache";
import { PROBLEM_KINDS, VERDICTS } from "./rubric";

/** Where a row came from: judged in this run, served from the cache in this run, or left by an earlier run. */
export type RowOrigin = "fresh" | "cached" | "previous";
export interface ReportRow { result: JudgeResult; origin: RowOrigin }
export interface ReportOptions {
  date: string;
  /** The effective policy line (policy-config.mjs describePolicy). */
  policy: string;
  rubricVersion: string;
  ranSlugs: number;
}

const SUMMARY_MAX = 140;
const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);
const usd = (amount: number) => `$${amount.toFixed(amount < 0.1 ? 4 : 2)}`;

function issueCounts(rows: readonly ReportRow[]): { kind: string; issues: number; slugs: number; major: number }[] {
  return PROBLEM_KINDS.map((kind) => {
    const judged = rows.map((row) => row.result).filter(isJudged);
    const issues = judged.flatMap((result) => result.issues.filter((issue) => issue.kind === kind));
    return { kind, issues: issues.length, slugs: judged.filter((result) => result.issues.some((issue) => issue.kind === kind)).length, major: issues.filter((issue) => issue.severity === "major").length };
  }).filter((row) => row.issues > 0).sort((a, b) => b.slugs - a.slugs || b.major - a.major || b.issues - a.issues);
}

/** "codex/default", plus "(disputed)" when the other opinion disagreed; "–" for results older than the hybrid judge. */
export function decidedBy(result: JudgedCase): string {
  const from = result.resolution?.from;
  const opinion = from ? result.opinions?.find((candidate) => candidate.backend === from) : undefined;
  if (!from || !opinion) return "–";
  return `${from}/${opinion.model}${result.resolution?.disputed ? " (disputed)" : ""}`;
}

function rowLine({ result, origin }: ReportRow): string {
  if (!isJudged(result)) return `| ${result.slug} | error | – | ${cell(clip(result.error, SUMMARY_MAX))} | – | ${origin} |`;
  const kinds = [...new Set(result.issues.map((issue) => `${issue.kind}${issue.severity === "major" ? "!" : ""}`))].join(", ") || "–";
  return `| ${result.slug} | ${result.verdict} | ${kinds} | ${cell(clip(result.summary, SUMMARY_MAX))} | ${decidedBy(result)} | ${origin} |`;
}

interface BackendTotals { label: string; opinions: number; tokens: number | undefined; costUsd: number | undefined }

/** Opinions, tokens and dollars per backend/model, in first-seen order; a total is undefined when no opinion reported it. */
export function backendTotals(results: readonly JudgeResult[]): BackendTotals[] {
  const opinions = results.filter(isJudged).flatMap((result) => result.opinions ?? []);
  const labels = [...new Set(opinions.map((opinion) => `${opinion.backend}/${opinion.model}`))];
  const sum = (items: readonly Opinion[], pick: (opinion: Opinion) => number | undefined) => {
    const values = items.map(pick).filter((value): value is number => value !== undefined);
    return values.length ? values.reduce((total, value) => total + value, 0) : undefined;
  };
  return labels.map((label) => {
    const own = opinions.filter((opinion) => `${opinion.backend}/${opinion.model}` === label);
    return { label, opinions: own.length, tokens: sum(own, (opinion) => opinion.tokens), costUsd: sum(own, (opinion) => opinion.costUsd) };
  });
}

/** The header's cost paragraph: per-backend totals, escalations and disputes; empty when no result carries opinions. */
export function describeOpinions(results: readonly JudgeResult[]): string {
  const judged = results.filter(isJudged);
  const totals = backendTotals(judged);
  if (totals.length === 0) return "";
  const perBackend = totals.map((total) => `${total.label} ${total.opinions} opinion${total.opinions === 1 ? "" : "s"}${total.tokens !== undefined ? `, ${total.tokens.toLocaleString("en-US")} tokens` : ""}${total.costUsd !== undefined ? `, ${usd(total.costUsd)}` : ""}`).join(" · ");
  const screened = judged.filter((result) => result.resolution?.policy === "screen-then-confirm");
  const escalated = screened.filter((result) => (result.opinions?.length ?? 0) > 1).length;
  const disputed = judged.filter((result) => result.resolution?.disputed).length;
  const legacy = judged.filter((result) => !result.opinions).length;
  return [
    `Opinions: ${perBackend}.`,
    screened.length ? `Escalated ${escalated} of ${screened.length} screened.` : "",
    `Disputed ${disputed}.`,
    legacy ? `${legacy} result(s) predate the hybrid judge and carry no opinions.` : "",
  ].filter(Boolean).join(" ");
}

export function renderReport(rows: readonly ReportRow[], options: ReportOptions): string {
  const sorted = [...rows].sort((a, b) => a.result.slug.localeCompare(b.result.slug));
  const results = sorted.map((row) => row.result);
  const count = (verdict: string) => results.filter((result) => isJudged(result) && result.verdict === verdict).length;
  const errors = results.filter((result) => !isJudged(result)).length;
  const fresh = sorted.filter((row) => row.origin === "fresh").length;
  const cached = sorted.filter((row) => row.origin === "cached").length;
  const previous = sorted.filter((row) => row.origin === "previous").length;
  const truncated = results.filter((result) => result.truncated).length;
  const unverified = results.filter(isJudged).reduce((sum, result) => sum + result.issues.filter((issue) => !issue.verified).length, 0);
  const kinds = issueCounts(sorted);
  const opinions = describeOpinions(results);
  return [
    `# Extraction quality judge — ${options.date}`,
    "",
    `${results.length} cases: ${VERDICTS.map((verdict) => `${count(verdict)} ${verdict}`).join(" · ")} · ${errors} error. This run judged ${options.ranSlugs} (${fresh} fresh, ${cached} cached)${previous ? `; ${previous} rows are from earlier runs` : ""}. Judge: ${options.policy}; rubric ${options.rubricVersion}.${truncated ? ` ${truncated} case(s) had an input cut to fit the prompt.` : ""}${unverified ? ` ${unverified} evidence quote(s) could not be found verbatim in the inputs.` : ""}`,
    ...(opinions ? ["", opinions] : []),
    "",
    "## Issues by kind",
    "",
    kinds.length ? "| kind | cases | issues | major |" : "No issues reported.",
    ...(kinds.length ? ["|---|---:|---:|---:|", ...kinds.map((row) => `| ${row.kind} | ${row.slugs} | ${row.issues} | ${row.major} |`)] : []),
    "",
    "## Cases",
    "",
    "`kind!` marks a major issue. `decided by` is the backend whose opinion became the verdict; `(disputed)` means the other backend's verdict differed. Evidence quotes live in `eval/judge/out/<slug>.json` (not committed).",
    "",
    "| slug | verdict | kinds | summary | decided by | origin |",
    "|---|---|---|---|---|---|",
    ...sorted.map(rowLine),
    "",
  ].join("\n");
}
