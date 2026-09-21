import { rectBottom, rectRight, type Line, type PageLines } from "./types";

// Columns and reading order. A vertical whitespace band through the narrow (column-width)
// lines splits the page into columns; lines that cross a band, or that are far wider than a
// column, form full-width bands of their own (title, abstract, a wide table). Reading order
// is bands top to bottom, and inside a multi-column band the left column first.

/** Column text is between these shares of the text width: wider lines span columns, shorter ones are cells and labels. */
const NARROW_SHARE = 0.6;
const NARROW_MIN_SHARE = 0.25;
/** A column gap must be at least this share of the page width (ACL and IEEE gutters are 2–3%). */
const MIN_GAP_SHARE = 0.015;
/** A gap bin is one that narrow lines cover for at most this share of the narrow text height and at most a few lines (a gutter is near empty). */
const GAP_COVERAGE = 0.15;
const GAP_MAX_LINES = 3;
/** Each side of a gap must hold a bin that narrow lines cover for at least this share of the height and a few stacked lines (a column that ends early still counts). */
const COLUMN_COVERAGE = 0.05;
const COLUMN_MIN_LINES = 4;
/** A line wider than this multiple of its column's width is full-width. */
const FULL_WIDTH_RATIO = 1.6;
/** A line crosses a gap when it extends at least this many ems past the gap centre on both sides. */
const CROSS_EMS = 0.5;
const BINS = 200;
const MAX_COLUMNS = 3;

export interface Band { kind: "full" | "columns"; columns: Line[][]; top: number; bottom: number }

export interface PageLayout {
  page: number;
  bands: Band[];
  /** How many columns the page's body text is set in. */
  columns: number;
  /** The x extent of each column ([left, right]), or of the text as a whole for a single column. */
  extents: [number, number][];
}

interface Gap { start: number; end: number }

function gapsOf(lines: readonly Line[], pageWidth: number): { gaps: Gap[]; left: number; right: number } {
  const left = Math.min(...lines.map((line) => line.rect.x));
  const right = Math.max(...lines.map((line) => rectRight(line.rect)));
  const textWidth = right - left;
  const narrow = lines.filter((line) => line.rect.w <= NARROW_SHARE * textWidth && line.rect.w >= NARROW_MIN_SHARE * textWidth && !line.rotated);
  if (narrow.length < 4) return { gaps: [], left, right };
  const narrowTop = Math.min(...narrow.map((line) => line.rect.y));
  const narrowHeight = Math.max(...narrow.map((line) => rectBottom(line.rect))) - narrowTop;
  if (!(narrowHeight > 0)) return { gaps: [], left, right };
  const binWidth = textWidth / BINS;
  const coverage = new Array<number>(BINS).fill(0);
  for (const line of narrow) {
    const first = Math.max(0, Math.round((line.rect.x - left) / binWidth));
    const last = Math.min(BINS - 1, Math.round((rectRight(line.rect) - left) / binWidth) - 1);
    for (let bin = first; bin <= last; bin += 1) coverage[bin] = (coverage[bin] ?? 0) + line.rect.h;
  }
  const heights = narrow.map((line) => line.rect.h).sort((a, b) => a - b);
  const medianHeight = heights[Math.floor(heights.length / 2)] ?? 0;
  const isGap = coverage.map((value) => value <= Math.min(GAP_COVERAGE * narrowHeight, GAP_MAX_LINES * medianHeight));
  const dense = coverage.map((value) => value >= Math.max(COLUMN_COVERAGE * narrowHeight, COLUMN_MIN_LINES * medianHeight));
  const gaps: Gap[] = [];
  for (let bin = 0; bin < BINS; bin += 1) {
    if (!isGap[bin]) continue;
    let end = bin;
    while (end + 1 < BINS && isGap[end + 1]) end += 1;
    if (bin > 0 && end < BINS - 1 && (end - bin + 1) * binWidth >= MIN_GAP_SHARE * pageWidth) {
      const denseLeft = dense.slice(0, bin).some(Boolean);
      const denseRight = dense.slice(end + 1).some(Boolean);
      if (denseLeft && denseRight) gaps.push({ start: left + bin * binWidth, end: left + (end + 1) * binWidth });
    }
    bin = end;
  }
  const widest = [...gaps].sort((a, b) => (b.end - b.start) - (a.end - a.start)).slice(0, MAX_COLUMNS - 1);
  return { gaps: widest.sort((a, b) => a.start - b.start), left, right };
}

function extentsOf(gaps: readonly Gap[], left: number, right: number): [number, number][] {
  const edges = [left, ...gaps.flatMap((gap) => [gap.start, gap.end]), right];
  return Array.from({ length: gaps.length + 1 }, (_, index) => [edges[index * 2]!, edges[index * 2 + 1]!]);
}

/** A line is full-width when it spans a whole gutter, sits centred over one, or is far wider than its column. */
function columnOf(line: Line, extents: readonly [number, number][], gaps: readonly Gap[]): number | "full" {
  const centre = line.rect.x + line.rect.w / 2;
  const em = CROSS_EMS * line.fontSize;
  if (gaps.some((gap) => line.rect.x < gap.start - em && rectRight(line.rect) > gap.end + em)) return "full";
  if (gaps.some((gap) => centre > gap.start && centre < gap.end)) return "full";
  let index = extents.findIndex(([start, end]) => centre >= start && centre <= end);
  if (index < 0) index = centre < extents[0]![0] ? 0 : extents.length - 1;
  const width = extents[index]![1] - extents[index]![0];
  return line.rect.w > FULL_WIDTH_RATIO * width ? "full" : index;
}

/** Which column each line of a layout sits in ("full" for full-width lines). */
export function placementOf(layout: PageLayout): Map<Line, number | "full"> {
  return new Map(layout.bands.flatMap((band) => band.columns.flatMap((column, index) => column.map((line) => [line, band.kind === "full" ? "full" : index] as const))));
}

/** Bands in y order; a band is full-width lines, or the columns' lines until the next full-width line. */
function bandsOf(lines: readonly Line[], extents: readonly [number, number][], gaps: readonly Gap[]): Band[] {
  const sorted = [...lines].sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
  const bands: Band[] = [];
  for (const line of sorted) {
    const column = columnOf(line, extents, gaps);
    const kind = column === "full" ? "full" : "columns";
    const last = bands[bands.length - 1];
    if (!last || last.kind !== kind) {
      bands.push({ kind, columns: kind === "full" ? [[line]] : extents.map((_, index) => (index === column ? [line] : [])), top: line.rect.y, bottom: rectBottom(line.rect) });
      continue;
    }
    const index = column === "full" ? 0 : column;
    bands[bands.length - 1] = { ...last, columns: last.columns.map((entries, at) => (at === index ? [...entries, line] : entries)), bottom: Math.max(last.bottom, rectBottom(line.rect)) };
  }
  return bands;
}

export function layoutPage(page: PageLines): PageLayout {
  if (page.lines.length === 0) return { page: page.page, bands: [], columns: 1, extents: [[0, page.width]] };
  const { gaps, left, right } = gapsOf(page.lines, page.width);
  const extents = extentsOf(gaps, left, right);
  return { page: page.page, bands: bandsOf(page.lines, extents, gaps), columns: extents.length, extents };
}

/** Column count the document reads in: the most common count over pages with enough text; 1 when nothing qualifies. */
export function dominantColumns(layouts: readonly PageLayout[], minLines = 8): number {
  const counts = new Map<number, number>();
  for (const layout of layouts) {
    const lines = layout.bands.reduce((sum, band) => sum + band.columns.reduce((inner, column) => inner + column.length, 0), 0);
    if (lines < minLines) continue;
    counts.set(layout.columns, (counts.get(layout.columns) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0] ?? 1;
}
