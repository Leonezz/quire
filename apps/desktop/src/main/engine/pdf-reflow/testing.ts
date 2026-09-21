import type { Line, PageLines, Run } from "./types";

// Synthetic geometry for the reflow tests: A4-ish pages in points, lines given by their
// top-left corner and width, with the height and baseline derived from the font size.

export const PAGE = { width: 600, height: 800 };

export interface LineSpec {
  text: string;
  x: number;
  y: number;
  w: number;
  size?: number;
  bold?: boolean;
  rotated?: boolean;
  page?: number;
}

export function line(spec: LineSpec): Line {
  const size = spec.size ?? 10;
  const h = spec.rotated ? spec.w : size;
  const w = spec.rotated ? size : spec.w;
  return { page: spec.page ?? 1, text: spec.text, rect: { x: spec.x, y: spec.y, w, h }, baseline: spec.y + size * 0.8, fontSize: size, bold: spec.bold ?? false, rotated: spec.rotated ?? false };
}

export function run(text: string, x: number, y: number, w: number, size = 10, extra: Partial<Pick<Run, "bold" | "italic" | "rotated">> = {}): Run {
  return { text, rect: { x, y: y - size * 0.8, w, h: size }, baseline: y, fontSize: size, bold: false, italic: false, rotated: false, ...extra };
}

export function pageOf(lines: Line[], page = 1): PageLines {
  return { page, ...PAGE, lines: lines.map((entry) => ({ ...entry, page })), degraded: false };
}

/** A column of body lines: `count` lines of `width` starting at (x, y), one every `leading` points. */
export function column(x: number, y: number, width: number, count: number, options: { leading?: number; size?: number; page?: number; text?: (index: number) => string } = {}): Line[] {
  const leading = options.leading ?? 12;
  return Array.from({ length: count }, (_, index) => line({
    text: options.text?.(index) ?? `line ${index + 1} of the running text that fills the column and keeps going`,
    x, y: y + index * leading, w: width, size: options.size ?? 10, page: options.page ?? 1,
  }));
}
