// The judge run: every corpus snapshot (or the ones asked for) judged under the effective policy
// (config.json + flags, resolved by run.mjs into JUDGE_POLICY) in the effective mode (visual: with the
// render capture from eval/render/out/<slug>/; text: SOURCE and EXTRACTED only), cached in eval/judge/out/<slug>.json,
// gated by eval/judge/baseline.json, summarized in report.md. Driven by run.mjs, which checks the
// CLIs the policy needs are there and logged in and passes the options below as env.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { captureTextOf } from "../../apps/desktop/src/main/engine/capture-text";
import { corpusEntries, normalizeSnapshot, snapshots, type Snapshot } from "../src/corpus";
import { claudeBackend } from "./backends/claude";
import { codexBackend } from "./backends/codex";
import type { BackendSpec, JudgeBackend } from "./backends/types";
import { compareToBaseline, describeDelta, updateBaseline, type Baseline } from "./baseline";
import { isJudged, readCached, readPrevious, writeResult, type FailedCase, type JudgedCase, type JudgedIssue, type JudgeResult } from "./cache";
import { originCounts } from "./merge";
import { extractedMarkdown, truncateInput } from "./inputs";
import { describePolicy, resolveMaxImages, resolveMode, resolvePolicy } from "./policy-config.mjs";
import { caseKey, judgeCase, parseEffectivePolicy, type EffectivePolicy } from "./policy";
import { decidedBy, renderReport, type ReportRow } from "./report";
import { rubricVersionFor, type PromptInput } from "./rubric";
import { loadCapture, MissingCaptureError, type JudgeMode } from "./visual";

const ROOT = __dirname;
const OUT = join(ROOT, "out");
const RENDER_OUT = join(ROOT, "..", "render", "out");
const BASELINE_PATH = join(ROOT, "baseline.json");
const ONLY = new Set((process.env.JUDGE_ONLY ?? "").split(",").filter(Boolean));
const FORCE = process.env.JUDGE_FORCE === "1";
const MAX = Number(process.env.JUDGE_MAX ?? 0);
const UPDATE_BASELINE = process.env.JUDGE_UPDATE_BASELINE === "1";
const BINS = { codex: process.env.JUDGE_CODEX_BIN || "codex", claude: process.env.JUDGE_CLAUDE_BIN || "claude" } as const;
/** One backend call may take this long before it counts as failed. */
const TIMEOUT_MS = Number(process.env.JUDGE_TIMEOUT_MS ?? 15 * 60_000);
/** run.mjs resolves the policy and the mode; run bare (vitest on this file), config.json alone applies. */
const CONFIG = JSON.parse(readFileSync(join(ROOT, "config.json"), "utf8"));
const POLICY: EffectivePolicy = process.env.JUDGE_POLICY ? parseEffectivePolicy(process.env.JUDGE_POLICY) : (resolvePolicy(CONFIG) as EffectivePolicy);
const MODE: JudgeMode = resolveMode(CONFIG, process.env.JUDGE_MODE || undefined);
const MAX_IMAGES = process.env.JUDGE_MAX_IMAGES ? Number(process.env.JUDGE_MAX_IMAGES) : resolveMaxImages(CONFIG);
const POLICY_LINE = describePolicy(POLICY);

const backendFor = (spec: BackendSpec): JudgeBackend => (spec.backend === "codex" ? codexBackend({ bin: BINS.codex, model: spec.model }) : claudeBackend({ bin: BINS.claude, model: spec.model }));

const selected = snapshots().filter((snapshot) => ONLY.size === 0 || ONLY.has(snapshot.slug));
const cases = MAX > 0 ? selected.slice(0, MAX) : selected;
const rows: ReportRow[] = [];

function readBaseline(): Baseline {
  return existsSync(BASELINE_PATH) ? (JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Baseline) : {};
}

/** A case that could not be judged before any call: reported in this run, never written over the cached result. */
const notJudged = (slug: string, error: string): FailedCase => ({ key: "", slug, model: "–", rubricVersion: rubricVersionFor(MODE), truncated: false, wallMs: 0, judgedAt: new Date().toISOString(), mode: MODE, error });

async function evaluate(snapshot: Snapshot): Promise<ReportRow> {
  const source = truncateInput(captureTextOf(new TextDecoder().decode(snapshot.bytes)));
  const extracted = truncateInput(extractedMarkdown(normalizeSnapshot(snapshot)));
  let input: PromptInput = { slug: snapshot.slug, url: snapshot.finalUrl, source: source.text, extracted: extracted.text, truncated: { source: source.truncated, extracted: extracted.truncated } };
  if (MODE === "visual") {
    try { input = { ...input, visual: loadCapture(RENDER_OUT, snapshot.slug) }; }
    catch (error) {
      if (error instanceof MissingCaptureError) return { result: notJudged(snapshot.slug, error.message), origin: "fresh" };
      throw error;
    }
  }
  const key = caseKey(input, POLICY, MAX_IMAGES);
  const cached = FORCE ? undefined : readCached(OUT, snapshot.slug, key);
  if (cached) return { result: cached, origin: "cached" };
  const result = await judgeCase(input, { policy: POLICY, backend: backendFor, timeoutMs: TIMEOUT_MS, maxImages: MAX_IMAGES });
  writeResult(OUT, result);
  return { result, origin: "fresh" };
}

const layersText = (result: JudgedCase) => (result.layers ? ` (content ${result.layers.content} · metadata ${result.layers.metadata}${result.layers.rendering ? ` · rendering ${result.layers.rendering}` : ""})` : "");
/** On a cross-confirmed case: how many counted issues each origin gave. */
const originsText = (valid: readonly JudgedIssue[]) => {
  const counts = originCounts(valid);
  const parts = ([["both", "both"], ["one-sided-fact", "fact"], ["one-sided-downgraded", "downgraded"], ["one-sided", "one-sided"]] as const).filter(([origin]) => counts[origin] > 0).map(([origin, label]) => `${counts[origin]} ${label}`);
  return parts.length ? ` · ${parts.join(", ")}` : "";
};
const describeResult = (result: JudgeResult) => {
  if (!isJudged(result)) return `ERROR ${result.error.split("\n")[0]}`;
  const valid = result.issues.filter((issue) => !issue.invalid);
  const invalid = result.issues.length - valid.length;
  return `${result.verdict}${layersText(result)}${valid.length ? ` · ${[...new Set(valid.map((issue) => `${issue.layer}/${issue.kind}${issue.severity === "major" ? "!" : ""}`))].join(", ")}` : ""}${invalid ? ` · ${invalid} invalid` : ""}${originsText(valid)} · ${decidedBy(result)}`;
};
const describeCost = (result: JudgeResult) => {
  const cost = isJudged(result) ? (result.opinions ?? []).reduce<number | undefined>((sum, opinion) => (opinion.costUsd === undefined ? sum : (sum ?? 0) + opinion.costUsd), undefined) : undefined;
  const perOpinion = isJudged(result) && (result.opinions?.length ?? 0) > 0 ? ` [${(result.opinions ?? []).map((opinion) => `${opinion.backend} ${opinion.verdict} ${(opinion.wallMs / 1000).toFixed(0)} s${opinion.tokens ? ` ${opinion.tokens.toLocaleString("en-US")} tok` : ""}${opinion.costUsd !== undefined ? ` $${opinion.costUsd.toFixed(4)}` : ""}${opinion.images ? ` ${opinion.images} img` : ""}`).join(" · ")}]` : "";
  return `${(result.wallMs / 1000).toFixed(0)} s${result.tokens ? ` · ${result.tokens.toLocaleString("en-US")} tokens` : ""}${cost !== undefined ? ` · $${cost.toFixed(4)}` : ""}${perOpinion}`;
};

describe.concurrent("judge", () => {
  it("has cases to judge", () => {
    expect(cases.length, ONLY.size ? `none of ${[...ONLY].join(", ")} has a snapshot in eval/corpus` : "no snapshots in eval/corpus (run pnpm --filter @read/eval fetch)").toBeGreaterThan(0);
  });

  it.each(cases.map((snapshot) => [snapshot.slug, snapshot] as const))("%s", async (_slug, snapshot) => {
    const row = await evaluate(snapshot);
    rows.push(row);
    const { result } = row;
    process.stdout.write(`${snapshot.slug.padEnd(30)} ${row.origin.padEnd(6)} ${describeResult(result)}${row.origin === "fresh" ? ` · ${describeCost(result)}` : ""}\n`);
    expect(isJudged(result), isJudged(result) ? "" : result.error).toBe(true);
  });
});

describe("baseline gate", () => {
  it("no case got worse than eval/judge/baseline.json", () => {
    const baseline = readBaseline();
    const results = rows.map((row) => row.result);
    const delta = compareToBaseline(baseline, results);
    process.stdout.write(`\n${describeDelta(delta).join("\n")}\n`);
    if (UPDATE_BASELINE) {
      writeFileSync(BASELINE_PATH, `${JSON.stringify(updateBaseline(baseline, results), null, 2)}\n`);
      process.stdout.write(`Baseline rewritten: ${BASELINE_PATH}\n`);
      return;
    }
    expect(delta.worse, `verdicts got worse than the baseline: ${delta.worse.map((change) => `${change.slug} ${change.from}→${change.to}`).join(", ")}`).toEqual([]);
  });
});

afterAll(() => {
  if (rows.length === 0) return;
  const ran = new Set(rows.map((row) => row.result.slug));
  const previous: ReportRow[] = corpusEntries().filter((entry) => !ran.has(entry.slug)).flatMap((entry) => { const result = readPrevious(OUT, entry.slug); return result ? [{ result, origin: "previous" as const }] : []; });
  writeFileSync(join(ROOT, "report.md"), renderReport([...rows, ...previous], { date: new Date().toISOString().slice(0, 10), policy: POLICY_LINE, rubricVersion: rubricVersionFor(MODE), ranSlugs: rows.length, mode: MODE }));
});
