// eval/judge/report.md: counts, issue kinds ranked (what to fix next), one row per case. Only verdicts,
// kinds and the judge's own summary go in; evidence quotes from third-party pages stay in out/.
import { isJudged, type JudgeResult } from "./cache";
import { PROBLEM_KINDS, VERDICTS } from "./rubric";

/** Where a row came from: judged in this run, served from the cache in this run, or left by an earlier run. */
export type RowOrigin = "fresh" | "cached" | "previous";
export interface ReportRow { result: JudgeResult; origin: RowOrigin }
export interface ReportOptions { date: string; model: string; rubricVersion: string; ranSlugs: number }

const SUMMARY_MAX = 140;
const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

function issueCounts(rows: readonly ReportRow[]): { kind: string; issues: number; slugs: number; major: number }[] {
  return PROBLEM_KINDS.map((kind) => {
    const judged = rows.map((row) => row.result).filter(isJudged);
    const issues = judged.flatMap((result) => result.issues.filter((issue) => issue.kind === kind));
    return { kind, issues: issues.length, slugs: judged.filter((result) => result.issues.some((issue) => issue.kind === kind)).length, major: issues.filter((issue) => issue.severity === "major").length };
  }).filter((row) => row.issues > 0).sort((a, b) => b.slugs - a.slugs || b.major - a.major || b.issues - a.issues);
}

function rowLine({ result, origin }: ReportRow): string {
  if (!isJudged(result)) return `| ${result.slug} | error | – | ${cell(clip(result.error, SUMMARY_MAX))} | ${origin} |`;
  const kinds = [...new Set(result.issues.map((issue) => `${issue.kind}${issue.severity === "major" ? "!" : ""}`))].join(", ") || "–";
  return `| ${result.slug} | ${result.verdict} | ${kinds} | ${cell(clip(result.summary, SUMMARY_MAX))} | ${origin} |`;
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
  return [
    `# Extraction quality judge — ${options.date}`,
    "",
    `${results.length} cases: ${VERDICTS.map((verdict) => `${count(verdict)} ${verdict}`).join(" · ")} · ${errors} error. This run judged ${options.ranSlugs} (${fresh} fresh, ${cached} cached)${previous ? `; ${previous} rows are from earlier runs` : ""}. Model ${options.model}, rubric ${options.rubricVersion}.${truncated ? ` ${truncated} case(s) had an input cut to fit the prompt.` : ""}${unverified ? ` ${unverified} evidence quote(s) could not be found verbatim in the inputs.` : ""}`,
    "",
    "## Issues by kind",
    "",
    kinds.length ? "| kind | cases | issues | major |" : "No issues reported.",
    ...(kinds.length ? ["|---|---:|---:|---:|", ...kinds.map((row) => `| ${row.kind} | ${row.slugs} | ${row.issues} | ${row.major} |`)] : []),
    "",
    "## Cases",
    "",
    "`kind!` marks a major issue. Evidence quotes live in `eval/judge/out/<slug>.json` (not committed).",
    "",
    "| slug | verdict | kinds | summary | origin |",
    "|---|---|---|---|---|",
    ...sorted.map(rowLine),
    "",
  ].join("\n");
}
