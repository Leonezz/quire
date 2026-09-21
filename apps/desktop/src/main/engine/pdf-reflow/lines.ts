import { rectRight, unionRect, type Line, type Run } from "./types";

// Runs → lines. Upright runs cluster by baseline, then split where the horizontal gap is
// wider than a table cell's padding; a rotated run (a watermark, a vertical axis label) is
// a line of its own.

/** Two runs share a baseline when they sit within this fraction of the larger font size. */
const BASELINE_TOLERANCE = 0.4;
/** A horizontal gap wider than this many ems ends the line: the next run is another cell or the next column (column gutters run about 1.1–1.5 em). */
const CELL_GAP_EMS = 1;
/** A gap wider than this many ems between runs of one line is a word space that was never drawn. */
const WORD_GAP_EMS = 0.25;
/** A line is bold when nearly all of its characters came from a bold font (a bold run-in phrase does not make the line bold). */
const BOLD_SHARE = 0.9;

/** A run size counts for the line when it holds at least this share of the characters (small caps set their initials larger). */
const SIZE_SHARE = 0.15;

/** The largest size that a fair share of the line is set in: small-caps headings keep their capital size, a lone symbol changes nothing. */
function lineFontSize(runs: readonly Run[]): number {
  const weights = new Map<number, number>();
  let total = 0;
  for (const run of runs) {
    const key = Math.round(run.fontSize * 2) / 2;
    const chars = run.text.trim().length;
    weights.set(key, (weights.get(key) ?? 0) + chars);
    total += chars;
  }
  const sizes = [...weights.entries()].filter(([, chars]) => chars >= SIZE_SHARE * total).map(([size]) => size);
  return sizes.length > 0 ? Math.max(...sizes) : runs[0]?.fontSize ?? 0;
}

function joinRuns(runs: readonly Run[]): string {
  let text = "";
  let pendingSpace = false;
  let right = Number.NEGATIVE_INFINITY;
  for (const run of runs) {
    if (run.text.trim().length === 0) { pendingSpace = text.length > 0; right = Math.max(right, rectRight(run.rect)); continue; }
    const gap = run.rect.x - right;
    const space = text.length > 0 && (pendingSpace || gap > WORD_GAP_EMS * run.fontSize || /\s$/.test(text) || /^\s/.test(run.text));
    text += (space ? " " : "") + run.text.trim();
    pendingSpace = false;
    right = Math.max(right, rectRight(run.rect));
  }
  return text.replace(/\s+/g, " ").trim();
}

function lineOf(page: number, runs: readonly Run[]): Line | undefined {
  const text = joinRuns(runs);
  if (text.length === 0) return undefined;
  const inked = runs.filter((run) => run.text.trim().length > 0);
  const chars = inked.reduce((sum, run) => sum + run.text.trim().length, 0);
  const boldChars = inked.filter((run) => run.bold).reduce((sum, run) => sum + run.text.trim().length, 0);
  const rect = unionRect(inked.map((run) => run.rect));
  return { page, text, rect, baseline: inked[0]?.baseline ?? rect.y + rect.h, fontSize: lineFontSize(inked), bold: chars > 0 && boldChars / chars >= BOLD_SHARE, rotated: inked.every((run) => run.rotated) };
}

/** Runs on one baseline, in x order, split into lines wherever the gap exceeds a cell's padding. */
function splitByGap(page: number, cluster: readonly Run[]): Line[] {
  const sorted = [...cluster].sort((a, b) => a.rect.x - b.rect.x);
  const groups: Run[][] = [];
  let current: Run[] = [];
  let right = Number.NEGATIVE_INFINITY;
  for (const run of sorted) {
    const gap = run.rect.x - right;
    if (current.length > 0 && gap > CELL_GAP_EMS * Math.max(run.fontSize, current[current.length - 1]!.fontSize)) { groups.push(current); current = []; }
    current = [...current, run];
    right = Math.max(right, rectRight(run.rect));
  }
  if (current.length > 0) groups.push(current);
  return groups.flatMap((group) => { const line = lineOf(page, group); return line ? [line] : []; });
}

export function linesOfRuns(page: number, runs: readonly Run[]): Line[] {
  const rotated = runs.filter((run) => run.rotated).flatMap((run) => { const line = lineOf(page, [run]); return line ? [line] : []; });
  const upright = runs.filter((run) => !run.rotated).sort((a, b) => a.baseline - b.baseline || a.rect.x - b.rect.x);
  const clusters: Run[][] = [];
  let current: Run[] = [];
  for (const run of upright) {
    const last = current[current.length - 1];
    if (last && Math.abs(run.baseline - last.baseline) > BASELINE_TOLERANCE * Math.max(run.fontSize, last.fontSize)) { clusters.push(current); current = []; }
    current = [...current, run];
  }
  if (current.length > 0) clusters.push(current);
  const lines = clusters.flatMap((cluster) => splitByGap(page, cluster));
  return [...lines, ...rotated].sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
}
