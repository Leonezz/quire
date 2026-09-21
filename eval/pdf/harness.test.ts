// The PDF reflow eval: every corpus PDF built with the rules judge and with Jev, side by side.
// Driven by run.mjs (which supplies the key as TYPESAFE_API_KEY and the options below as env);
// results go to eval/pdf/out/<slug>.json and the summary to eval/pdf/report.md.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, it } from "vitest";
import { buildTextView } from "../../apps/desktop/src/main/engine/pdf-reflow/index";
import { JevJudge, RulesJudge, type BlockJudge, type JudgePage, type JudgeUsage } from "../../apps/desktop/src/main/engine/pdf-reflow/judge";
import type { TextViewReport } from "../../apps/desktop/src/shared/contracts";
import { writeReport, type PdfResult, type RunTotals } from "./report";

const ROOT = __dirname;
const CORPUS = join(ROOT, "corpus");
const OUT = join(ROOT, "out");
const KEY = process.env.TYPESAFE_API_KEY ?? "";
const ONLY = new Set((process.env.PDF_EVAL_ONLY ?? "").split(",").filter(Boolean));
const FORCE = process.env.PDF_EVAL_FORCE === "1";
const RULES_ONLY = process.env.PDF_EVAL_RULES_ONLY === "1";
/** Jev sees at most this many pages per PDF (the rest keep the rules), which bounds the spend. */
const MAX_PAGES = Number(process.env.PDF_EVAL_MAX_PAGES ?? 24);
/** The whole run stops asking Jev once this many input tokens were spent. */
const BUDGET = Number(process.env.PDF_EVAL_BUDGET ?? 2_000_000);
const HEAD_LINES = 12;

interface Source { slug: string; url: string; kind: string; layout: string }

const sources = (JSON.parse(readFileSync(join(ROOT, "sources.json"), "utf8")) as Source[]).filter((source) => (ONLY.size === 0 || ONLY.has(source.slug)) && existsSync(join(CORPUS, `${source.slug}.pdf`)));
const results: PdfResult[] = [];
const totals: RunTotals = { inputTokens: 0, outputTokens: 0, requests: 0, jevMs: 0, rulesMs: 0, blocks: 0, asked: 0, changed: 0, skipped: [] };
const sink = { write: async (id: string, index: number) => `quire-figure://${id}/${index}.png` };

/** The rules judge, counting the blocks and how many were uncertain. */
function countingRules(): BlockJudge & { blocks: number; asked: number } {
  const rules = new RulesJudge();
  const judge: BlockJudge & { blocks: number; asked: number } = { provider: "rules", blocks: 0, asked: 0, judge: async (pages) => { judge.blocks = pages.reduce((sum, page) => sum + page.blocks.length, 0); judge.asked = pages.reduce((sum, page) => sum + page.blocks.filter((block) => !block.certain).length, 0); return rules.judge(pages); } };
  return judge;
}

/** Jev over the first MAX_PAGES pages only, remembering the usage. */
function cappedJev(): BlockJudge & { usage: JudgeUsage | undefined; pagesAsked: number } {
  const inner = new JevJudge((url, init) => fetch(url, init), KEY);
  const judge: BlockJudge & { usage: JudgeUsage | undefined; pagesAsked: number } = {
    provider: "jev", usage: undefined, pagesAsked: 0,
    judge: async (pages: readonly JudgePage[]) => {
      const capped = pages.slice(0, MAX_PAGES);
      judge.pagesAsked = capped.filter((page) => page.blocks.some((block) => !block.certain)).length;
      const outcome = await inner.judge(capped);
      judge.usage = outcome.usage;
      return outcome;
    },
  };
  return judge;
}

const headOf = (plain: string | undefined) => (plain ?? "").split("\n\n").slice(0, HEAD_LINES);

async function evaluate(source: Source): Promise<PdfResult> {
  const cached = join(OUT, `${source.slug}.json`);
  if (!FORCE && existsSync(cached)) {
    const previous = JSON.parse(readFileSync(cached, "utf8")) as PdfResult;
    // A rules-only result is reused only for a rules-only run; a Jev run computes the missing half.
    if (RULES_ONLY || previous.jev) return previous;
  }
  const bytes = new Uint8Array(readFileSync(join(CORPUS, `${source.slug}.pdf`)));
  const id = createHash("sha256").update(source.slug).digest("hex").slice(0, 16);
  const rules = countingRules();
  const startedRules = Date.now();
  let rulesOutcome: { report: TextViewReport | undefined; plain: string; markdown: string; error?: string };
  try { const content = await buildTextView(bytes, id, { figures: sink, judge: rules }); rulesOutcome = { report: content.report, plain: content.plain ?? "", markdown: content.markdown ?? "" }; }
  catch (error) { rulesOutcome = { report: undefined, plain: "", markdown: "", error: error instanceof Error ? error.message : String(error) }; }
  const rulesMs = Date.now() - startedRules;
  const base: PdfResult = { ...source, pages: rulesOutcome.report?.pages ?? 0, blocks: rules.blocks, asked: rules.asked, rules: { report: rulesOutcome.report, head: headOf(rulesOutcome.plain), plain: rulesOutcome.plain, markdown: rulesOutcome.markdown, ms: rulesMs, ...(rulesOutcome.error ? { error: rulesOutcome.error } : {}) } };
  if (RULES_ONLY || !KEY || rulesOutcome.error) return base;
  if (totals.inputTokens >= BUDGET) return { ...base, jev: { skipped: `budget of ${BUDGET} input tokens reached before this PDF` } };
  const jev = cappedJev();
  const startedJev = Date.now();
  const content = await buildTextView(bytes, id, { figures: sink, judge: jev });
  const usage = jev.usage ?? { requests: 0, inputTokens: 0, outputTokens: 0, latencyMs: 0 };
  return { ...base, jev: { report: content.report, head: headOf(content.plain), plain: content.plain ?? "", markdown: content.markdown ?? "", ms: Date.now() - startedJev, usage, pagesAsked: jev.pagesAsked, maxPages: MAX_PAGES, ...(content.report?.judged?.error ? { error: content.report.judged.error } : {}) } };
}

describe("PDF reflow: rules vs Jev", () => {
  it.each(sources.map((source) => [source.slug, source] as const))("%s", async (_slug, source) => {
    const result = await evaluate(source);
    results.push(result);
    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, `${source.slug}.json`), JSON.stringify(result, null, 2));
    totals.blocks += result.blocks; totals.asked += result.asked; totals.rulesMs += result.rules.ms;
    if (result.jev && "usage" in result.jev) {
      totals.inputTokens += result.jev.usage.inputTokens; totals.outputTokens += result.jev.usage.outputTokens; totals.requests += result.jev.usage.requests;
      totals.jevMs += result.jev.ms; totals.changed += result.jev.report?.judged?.changed ?? 0;
    } else if (result.jev && "skipped" in result.jev) totals.skipped.push(result.slug);
    process.stdout.write(`${source.slug.padEnd(28)} rules ${result.rules.ms} ms · blocks ${result.blocks} · asked ${result.asked}${result.jev && "usage" in result.jev ? ` · jev ${result.jev.ms} ms · ${result.jev.usage.inputTokens} in · changed ${result.jev.report?.judged?.changed ?? 0}${result.jev.error ? ` · ${result.jev.error}` : ""}` : result.jev && "skipped" in result.jev ? ` · jev skipped (${result.jev.skipped})` : ""}\n`);
  });
});

afterAll(() => {
  if (results.length === 0) return;
  writeReport(join(ROOT, "report.md"), results, totals, { maxPages: MAX_PAGES, budget: BUDGET });
});
