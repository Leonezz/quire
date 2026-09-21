// Shared shapes of the SDT-lite reflow. Geometry is in page points with a top-left origin
// (pdf.js viewport space at scale 1); it is converted to canonical 0..1 rects only at the end.

export interface Rect { x: number; y: number; w: number; h: number }

/** One pdf.js text item with its box resolved on the page. */
export interface Run {
  text: string;
  rect: Rect;
  /** Baseline y of upright text; the rect's bottom for rotated runs. */
  baseline: number;
  fontSize: number;
  bold: boolean;
  italic: boolean;
  rotated: boolean;
}

/** Runs on one baseline that read as one line (a table cell is its own line). */
export interface Line {
  page: number;
  text: string;
  rect: Rect;
  baseline: number;
  fontSize: number;
  bold: boolean;
  rotated: boolean;
  /** The line opens with a bold span that ends in a period or colon and regular text follows: a run-in heading, not a heading line. */
  boldLead?: boolean;
}

export interface PageSize { width: number; height: number }

export interface PageLines extends PageSize {
  page: number;
  lines: Line[];
  /** The text layer was empty or unusable; nothing of this page reaches the view. */
  degraded: boolean;
}

/** A picture region: what is cropped from the page and the caption that names it. */
export interface FigureRegion {
  page: number;
  rect: Rect;
  kind: "figure" | "table";
  caption: Line[];
  /** The lines the region swallowed (table cells, axis labels); they leave the text flow. */
  consumed: Line[];
}

export type SequenceItem = { kind: "line"; line: Line } | { kind: "figure"; region: FigureRegion };

/** A run of lines that read top to bottom without interruption: one column of a band, or a full-width band. */
export interface Sequence {
  page: number;
  items: SequenceItem[];
  /** The x extent of the column or band the sequence belongs to. */
  left: number;
  right: number;
}

export function unionRect(rects: readonly Rect[]): Rect {
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.w));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.h));
  return { x: left, y: top, w: right - left, h: bottom - top };
}

export function rectBottom(rect: Rect): number { return rect.y + rect.h; }
export function rectRight(rect: Rect): number { return rect.x + rect.w; }

/** The rect in the canonical 0..1 page space that pdf-regions locators use, rounded to 4 decimals. */
export function canonicalRect(rect: Rect, page: PageSize): [number, number, number, number] {
  const clamp = (value: number) => Math.min(1, Math.max(0, value));
  const round = (value: number) => Number(clamp(value).toFixed(4));
  const x = clamp(rect.x / page.width);
  const y = clamp(rect.y / page.height);
  return [round(x), round(y), round(Math.min(rect.w / page.width, 1 - x)), round(Math.min(rect.h / page.height, 1 - y))];
}

export const SENTENCE_END = /[.!?。！？:][\s"”’')\]]*$/;

export function endsSentence(text: string): boolean { return SENTENCE_END.test(text.trimEnd()); }

export function wordCountOf(text: string): number { return text.trim().split(/\s+/).filter(Boolean).length; }

/** At least this share of a line's tokens must be lowercase words for it to read as prose. */
const PROSE_SHARE = 0.4;

/** Running text reads mostly as lowercase words; a table row ("Recurrent O(n · d2) O(n) O(n)") or a name line does not. */
export function isProse(text: string): boolean {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length < 3) return false;
  const words = tokens.filter((token) => /^\p{Ll}[\p{L}\d'’-]*[,.;:)]*$/u.test(token)).length;
  return words / tokens.length >= PROSE_SHARE;
}
