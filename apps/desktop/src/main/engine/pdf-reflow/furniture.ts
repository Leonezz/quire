import { rectRight, type Line, type PageLines } from "./types";

// Page furniture: running heads, footers and page numbers repeat at the same place on page
// after page; a preprint watermark runs up the margin. None of it belongs in the reflow.

/** The top and bottom bands (fraction of the page height) where furniture lives. */
const FURNITURE_BAND = 0.08;
/** Lines repeat "at a similar y" when their centres fall in the same band of this height. */
const Y_BUCKET = 0.04;
/** A watermark stands in the outer margins of this width. */
const MARGIN_BAND = 0.06;
/** Repeats on at least this many pages make furniture; short documents need half their pages. */
const REPEAT_PAGES = 3;

const PAGE_NUMBER = /^[\s—–\-·|]*(?:page|p\.|pg\.?|第)?\s*\d{1,4}\s*(?:(?:of|\/|页)\s*\d{1,4})?[\s—–\-·|]*$/i;

/** A footnote or citation mark that landed on its own raised baseline: a few characters, set much smaller than the body. */
const MARKER_SIZE_RATIO = 0.75;
const MARKER = /^[\d*∗†‡§¶a-z]{1,3}$/;

export interface FurnitureResult { pages: PageLines[]; removed: number }

function normalize(text: string): string {
  return text.replace(/\d/g, "#").replace(/\s+/g, " ").trim().toLowerCase();
}

function inFurnitureBand(line: Line, page: PageLines): "top" | "bottom" | undefined {
  const centre = (line.rect.y + line.rect.h / 2) / page.height;
  if (centre <= FURNITURE_BAND) return "top";
  if (centre >= 1 - FURNITURE_BAND) return "bottom";
  return undefined;
}

function repeatKey(line: Line, page: PageLines): string | undefined {
  const band = inFurnitureBand(line, page);
  if (!band) return undefined;
  const bucket = Math.round((line.rect.y + line.rect.h / 2) / page.height / Y_BUCKET);
  return `${band}|${bucket}|${normalize(line.text)}`;
}

export function isWatermark(line: Line, page: PageLines): boolean {
  if (!line.rotated || line.rect.h <= line.rect.w) return false;
  return line.rect.x <= MARGIN_BAND * page.width || rectRight(line.rect) >= (1 - MARGIN_BAND) * page.width;
}

export function isPageNumber(line: Line, page: PageLines): boolean {
  return inFurnitureBand(line, page) !== undefined && PAGE_NUMBER.test(line.text);
}

/** Superscript marks that fell off their line are noise, not text; they are dropped without counting as furniture. */
export function withoutMarkers(pages: readonly PageLines[], bodySize: number): PageLines[] {
  return pages.map((page) => ({ ...page, lines: page.lines.filter((line) => !(MARKER.test(line.text) && line.fontSize < MARKER_SIZE_RATIO * bodySize)) }));
}

/** Drops repeated heads/feet, bare page numbers and margin watermarks; counts what went. */
export function removeFurniture(pages: readonly PageLines[]): FurnitureResult {
  const threshold = Math.min(REPEAT_PAGES, Math.max(2, Math.ceil(pages.length / 2)));
  const pagesByKey = new Map<string, Set<number>>();
  for (const page of pages) {
    for (const line of page.lines) {
      const key = repeatKey(line, page);
      if (!key) continue;
      pagesByKey.set(key, new Set([...(pagesByKey.get(key) ?? []), page.page]));
    }
  }
  const repeated = new Set([...pagesByKey.entries()].filter(([, ids]) => ids.size >= threshold).map(([key]) => key));
  let removed = 0;
  const cleaned = pages.map((page) => {
    const lines = page.lines.filter((line) => {
      const key = repeatKey(line, page);
      const furniture = (key !== undefined && repeated.has(key)) || isPageNumber(line, page) || isWatermark(line, page);
      if (furniture) removed += 1;
      return !furniture;
    });
    return { ...page, lines };
  });
  return { pages: cleaned, removed };
}
