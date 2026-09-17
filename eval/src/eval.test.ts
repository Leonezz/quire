// One test per snapshot: the current extraction must match its reviewed golden.
// GOLDEN=1 writes missing goldens (GOLDEN=all rewrites every golden) instead of comparing.
// The report (eval/report.md) is rewritten on every run.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CORPUS_DIR, ROOT, normalizeSnapshot, snapshots } from "./corpus";
import { diffSummaries, reviewFlags, summarize, type Summary } from "./summarize";

const GOLDEN = process.env.GOLDEN ?? "";
const PASS_RATE = 0.85;

interface Golden { reviewed: boolean; notes: string; summary: Summary }
interface Row { slug: string; framework: string; generator: string; extractor: string; words: number; flags: string[]; diff: string[]; golden: "missing" | "reviewed" | "unreviewed"; pass: boolean }

const rows: Row[] = [];
const all = snapshots();

describe("rendering evaluation set", () => {
  it("has snapshots to evaluate", () => { expect(all.length).toBeGreaterThan(0); });

  it.each(all.map((s) => [s.slug, s] as const))("%s", (_slug, snapshot) => {
    const summary = summarize(normalizeSnapshot(snapshot));
    const goldenPath = join(CORPUS_DIR, snapshot.slug, "expected.json");
    const existing = existsSync(goldenPath) ? (JSON.parse(readFileSync(goldenPath, "utf8")) as Golden) : undefined;
    if (GOLDEN === "all" || (GOLDEN && !existing)) {
      const golden: Golden = { reviewed: existing?.reviewed ?? false, notes: existing?.notes ?? "", summary };
      writeFileSync(goldenPath, JSON.stringify(golden, null, 2) + "\n");
    }
    const golden = GOLDEN ? { reviewed: existing?.reviewed ?? false, notes: existing?.notes ?? "", summary } : existing;
    const flags = reviewFlags(summary, snapshot.tags);
    const diff = golden ? diffSummaries(golden.summary, summary) : [];
    const p0 = flags.some((flag) => flag.startsWith("P0"));
    const pass = !!golden && diff.length === 0 && !p0;
    rows.push({ slug: snapshot.slug, framework: snapshot.framework, generator: snapshot.generator, extractor: summary.extractor, words: summary.counts.words, flags, diff, golden: golden ? (golden.reviewed ? "reviewed" : "unreviewed") : "missing", pass });
    expect(diff, `extraction changed since the golden:\n${diff.join("\n")}`).toEqual([]);
    expect(p0, `P0: ${flags.join("; ")}`).toBe(false);
  });

  it("meets the pass rate", () => {
    const passed = rows.filter((row) => row.pass).length;
    expect(passed / Math.max(1, rows.length)).toBeGreaterThanOrEqual(PASS_RATE);
  });
});

afterAll(() => {
  const sorted = [...rows].sort((a, b) => a.slug.localeCompare(b.slug));
  const passed = sorted.filter((row) => row.pass).length;
  const lines = [
    `# Rendering evaluation — ${new Date().toISOString().slice(0, 10)}`,
    "",
    `${passed}/${sorted.length} pass (${sorted.length ? Math.round((passed / sorted.length) * 100) : 0}%), gate ${Math.round(PASS_RATE * 100)}%. Reviewed goldens: ${sorted.filter((r) => r.golden === "reviewed").length}.`,
    "",
    "| doc | framework | generator | extractor | words | golden | flags | diff |",
    "|---|---|---|---|---:|---|---|---|",
    ...sorted.map((row) => `| ${row.pass ? "✅" : "❌"} ${row.slug} | ${row.framework} | ${row.generator || "-"} | ${row.extractor.replace("article.", "")} | ${row.words} | ${row.golden} | ${row.flags.join("; ") || "-"} | ${row.diff.join("; ") || "-"} |`),
    "",
  ];
  mkdirSync(ROOT, { recursive: true });
  writeFileSync(join(ROOT, "report.md"), lines.join("\n"));
});
