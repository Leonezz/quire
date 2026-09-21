// The eval's report: per PDF the rules' and Jev's reports side by side, Jev's cost, and the
// first lines of each `plain`; then the totals. Pure formatting over the harness's results.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TextViewReport } from "../../apps/desktop/src/shared/contracts";
import type { JudgeUsage } from "../../apps/desktop/src/main/engine/pdf-reflow/judge";

export const PRICE_PER_MILLION_INPUT_USD = 0.042;

export interface RulesRun { report: TextViewReport | undefined; head: string[]; plain: string; markdown: string; ms: number; error?: string }
export interface JevRun extends RulesRun { usage: JudgeUsage; pagesAsked: number; maxPages: number }

export interface PdfResult {
  slug: string; url: string; kind: string; layout: string;
  pages: number;
  /** Blocks the rules produced, and how many of them the gate sent to the judge. */
  blocks: number; asked: number;
  rules: RulesRun;
  jev?: JevRun | { skipped: string };
}

export interface RunTotals { inputTokens: number; outputTokens: number; requests: number; jevMs: number; rulesMs: number; blocks: number; asked: number; changed: number; skipped: string[] }

const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
const clip = (text: string, max = 110) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);
const percent = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : "–");
const usd = (tokens: number) => `$${((tokens / 1_000_000) * PRICE_PER_MILLION_INPUT_USD).toFixed(4)}`;

function reportCells(report: TextViewReport | undefined, error: string | undefined): string {
  if (!report) return `build failed: ${cell(error ?? "unknown")}`;
  return `${report.pages} p · ${report.columns} col · ${report.furnitureLines} furn · ${report.headings} head · ${report.paragraphs} para · ${report.figures} fig${report.degradedPages.length ? ` · degraded ${report.degradedPages.length}` : ""}`;
}

function jevCells(result: PdfResult): string[] {
  const jev = result.jev;
  if (!jev) return ["not run", "–", "–", "–"];
  if ("skipped" in jev) return [`skipped: ${cell(jev.skipped)}`, "–", "–", "–"];
  const judged = jev.report?.judged;
  const asked = judged ? `${judged.asked} asked · ${judged.changed} changed${judged.error ? ` · error` : ""}` : "–";
  return [reportCells(jev.report, jev.error), asked, `${jev.usage.inputTokens.toLocaleString()} in / ${jev.usage.outputTokens.toLocaleString()} out · ${jev.usage.requests} req · ${jev.pagesAsked}/${jev.maxPages} p`, `${(jev.ms / 1000).toFixed(1)} s (rules ${(result.rules.ms / 1000).toFixed(1)} s)`];
}

function headSection(result: PdfResult): string[] {
  const jev = result.jev && "head" in result.jev ? result.jev : undefined;
  const rows = Array.from({ length: Math.max(result.rules.head.length, jev?.head.length ?? 0) }, (_, index) => `| ${index + 1} | ${cell(clip(result.rules.head[index] ?? ""))} | ${cell(clip(jev?.head[index] ?? (jev ? "" : "–")))} |`);
  return [`#### ${result.slug} — ${result.layout}`, "", `Source: ${result.url} · ${result.pages} pages · ${result.blocks} blocks, ${result.asked} asked (${percent(result.asked, result.blocks)})${jev?.error ? `\n\nJev error: ${jev.error}` : ""}`, "", "| # | rules | jev |", "|---:|---|---|", ...rows, ""];
}

export function writeReport(path: string, results: readonly PdfResult[], totals: RunTotals, options: { maxPages: number; budget: number }): void {
  const sorted = [...results].sort((a, b) => a.slug.localeCompare(b.slug));
  const ran = sorted.filter((result) => result.jev && "usage" in result.jev);
  const lines = [
    `# PDF reflow eval — rules vs Jev — ${new Date().toISOString().slice(0, 10)}`,
    "",
    `${sorted.length} PDFs. Jev judged at most the first N pages of each (N is the second number in the "pages" column: ${options.maxPages} on this run, other rows keep the cap of the run that produced them); the rest keep the rules. Run budget ${options.budget.toLocaleString()} input tokens${totals.skipped.length ? `, reached before: ${totals.skipped.join(", ")}` : ""}.`,
    "",
    "## Per PDF",
    "",
    "| pdf | kind | rules report | jev report | jev asked / changed | jev tokens · requests · pages | jev wall time |",
    "|---|---|---|---|---|---|---|",
    ...sorted.map((result) => `| ${result.slug} | ${result.kind} | ${reportCells(result.rules.report, result.rules.error)} | ${jevCells(result).join(" | ")} |`),
    "",
    "## Totals",
    "",
    `- Blocks: ${totals.blocks.toLocaleString()}; asked (gate): ${totals.asked.toLocaleString()} (${percent(totals.asked, totals.blocks)}); changed by Jev: ${totals.changed.toLocaleString()} (${percent(totals.changed, totals.asked)} of asked)`,
    `- Jev: ${totals.requests.toLocaleString()} requests, ${totals.inputTokens.toLocaleString()} input tokens, ${totals.outputTokens.toLocaleString()} output tokens → ${usd(totals.inputTokens)} at $${PRICE_PER_MILLION_INPUT_USD}/M input`,
    `- Wall time: rules ${(totals.rulesMs / 1000).toFixed(1)} s, Jev builds ${(totals.jevMs / 1000).toFixed(1)} s over ${ran.length} PDFs (${ran.length ? (totals.jevMs / ran.length / 1000).toFixed(1) : "–"} s each)`,
    "",
    ...humanVerdicts(path),
    `## First ${sorted[0]?.rules.head.length ?? 12} lines of \`plain\``,
    "",
    ...sorted.flatMap(headSection),
  ];
  writeFileSync(path, lines.join("\n"));
}

/** verdicts.md beside the report: what a reader concluded from the outputs, kept by hand across runs. */
function humanVerdicts(reportPath: string): string[] {
  const path = join(dirname(reportPath), "verdicts.md");
  return existsSync(path) ? [readFileSync(path, "utf8").trim(), ""] : [];
}
