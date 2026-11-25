import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { MediaEvalRow, MediaFixture } from "./types";

export function writeMediaSourcesManifest(path: string, fixtures: readonly MediaFixture[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const manifest = fixtures.map((f) => ({
    slug: f.slug,
    title: f.title,
    url: f.url,
    kind: f.kind,
    language: f.language,
    format: f.format,
    scenario: f.scenario,
    expectedChapters: f.expectedChapters.length,
    probes: f.probes.length,
    agentCleanup: Boolean(f.agentCleanup),
  }));
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

export function formatMediaReport(rows: readonly MediaEvalRow[], dateIso = new Date().toISOString().slice(0, 10)): string {
  const sorted = [...rows].sort((a, b) => a.slug.localeCompare(b.slug));
  const passed = sorted.filter((r) => r.pass).length;
  const podcasts = sorted.filter((r) => r.kind === "podcast").length;
  const videos = sorted.filter((r) => r.kind === "video").length;

  const totalExpectedChapters = sorted.reduce((s, r) => s + r.expectedChapters, 0);
  const totalMatchedChapters = sorted.reduce((s, r) => s + r.matchedChapters, 0);
  const totalFalseChapters = sorted.reduce((s, r) => s + r.falsePositiveChapters, 0);

  const worstAnchorDrift = sorted.reduce((m, r) => Math.max(m, r.maxAnchorStartDriftSec), 0);
  const worstProbeDrift = sorted.reduce((m, r) => Math.max(m, r.maxProbeDriftSec), 0);
  const totalOffsetMismatches = sorted.reduce((s, r) => s + r.offsetMismatches, 0);

  const globalMinUnits = sorted.length ? Math.min(...sorted.map((r) => r.minParaUnits)) : 0;
  const globalMaxUnits = sorted.length ? Math.max(...sorted.map((r) => r.maxParaUnits)) : 0;
  const medianOfMedians = sorted.length
    ? [...sorted.map((r) => r.p50ParaUnits)].sort((a, b) => a - b)[Math.floor(sorted.length / 2)]!
    : 0;

  const cleanupRows = sorted.filter((r) => r.agentCleanupChecked);
  const cleanupPassed = cleanupRows.filter((r) => r.agentCleanupPassed).length;

  const lines = [
    `# Media Reading Evaluation — ${dateIso}`,
    "",
    `${passed}/${sorted.length} snapshots pass (${sorted.length ? Math.round((passed / sorted.length) * 100) : 0}%) — ${podcasts} podcasts, ${videos} technical videos.`,
    "",
    "## Aggregate Baseline Metrics",
    "",
    `- **Chapter Recall**: ${totalMatchedChapters}/${totalExpectedChapters} (${totalExpectedChapters ? Math.round((totalMatchedChapters / totalExpectedChapters) * 100) : 100}%), false positives: ${totalFalseChapters}`,
    `- **Natural Paragraph Word-Unit Distribution**: min \`${globalMinUnits}\` · median \`${medianOfMedians}\` · max \`${globalMaxUnits}\` units (target band: \`15–175\` units, \`2 CJK chars = 1 unit\`)`,
    `- **Time Anchor Accuracy (\`< 0.5s\` gate)**: max paragraph-start drift \`${worstAnchorDrift.toFixed(2)}s\`, max phrase-probe drift \`${worstProbeDrift.toFixed(2)}s\`, character-offset mismatches \`${totalOffsetMismatches}\``,
    `- **Agent Cleanup Fidelity & Guardrails**: ${cleanupPassed}/${cleanupRows.length} passed (\`±20%\` word-unit guardrail, monotonic \`[MM:SS]\` check, and dual-anchor highlight survival)`,
    "",
    "## Per Snapshot",
    "",
    "| snapshot | kind | lang | format | cues → paras | chapters | para units (min/p50/max) | max drift | cleanup | flags |",
    "|---|---|---|---|---:|---:|---:|---:|---|---|",
    ...sorted.map((r) => {
      const chCell = r.expectedChapters > 0 ? `${r.matchedChapters}/${r.expectedChapters}` : `0 (fp:${r.falsePositiveChapters})`;
      const driftCell = `${Math.max(r.maxAnchorStartDriftSec, r.maxProbeDriftSec).toFixed(2)}s`;
      const cleanupCell = r.agentCleanupChecked ? (r.agentCleanupPassed ? "pass" : "FAIL") : "–";
      return `| ${r.pass ? "✅" : "❌"} ${r.slug} | ${r.kind} | ${r.language} | ${r.format} | ${r.rawCues} → ${r.paragraphs}${r.figures ? ` (+${r.figures} fig)` : ""} | ${chCell} | ${r.minParaUnits}/${r.p50ParaUnits}/${r.maxParaUnits} | ${driftCell} | ${cleanupCell} | ${r.flags.join("; ") || "-"} |`;
    }),
    "",
  ];
  return lines.join("\n");
}

export function writeMediaReport(path: string, rows: readonly MediaEvalRow[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, formatMediaReport(rows));
}
