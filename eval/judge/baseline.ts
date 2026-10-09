// The gate: eval/judge/baseline.json holds, per slug, the verdict, the per-layer verdicts and the
// issue kinds of the last accepted run (nothing from the pages themselves). A run fails when any
// slug got worse than that: its overall verdict, or any layer both runs judged. Entries written
// before rubric v6 have no layers and compare on the overall verdict only.
import { isJudged, type JudgeResult } from "./cache";
import { LAYERS, VERDICT_RANK, type Layer, type LayerVerdicts, type Verdict } from "./verdict";

export interface BaselineEntry { verdict: Verdict; kinds: string[]; layers?: LayerVerdicts }
export type Baseline = Record<string, BaselineEntry>;

export interface LayerChange { layer: Layer; from: Verdict; to: Verdict }
/** A slug whose overall verdict or some layer moved; `layers` lists every layer that moved, either way. */
export interface VerdictChange { slug: string; from: Verdict; to: Verdict; layers: LayerChange[] }
export interface BaselineDelta {
  /** Overall worse, or any layer worse (even when another got better). */
  worse: VerdictChange[];
  /** Nothing worse, and the overall verdict or some layer better. */
  better: VerdictChange[];
  /** Slugs the baseline does not know yet: reported, never a failure, added by --update-baseline. */
  added: string[];
  unchanged: string[];
  /** Slugs whose judging failed: compared to nothing, kept as they were in the baseline. */
  errored: string[];
}

/** The layers that moved between two sets of layer verdicts; a layer either side did not judge (null, or no layers at all) is skipped. */
export function layerChanges(from: LayerVerdicts | undefined, to: LayerVerdicts | undefined): LayerChange[] {
  if (!from || !to) return [];
  return LAYERS.flatMap((layer) => {
    const before = from[layer];
    const after = to[layer];
    return before && after && before !== after ? [{ layer, from: before, to: after }] : [];
  });
}

export function compareToBaseline(baseline: Baseline, results: readonly JudgeResult[]): BaselineDelta {
  const empty: BaselineDelta = { worse: [], better: [], added: [], unchanged: [], errored: [] };
  return results.reduce<BaselineDelta>((delta, result) => {
    if (!isJudged(result)) return { ...delta, errored: [...delta.errored, result.slug] };
    const previous = baseline[result.slug];
    if (!previous) return { ...delta, added: [...delta.added, result.slug] };
    const layers = layerChanges(previous.layers, result.layers);
    const change: VerdictChange = { slug: result.slug, from: previous.verdict, to: result.verdict, layers };
    const overall = VERDICT_RANK[result.verdict] - VERDICT_RANK[previous.verdict];
    if (overall > 0 || layers.some((moved) => VERDICT_RANK[moved.to] > VERDICT_RANK[moved.from])) return { ...delta, worse: [...delta.worse, change] };
    if (overall < 0 || layers.length) return { ...delta, better: [...delta.better, change] };
    return { ...delta, unchanged: [...delta.unchanged, result.slug] };
  }, empty);
}

/** The baseline with every judged result written over its slug (failed cases keep their old entry), sorted by slug. Kinds are those of the valid issues. */
export function updateBaseline(baseline: Baseline, results: readonly JudgeResult[]): Baseline {
  const merged: Baseline = { ...baseline };
  for (const result of results) {
    if (!isJudged(result)) continue;
    const kinds = [...new Set(result.issues.filter((issue) => !issue.invalid).map((issue) => issue.kind))].sort();
    merged[result.slug] = { verdict: result.verdict, kinds, ...(result.layers ? { layers: result.layers } : {}) };
  }
  return Object.fromEntries(Object.keys(merged).sort().map((slug) => [slug, merged[slug]!]));
}

const describeChange = (change: VerdictChange) => `${change.slug} ${change.from}→${change.to}${change.layers.length ? ` (${change.layers.map((moved) => `${moved.layer} ${moved.from}→${moved.to}`).join(", ")})` : ""}`;

export function describeDelta(delta: BaselineDelta): string[] {
  const lines: string[] = [];
  if (delta.worse.length) lines.push(`WORSE than baseline (${delta.worse.length}): ${delta.worse.map(describeChange).join(", ")}`);
  if (delta.better.length) lines.push(`Better than baseline (${delta.better.length}): ${delta.better.map(describeChange).join(", ")} — pass --update-baseline to accept.`);
  if (delta.added.length) lines.push(`New, not in baseline (${delta.added.length}): ${delta.added.join(", ")} — pass --update-baseline to add.`);
  if (delta.errored.length) lines.push(`Not judged (${delta.errored.length}): ${delta.errored.join(", ")}`);
  lines.push(`Unchanged: ${delta.unchanged.length}`);
  return lines;
}
