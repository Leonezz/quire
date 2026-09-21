import { numberedDepth } from "./blocks";
import { placementOf, type PageLayout } from "./columns";
import { endsSentence, isProse, rectBottom, rectRight, unionRect, type FigureRegion, type Line, type PageLines, type Rect } from "./types";

// Figures and tables are what the text layer cannot carry: a caption names a region above
// (figures) or below (tables) it that holds no body text; a grid of short lines on shared
// baselines is a table even without a caption. Regions are cropped from the page later.

export const CAPTION = /^(?:(Figure|Fig\.|Table|Algorithm|图|表)\s*(\d+|[IVX]+)(?:\.\d+)?[a-z]?)\s*[:.．：]/i;
/** A region must be at least this share of the page height to be worth a picture. */
const MIN_REGION_SHARE = 0.06;
/** Where the text area starts and ends when no body line bounds a region. */
const PAGE_MARGIN_SHARE = 0.06;
/** A body line's font size stays within this share of the body size. */
const BODY_SIZE_TOLERANCE = 0.08;
/** A body line spans at least this share of its column's width. */
const BODY_WIDTH_SHARE = 0.5;
/** A caption's continuation lines follow within this many font sizes, baseline to baseline. */
const CAPTION_LEADING = 1.6;
const BASELINE_TOLERANCE = 0.4;
/** Lines larger than this multiple of the body size are headings, which bound a region below a caption. */
const HEADING_SIZE_RATIO = 1.1;
/** A grid needs this many rows of several cells each (an author block is three rows: names, affiliations, addresses). */
const MIN_GRID_ROWS = 4;
const GRID_SPACING_TOLERANCE = 0.3;
const PADDING_SHARE = 0.02;

export function captionKind(text: string): "figure" | "table" | undefined {
  const match = CAPTION.exec(text);
  if (!match) return undefined;
  return /^(table|表)/i.test(match[1] ?? "") ? "table" : "figure";
}

type Placement = number | "full";

interface PageContext {
  page: PageLines;
  layout: PageLayout;
  bodySize: number;
  placement: Map<Line, Placement>;
  /** Lines in y order, per placement: a column's lines across all bands, or every line for full-width captions. */
  scanOf: (placement: Placement) => Line[];
  taken: Set<Line>;
}

function sharesBaseline(line: Line, others: readonly Line[]): boolean {
  return others.some((other) => other !== line && Math.abs(other.baseline - line.baseline) <= BASELINE_TOLERANCE * Math.max(other.fontSize, line.fontSize));
}

function columnWidthOf(line: Line, context: PageContext): number {
  const at = context.placement.get(line);
  const extents = context.layout.extents;
  const [left, right] = at === undefined || at === "full" ? [extents[0]![0], extents[extents.length - 1]![1]] : extents[at]!;
  return right - left;
}

/** Body text: body-sized prose, at least half its column wide, alone on its baseline within its column, and not a caption. */
function isBodyLine(line: Line, context: PageContext): boolean {
  if (captionKind(line.text)) return false;
  if (Math.abs(line.fontSize - context.bodySize) > BODY_SIZE_TOLERANCE * context.bodySize) return false;
  if (line.rect.w < BODY_WIDTH_SHARE * columnWidthOf(line, context) || !isProse(line.text)) return false;
  const at = context.placement.get(line);
  return !sharesBaseline(line, at === "full" || at === undefined ? [] : context.scanOf(at));
}

/** A heading line: set larger than the body, or bold at body size and numbered ("3.5 Positional Encoding"). */
function isHeadingLine(line: Line, context: PageContext): boolean {
  if (line.fontSize > HEADING_SIZE_RATIO * context.bodySize) return true;
  return line.bold && line.fontSize >= 0.98 * context.bodySize && numberedDepth(line.text) !== undefined;
}

function captionBlock(first: Line, scan: readonly Line[]): Line[] {
  const block = [first];
  for (let at = scan.indexOf(first) + 1; at < scan.length; at += 1) {
    const line = scan[at]!; const previous = block[block.length - 1]!;
    const sameFont = Math.abs(line.fontSize - first.fontSize) <= 0.06 * first.fontSize;
    const tight = line.baseline - previous.baseline <= CAPTION_LEADING * first.fontSize;
    const indented = endsSentence(previous.text) && line.rect.x - first.rect.x > first.fontSize;
    const outdented = line.rect.x < first.rect.x - first.fontSize;
    if (!sameFont || !tight || captionKind(line.text) || sharesBaseline(line, scan) || indented || outdented) break;
    block.push(line);
  }
  return block;
}

/** Stops at body text, another caption, or a line another region already owns. */
function isBoundary(line: Line, context: PageContext): boolean {
  return isBodyLine(line, context) || captionKind(line.text) !== undefined || context.taken.has(line);
}

/** Above a caption sits the figure itself, whose labels can be large or bold; only prose ends the region there. */
function extentAbove(caption: Line, scan: readonly Line[], context: PageContext): { top: number; lines: Line[] } {
  const lines: Line[] = [];
  for (let at = scan.indexOf(caption) - 1; at >= 0; at -= 1) {
    const line = scan[at]!;
    if (isBoundary(line, context)) return { top: rectBottom(line.rect), lines };
    lines.push(line);
  }
  return { top: PAGE_MARGIN_SHARE * context.page.height, lines };
}

/** Below a caption sit table rows; the next heading ends the region as surely as prose does. */
function extentBelow(last: Line, scan: readonly Line[], context: PageContext): { bottom: number; lines: Line[] } {
  const lines: Line[] = [];
  for (let at = scan.indexOf(last) + 1; at < scan.length; at += 1) {
    const line = scan[at]!;
    if (isBoundary(line, context) || isHeadingLine(line, context)) return { bottom: line.rect.y, lines };
    lines.push(line);
  }
  return { bottom: (1 - PAGE_MARGIN_SHARE) * context.page.height, lines };
}

function captionRegion(line: Line, context: PageContext): FigureRegion | undefined {
  const kind = captionKind(line.text);
  if (!kind || context.taken.has(line)) return undefined;
  const placement = context.placement.get(line) ?? "full";
  const scan = context.scanOf(placement);
  const caption = captionBlock(line, scan);
  const last = caption[caption.length - 1]!;
  const extents = context.layout.extents;
  const [left, right] = placement === "full" ? [extents[0]![0], extents[extents.length - 1]![1]] : extents[placement]!;
  const above = extentAbove(line, scan, context);
  const below = extentBelow(last, scan, context);
  const upper = { rect: { x: left, y: above.top, w: right - left, h: line.rect.y - above.top }, lines: above.lines };
  const lower = { rect: { x: left, y: rectBottom(last.rect), w: right - left, h: below.bottom - rectBottom(last.rect) }, lines: below.lines };
  const minimum = MIN_REGION_SHARE * context.page.height;
  const chosen = (kind === "table" ? [lower, upper] : [upper, lower]).find((candidate) => candidate.rect.h >= minimum);
  if (!chosen) return undefined;
  for (const entry of [...caption, ...chosen.lines]) context.taken.add(entry);
  return { page: context.page.page, kind, rect: chosen.rect, caption, consumed: chosen.lines };
}

/** Rows of several cells on shared baselines, evenly spaced: a table the text layer spells out cell by cell. */
function gridRegions(sequence: readonly Line[], context: PageContext): FigureRegion[] {
  const rows: Line[][] = [];
  for (const line of sequence) {
    if (context.taken.has(line)) { rows.push([]); continue; }
    const last = rows[rows.length - 1];
    if (last && last.length > 0 && Math.abs(line.baseline - last[0]!.baseline) <= BASELINE_TOLERANCE * Math.max(line.fontSize, last[0]!.fontSize)) rows[rows.length - 1] = [...last, line];
    else rows.push([line]);
  }
  const regions: FigureRegion[] = [];
  let run: Line[][] = [];
  const flush = () => {
    if (run.length >= MIN_GRID_ROWS && evenlySpaced(run)) {
      const lines = run.flat();
      for (const line of lines) context.taken.add(line);
      regions.push({ page: context.page.page, kind: "table", rect: unionRect(lines.map((line) => line.rect)), caption: [], consumed: lines });
    }
    run = [];
  };
  for (const row of rows) { if (row.length >= 2) run = [...run, row]; else flush(); }
  flush();
  return regions;
}

function evenlySpaced(rows: readonly Line[][]): boolean {
  const deltas = rows.slice(1).map((row, index) => row[0]!.baseline - rows[index]![0]!.baseline);
  const median = [...deltas].sort((a, b) => a - b)[Math.floor(deltas.length / 2)] ?? 0;
  return median > 0 && deltas.every((delta) => Math.abs(delta - median) <= GRID_SPACING_TOLERANCE * median);
}

function contextOf(page: PageLines, layout: PageLayout, bodySize: number): PageContext {
  const placement = placementOf(layout);
  const byY = (a: Line, b: Line) => a.rect.y - b.rect.y || a.rect.x - b.rect.x;
  const all = [...placement.keys()].sort(byY);
  const scans = new Map<Placement, Line[]>();
  const scanOf = (at: Placement) => {
    const cached = scans.get(at);
    if (cached) return cached;
    const lines = at === "full" ? all : all.filter((line) => placement.get(line) === at);
    scans.set(at, lines);
    return lines;
  };
  return { page, layout, bodySize, placement, scanOf, taken: new Set() };
}

/** Every picture region of a page, padded a little beyond its bounds and kept inside the page. */
export function figureRegionsOf(page: PageLines, layout: PageLayout, bodySize: number): FigureRegion[] {
  const context = contextOf(page, layout, bodySize);
  const captioned = context.scanOf("full").flatMap((line) => { const region = captionRegion(line, context); return region ? [region] : []; });
  const grids = layout.bands.flatMap((band) => band.columns.flatMap((column) => gridRegions(column, context)));
  return [...captioned, ...grids].map((region) => ({ ...region, rect: padded(region.rect, page) }));
}

function padded(rect: Rect, page: PageLines): Rect {
  const dx = PADDING_SHARE * page.width; const dy = PADDING_SHARE * page.height;
  const x = Math.max(0, rect.x - dx); const y = Math.max(0, rect.y - dy);
  return { x, y, w: Math.min(page.width, rectRight(rect) + dx) - x, h: Math.min(page.height, rectBottom(rect) + dy) - y };
}
