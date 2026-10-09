// eval/judge/report.md: counts (overall and per layer), what the hybrid judge cost (opinions, tokens,
// dollars per backend, escalations, disputes), the issues the program discarded as invalid (by
// reason), the render capture's measured facts (broken images, overflow, raw markup, math errors)
// totalled and per case, valid issues by layer × kind (what to fix next), one row per case with its
// three layer verdicts and the backend that decided it. Only verdicts, kinds, fact counts and the
// judge's own summary go in; evidence quotes and image URLs from third-party pages stay in out/.
import { isJudged, type JudgedCase, type JudgedIssue, type JudgeResult, type Opinion } from "./cache";
import { originCounts } from "./merge";
import { PROBLEM_KINDS, VERDICTS } from "./rubric";
import { INVALID_REASONS, LAYERS, type Layer, type Verdict } from "./verdict";

/** Where a row came from: judged in this run, served from the cache in this run, or left by an earlier run. */
/** "rescored": a stored result scored again under the current program rules without a model call (--rescore, or a cached result with an older scoring version). */
export type RowOrigin = "fresh" | "cached" | "rescored" | "previous";
export interface ReportRow { result: JudgeResult; origin: RowOrigin }
export interface ReportOptions {
  date: string;
  /** The effective policy line (policy-config.mjs describePolicy). */
  policy: string;
  rubricVersion: string;
  ranSlugs: number;
  /** The run's mode (visual | text); omitted by callers that predate it. */
  mode?: string;
}

const SUMMARY_MAX = 140;
const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);
const usd = (amount: number) => `$${amount.toFixed(amount < 0.1 ? 4 : 2)}`;

const isValid = (issue: JudgedIssue) => !issue.invalid;

/** Valid issues per layer and kind, ranked by cases, then major, then issues; issues from before rubric v6 (no layer) are left out. */
function issueCounts(rows: readonly ReportRow[]): { layer: Layer; kind: string; issues: number; slugs: number; major: number }[] {
  const judged = rows.map((row) => row.result).filter(isJudged);
  return LAYERS.flatMap((layer) => PROBLEM_KINDS.map((kind) => {
    const matches = (issue: JudgedIssue) => isValid(issue) && issue.layer === layer && issue.kind === kind;
    const issues = judged.flatMap((result) => result.issues.filter(matches));
    return { layer, kind, issues: issues.length, slugs: judged.filter((result) => result.issues.some(matches)).length, major: issues.filter((issue) => issue.severity === "major").length };
  })).filter((row) => row.issues > 0).sort((a, b) => b.slugs - a.slugs || b.major - a.major || b.issues - a.issues);
}

/** Per layer, how many cases got each verdict (cases without that layer — older results, or rendering in text mode — are not counted). */
export function layerTotals(results: readonly JudgeResult[]): Record<Layer, Record<Verdict, number> & { judged: number }> {
  const judged = results.filter(isJudged);
  return Object.fromEntries(LAYERS.map((layer) => {
    const verdicts = judged.map((result) => result.layers?.[layer]).filter((verdict): verdict is Verdict => typeof verdict === "string");
    const count = (verdict: Verdict) => verdicts.filter((candidate) => candidate === verdict).length;
    return [layer, { judged: verdicts.length, PASS: count("PASS"), MINOR: count("MINOR"), MAJOR: count("MAJOR") }];
  })) as Record<Layer, Record<Verdict, number> & { judged: number }>;
}

/** The header's cross-confirmation sentence: how the counted issues of two-opinion cases stand; empty when there are none. */
export function describeOrigins(results: readonly JudgeResult[]): string {
  const counts = originCounts(results.filter(isJudged).flatMap((result) => result.issues));
  const total = counts.both + counts["one-sided-fact"] + counts["one-sided-downgraded"] + counts["one-sided"];
  if (!total) return "";
  return `Cross-confirmed issues: ${counts.both} reported by both, ${counts["one-sided-fact"]} one-sided major kept by a fact, ${counts["one-sided-downgraded"]} one-sided major downgraded to minor, ${counts["one-sided"]} one-sided minor.`;
}

/** The header's invalid-issues sentence: how many of the cases' issues the program discarded, by reason; empty when none. */
export function describeInvalid(results: readonly JudgeResult[]): string {
  const invalid = results.filter(isJudged).flatMap((result) => result.issues.flatMap((issue) => (issue.invalid ? [issue.invalid.reason] : [])));
  if (!invalid.length) return "";
  const byReason = INVALID_REASONS.map((reason) => [reason, invalid.filter((candidate) => candidate === reason).length] as const).filter(([, count]) => count > 0);
  return `Invalid issues (kept in out/, never counted): ${invalid.length} — ${byReason.map(([reason, count]) => `${reason} ${count}`).join(", ")}.`;
}

/** "codex/default", or "merged claude+codex" for a cross-confirmed case, plus "(disputed)" when the two opinions' verdicts differed; "–" for results older than the hybrid judge. */
export function decidedBy(result: JudgedCase): string {
  const from = result.resolution?.from;
  if (from === "merged") return `merged ${(result.opinions ?? []).map((opinion) => opinion.backend).join("+")}${result.resolution?.disputed ? " (disputed)" : ""}`;
  const opinion = from ? result.opinions?.find((candidate) => candidate.backend === from) : undefined;
  if (!from || !opinion) return "–";
  return `${from}/${opinion.model}${result.resolution?.disputed ? " (disputed)" : ""}`;
}

/** The four fact cells (broken images, overflowing elements, raw markup, math errors); dashes for a case judged without a capture. */
function factCells(result: JudgeResult): string {
  const metrics = result.render?.metrics;
  if (!metrics) return "– | – | – | –";
  return `${metrics.images.broken} | ${metrics.overflow.count} | ${metrics.rawMarkup.count} | ${metrics.mathErrors}`;
}

/** The three layer cells; "–" for a layer not judged (text mode's rendering) and for results from before rubric v6. */
const layerCells = (result: JudgedCase) => LAYERS.map((layer) => result.layers?.[layer] ?? "–").join(" | ");

function rowLine({ result, origin }: ReportRow): string {
  if (!isJudged(result)) return `| ${result.slug} | error | – | – | – | – | ${factCells(result)} | ${cell(clip(result.error, SUMMARY_MAX))} | – | ${origin} |`;
  const valid = result.issues.filter(isValid);
  const kinds = [...new Set(valid.map((issue) => `${issue.kind}${issue.severity === "major" ? "!" : ""}`))].join(", ") || "–";
  const invalid = result.issues.length - valid.length;
  return `| ${result.slug} | ${result.verdict} | ${layerCells(result)} | ${kinds}${invalid ? ` (+${invalid} invalid)` : ""} | ${factCells(result)} | ${cell(clip(result.summary, SUMMARY_MAX))} | ${decidedBy(result)} | ${origin} |`;
}

export interface FactTotals { captured: number; broken: number; brokenCases: number; overflow: number; overflowCases: number; rawMarkup: number; rawMarkupCases: number; mathErrors: number; mathErrorCases: number }

/** The capture facts summed over every result that carries a capture (judged or not). */
export function factTotals(results: readonly JudgeResult[]): FactTotals {
  const metrics = results.flatMap((result) => (result.render ? [result.render.metrics] : []));
  const total = (pick: (m: (typeof metrics)[number]) => number) => metrics.reduce((sum, m) => sum + pick(m), 0);
  const cases = (pick: (m: (typeof metrics)[number]) => number) => metrics.filter((m) => pick(m) > 0).length;
  return {
    captured: metrics.length,
    broken: total((m) => m.images.broken), brokenCases: cases((m) => m.images.broken),
    overflow: total((m) => m.overflow.count), overflowCases: cases((m) => m.overflow.count),
    rawMarkup: total((m) => m.rawMarkup.count), rawMarkupCases: cases((m) => m.rawMarkup.count),
    mathErrors: total((m) => m.mathErrors), mathErrorCases: cases((m) => m.mathErrors),
  };
}

/** The header's rendering-facts sentence; empty when no result carries a capture. */
export function describeFacts(results: readonly JudgeResult[]): string {
  const t = factTotals(results);
  if (!t.captured) return "";
  const part = (count: number, label: string, inCases: number) => `${count} ${label}${count ? ` (${inCases} case${inCases === 1 ? "" : "s"})` : ""}`;
  return `Rendering facts over ${t.captured} captured case${t.captured === 1 ? "" : "s"}: ${part(t.broken, "broken images", t.brokenCases)} · ${part(t.overflow, "overflowing elements", t.overflowCases)} · ${part(t.rawMarkup, "raw-markup samples", t.rawMarkupCases)} · ${part(t.mathErrors, "math errors", t.mathErrorCases)}.`;
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
  const rescored = sorted.filter((row) => row.origin === "rescored").length;
  const previous = sorted.filter((row) => row.origin === "previous").length;
  const truncated = results.filter((result) => result.truncated).length;
  const unverified = results.filter(isJudged).reduce((sum, result) => sum + result.issues.filter((issue) => !issue.verified).length, 0);
  const kinds = issueCounts(sorted);
  const opinions = describeOpinions(results);
  const facts = describeFacts(results);
  const invalid = describeInvalid(results);
  const origins = describeOrigins(results);
  const layers = layerTotals(results);
  const layerLine = LAYERS.filter((layer) => layers[layer].judged > 0).map((layer) => `${layer} ${VERDICTS.map((verdict) => `${layers[layer][verdict]} ${verdict}`).join(" · ")}`).join("; ");
  return [
    `# Extraction quality judge — ${options.date}`,
    "",
    `${results.length} cases: ${VERDICTS.map((verdict) => `${count(verdict)} ${verdict}`).join(" · ")} · ${errors} error. This run judged ${options.ranSlugs} (${fresh} fresh, ${cached} cached${rescored ? `, ${rescored} rescored without a model call` : ""})${previous ? `; ${previous} rows are from earlier runs` : ""}. Judge: ${options.policy}${options.mode ? `; mode ${options.mode}` : ""}; rubric ${options.rubricVersion}.${truncated ? ` ${truncated} case(s) had an input cut to fit the prompt.` : ""}${unverified ? ` ${unverified} evidence quote(s) could not be found verbatim in the inputs.` : ""}`,
    ...(layerLine ? ["", `Per layer: ${layerLine}.`] : []),
    ...(origins ? ["", origins] : []),
    ...(invalid ? ["", invalid] : []),
    ...(opinions ? ["", opinions] : []),
    ...(facts ? ["", facts] : []),
    "",
    "## Issues by layer and kind",
    "",
    "Valid issues only; issues from results judged before rubric v6 carry no layer and are not counted here.",
    "",
    kinds.length ? "| layer | kind | cases | issues | major |" : "No issues reported.",
    ...(kinds.length ? ["|---|---|---:|---:|---:|", ...kinds.map((row) => `| ${row.layer} | ${row.kind} | ${row.slugs} | ${row.issues} | ${row.major} |`)] : []),
    "",
    "## Cases",
    "",
    "`content`, `metadata` and `rendering` are the layer verdicts; the verdict is the worst of them (`–`: the layer was not judged, as rendering in text mode, or the result predates rubric v6). `kind!` marks a major issue; kinds are those of the valid issues, `(+n invalid)` counts the ones the program discarded. `broken`, `overflow`, `raw` and `math` are the render capture's measured facts (broken images, elements wider than the column, markup shown as text, formulas that failed to render); `–` means the case was judged without a capture. `decided by` is the backend whose opinion became the verdict, or `merged` when two opinions were cross-confirmed into one issue list; `(disputed)` means the two opinions' own verdicts differed. Evidence quotes live in `eval/judge/out/<slug>.json` and screenshots in `eval/render/out/<slug>/` (neither committed).",
    "",
    "| slug | verdict | content | metadata | rendering | kinds | broken | overflow | raw | math | summary | decided by | origin |",
    "|---|---|---|---|---|---|---:|---:|---:|---:|---|---|---|",
    ...sorted.map(rowLine),
    "",
  ].join("\n");
}
