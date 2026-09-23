// The judge run: every corpus snapshot (or the ones asked for) judged under the effective policy
// (config.json + flags, resolved by run.mjs into JUDGE_POLICY), cached in eval/judge/out/<slug>.json,
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
import { cacheKey, isJudged, readCached, readPrevious, writeResult, type JudgeResult } from "./cache";
import { extractedMarkdown, truncateInput } from "./inputs";
import { describePolicy, resolvePolicy } from "./policy-config.mjs";
import { judgeCase, parseEffectivePolicy, policyKey, type EffectivePolicy } from "./policy";
import { decidedBy, renderReport, type ReportRow } from "./report";
import { RUBRIC_VERSION } from "./rubric";

const ROOT = __dirname;
const OUT = join(ROOT, "out");
const BASELINE_PATH = join(ROOT, "baseline.json");
const ONLY = new Set((process.env.JUDGE_ONLY ?? "").split(",").filter(Boolean));
const FORCE = process.env.JUDGE_FORCE === "1";
const MAX = Number(process.env.JUDGE_MAX ?? 0);
const UPDATE_BASELINE = process.env.JUDGE_UPDATE_BASELINE === "1";
const BINS = { codex: process.env.JUDGE_CODEX_BIN || "codex", claude: process.env.JUDGE_CLAUDE_BIN || "claude" } as const;
/** One backend call may take this long before it counts as failed. */
const TIMEOUT_MS = Number(process.env.JUDGE_TIMEOUT_MS ?? 15 * 60_000);
/** run.mjs resolves the policy; run bare (vitest on this file), config.json alone applies. */
const POLICY: EffectivePolicy = process.env.JUDGE_POLICY
  ? parseEffectivePolicy(process.env.JUDGE_POLICY)
  : (resolvePolicy(JSON.parse(readFileSync(join(ROOT, "config.json"), "utf8"))) as EffectivePolicy);
const POLICY_LINE = describePolicy(POLICY);

const backendFor = (spec: BackendSpec): JudgeBackend => (spec.backend === "codex" ? codexBackend({ bin: BINS.codex, model: spec.model }) : claudeBackend({ bin: BINS.claude, model: spec.model }));

const selected = snapshots().filter((snapshot) => ONLY.size === 0 || ONLY.has(snapshot.slug));
const cases = MAX > 0 ? selected.slice(0, MAX) : selected;
const rows: ReportRow[] = [];

function readBaseline(): Baseline {
  return existsSync(BASELINE_PATH) ? (JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Baseline) : {};
}

async function evaluate(snapshot: Snapshot): Promise<ReportRow> {
  const source = truncateInput(captureTextOf(new TextDecoder().decode(snapshot.bytes)));
  const extracted = truncateInput(extractedMarkdown(normalizeSnapshot(snapshot)));
  const key = cacheKey(source.text, extracted.text, RUBRIC_VERSION, policyKey(POLICY));
  const cached = FORCE ? undefined : readCached(OUT, snapshot.slug, key);
  if (cached) return { result: cached, origin: "cached" };
  const result = await judgeCase({ slug: snapshot.slug, url: snapshot.finalUrl, source: source.text, extracted: extracted.text, truncated: { source: source.truncated, extracted: extracted.truncated } }, { policy: POLICY, backend: backendFor, timeoutMs: TIMEOUT_MS });
  writeResult(OUT, result);
  return { result, origin: "fresh" };
}

const describeResult = (result: JudgeResult) => isJudged(result) ? `${result.verdict}${result.issues.length ? ` · ${[...new Set(result.issues.map((issue) => issue.kind))].join(", ")}` : ""} · ${decidedBy(result)}` : `ERROR ${result.error.split("\n")[0]}`;
const describeCost = (result: JudgeResult) => {
  const cost = isJudged(result) ? (result.opinions ?? []).reduce<number | undefined>((sum, opinion) => (opinion.costUsd === undefined ? sum : (sum ?? 0) + opinion.costUsd), undefined) : undefined;
  return `${(result.wallMs / 1000).toFixed(0)} s${result.tokens ? ` · ${result.tokens.toLocaleString("en-US")} tokens` : ""}${cost !== undefined ? ` · $${cost.toFixed(4)}` : ""}`;
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
  writeFileSync(join(ROOT, "report.md"), renderReport([...rows, ...previous], { date: new Date().toISOString().slice(0, 10), policy: POLICY_LINE, rubricVersion: RUBRIC_VERSION, ranSlugs: rows.length }));
});
