// The gate: eval/judge/baseline.json holds, per slug, the verdict and issue kinds of the last accepted
// run (nothing from the pages themselves). A run fails when any slug's verdict got worse than that.
import { isJudged, type JudgeResult } from "./cache";
import type { Verdict } from "./rubric";

export interface BaselineEntry { verdict: Verdict; kinds: string[] }
export type Baseline = Record<string, BaselineEntry>;

export interface VerdictChange { slug: string; from: Verdict; to: Verdict }
export interface BaselineDelta {
  worse: VerdictChange[];
  better: VerdictChange[];
  /** Slugs the baseline does not know yet: reported, never a failure, added by --update-baseline. */
  added: string[];
  unchanged: string[];
  /** Slugs whose judging failed: compared to nothing, kept as they were in the baseline. */
  errored: string[];
}

const RANK: Record<Verdict, number> = { PASS: 0, MINOR: 1, MAJOR: 2 };

export function compareToBaseline(baseline: Baseline, results: readonly JudgeResult[]): BaselineDelta {
  const empty: BaselineDelta = { worse: [], better: [], added: [], unchanged: [], errored: [] };
  return results.reduce<BaselineDelta>((delta, result) => {
    if (!isJudged(result)) return { ...delta, errored: [...delta.errored, result.slug] };
    const previous = baseline[result.slug];
    if (!previous) return { ...delta, added: [...delta.added, result.slug] };
    const change: VerdictChange = { slug: result.slug, from: previous.verdict, to: result.verdict };
    if (RANK[result.verdict] > RANK[previous.verdict]) return { ...delta, worse: [...delta.worse, change] };
    if (RANK[result.verdict] < RANK[previous.verdict]) return { ...delta, better: [...delta.better, change] };
    return { ...delta, unchanged: [...delta.unchanged, result.slug] };
  }, empty);
}

/** The baseline with every judged result written over its slug (failed cases keep their old entry), sorted by slug. */
export function updateBaseline(baseline: Baseline, results: readonly JudgeResult[]): Baseline {
  const merged: Baseline = { ...baseline };
  for (const result of results) {
    if (isJudged(result)) merged[result.slug] = { verdict: result.verdict, kinds: [...new Set(result.issues.map((issue) => issue.kind))].sort() };
  }
  return Object.fromEntries(Object.keys(merged).sort().map((slug) => [slug, merged[slug]]));
}

export function describeDelta(delta: BaselineDelta): string[] {
  const lines: string[] = [];
  if (delta.worse.length) lines.push(`WORSE than baseline (${delta.worse.length}): ${delta.worse.map((c) => `${c.slug} ${c.from}→${c.to}`).join(", ")}`);
  if (delta.better.length) lines.push(`Better than baseline (${delta.better.length}): ${delta.better.map((c) => `${c.slug} ${c.from}→${c.to}`).join(", ")} — pass --update-baseline to accept.`);
  if (delta.added.length) lines.push(`New, not in baseline (${delta.added.length}): ${delta.added.join(", ")} — pass --update-baseline to add.`);
  if (delta.errored.length) lines.push(`Not judged (${delta.errored.length}): ${delta.errored.join(", ")}`);
  lines.push(`Unchanged: ${delta.unchanged.length}`);
  return lines;
}
