import { decodeTextQuoteLocator, encodeTextQuoteV2Locator } from "@read/reader";
import { parsePdfRegionsLocator, type PdfRegion } from "@read/reader-pdf";
import type { MaterialViewContent, TextViewAnchor } from "../../shared/contracts";

// The text view's line anchors carry a note between the two renderings of a PDF: a quote in the
// reflowed text becomes page regions (what the PDF reader draws), and page regions become a quote
// (what the article reader resolves). Both mappings are pure and work on the view's `plain` text.

/** What the mappings need of the text view: its plain text and the line anchors into it. */
export type TextViewSource = Pick<MaterialViewContent, "plain" | "anchors">;

export interface TextQuote { locator: string; quote: string }

/** Regions for a quote: one locator (a single page), and the pages the quote continues on that it cannot carry. */
export interface QuoteRegions { locator: string; page: number; otherPages: number[] }

/** How much of a line's height a region must cover to count the line as highlighted. */
const LINE_OVERLAP = 0.5;
/** Characters of context kept around a quote, as the reader's own captures do. */
const CONTEXT_CHARS = 32;
const REGION_DECIMALS = 4;

/** `plain` without whitespace, each kept character remembering its offset (locators compare whitespace-free text). */
function canonical(plain: string): { text: string; offsets: number[] } {
  const offsets: number[] = [];
  let text = "";
  for (let offset = 0; offset < plain.length; offset += 1) {
    const character = plain[offset] ?? "";
    if (/\s/.test(character)) continue;
    text += character;
    offsets.push(offset);
  }
  return { text, offsets };
}

const stripSpace = (value: string) => value.replace(/\s+/g, "");

function allIndexesOf(haystack: string, needle: string): number[] {
  const found: number[] = [];
  let cursor = 0;
  while ((cursor = haystack.indexOf(needle, cursor)) >= 0) { found.push(cursor); cursor += Math.max(1, needle.length); }
  return found;
}

/**
 * Where the quote sits in `plain`, as [start, end) offsets. Repeated occurrences are told apart by the
 * locator's prefix and suffix (compared as far as the text reaches); when they do not decide, the first
 * occurrence wins. Undefined when the quote is not in the text at all.
 */
export function locateQuote(plain: string, capture: TextQuote): { start: number; end: number } | undefined {
  const target = stripSpace(capture.quote);
  if (!target) return undefined;
  const { text, offsets } = canonical(plain);
  const matches = allIndexesOf(text, target);
  if (matches.length === 0) return undefined;
  const hint = decodeTextQuoteLocator(capture.locator);
  const prefix = hint ? stripSpace(hint.prefix) : "";
  const suffix = hint ? stripSpace(hint.suffix) : "";
  const inContext = matches.filter((start) => {
    const before = text.slice(Math.max(0, start - prefix.length), start);
    const after = text.slice(start + target.length, start + target.length + suffix.length);
    return (!prefix || prefix.endsWith(before)) && (!suffix || suffix.startsWith(after));
  });
  const start = (matches.length === 1 ? matches[0] : inContext[0] ?? matches[0])!;
  const first = offsets[start]!;
  const last = offsets[start + target.length - 1]!;
  return { start: first, end: last + 1 };
}

const fixed = (value: number) => Math.min(1, Math.max(0, value)).toFixed(REGION_DECIMALS);

function encodeRegions(page: number, rects: readonly TextViewAnchor["rect"][]): string | undefined {
  const parts = rects.map(([x, y, w, h]) => [fixed(x), fixed(y), fixed(w), fixed(h)]).filter(([, , w, h]) => Number(w) > 0 && Number(h) > 0).map((values) => values.join(","));
  return parts.length ? `pdf-regions:v1:${page}:${parts.join(";")}` : undefined;
}

/** The anchor's rect narrowed to the characters [start, end) of its own span, proportionally. */
function clippedRect(anchor: TextViewAnchor, start: number, end: number): TextViewAnchor["rect"] {
  const [x, y, w, h] = anchor.rect;
  const length = anchor.end - anchor.start;
  if (length <= 0) return anchor.rect;
  const from = Math.max(0, (start - anchor.start) / length);
  const to = Math.min(1, (end - anchor.start) / length);
  return [x + w * from, y, w * (to - from), h];
}

/**
 * The page regions a quote of the text view covers: the anchors overlapping the quote's span, the first
 * and last clipped to the quoted characters, grouped by page. The locator carries the first page; a quote
 * that runs on to further pages lists them in `otherPages` (a pdf-regions locator names one page).
 */
export function pdfRegionsForQuote(content: TextViewSource, capture: TextQuote): QuoteRegions | undefined {
  const anchors = content.anchors ?? [];
  if (!content.plain || anchors.length === 0) return undefined;
  const span = locateQuote(content.plain, capture);
  if (!span) return undefined;
  const covered = anchors.filter((anchor) => anchor.start < span.end && anchor.end > span.start);
  if (covered.length === 0) return undefined;
  const byPage = new Map<number, TextViewAnchor["rect"][]>();
  for (const anchor of covered) {
    const rect = clippedRect(anchor, Math.max(span.start, anchor.start), Math.min(span.end, anchor.end));
    byPage.set(anchor.page, [...(byPage.get(anchor.page) ?? []), rect]);
  }
  const pages = [...byPage.keys()].sort((a, b) => a - b);
  const page = pages[0]!;
  const locator = encodeRegions(page, byPage.get(page)!);
  return locator ? { locator, page, otherPages: pages.slice(1) } : undefined;
}

/** The horizontal extent of the regions that cover at least half of the anchor's height, or undefined when none does. */
function coveredExtent(anchor: TextViewAnchor, regions: readonly PdfRegion[]): { left: number; right: number } | undefined {
  const [x, y, w, h] = anchor.rect;
  let left = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  for (const region of regions) {
    const vertical = Math.min(y + h, region.y + region.height) - Math.max(y, region.y);
    const overlapLeft = Math.max(x, region.x);
    const overlapRight = Math.min(x + w, region.x + region.width);
    if (vertical < LINE_OVERLAP * h || overlapRight <= overlapLeft) continue;
    left = Math.min(left, overlapLeft);
    right = Math.max(right, overlapRight);
  }
  return right > left ? { left, right } : undefined;
}

/** The characters of the anchor under a horizontal extent, as [start, end) offsets into `plain`; at least one character. */
function charactersUnder(anchor: TextViewAnchor, extent: { left: number; right: number }): { start: number; end: number } {
  const [x, , w] = anchor.rect;
  const length = anchor.end - anchor.start;
  if (w <= 0 || length <= 0) return { start: anchor.start, end: anchor.end };
  const from = Math.min(length - 1, Math.max(0, Math.floor(((extent.left - x) / w) * length)));
  const to = Math.min(length, Math.max(from + 1, Math.ceil(((extent.right - x) / w) * length)));
  return { start: anchor.start + from, end: anchor.start + to };
}

/** A text-quote locator for [start, end) of `plain`, with the prefix / suffix and occurrence the reader's own captures carry. */
function quoteAt(plain: string, start: number, end: number): TextQuote | undefined {
  let from = start;
  let to = end;
  while (from < to && /\s/.test(plain[from] ?? "")) from += 1;
  while (to > from && /\s/.test(plain[to - 1] ?? "")) to -= 1;
  const quote = plain.slice(from, to).replace(/\s+/g, " ").trim();
  if (!quote) return undefined;
  const before = stripSpace(plain.slice(0, from));
  const after = stripSpace(plain.slice(to));
  const occurrence = allIndexesOf(before, stripSpace(quote)).length;
  return { locator: encodeTextQuoteV2Locator({ occurrence, position: before.length, prefix: before.slice(-CONTEXT_CHARS), suffix: after.slice(0, CONTEXT_CHARS) }), quote };
}

/**
 * The quote of the text view under a pdf-regions locator: the anchors on that page whose line the regions
 * cover by at least half its height, narrowed to the characters under the regions, joined into one span of
 * `plain`. Undefined when the locator is not a regions locator or no line is covered.
 */
export function textQuoteForRegions(content: TextViewSource, locator: string): TextQuote | undefined {
  const regions = parsePdfRegionsLocator(locator);
  const anchors = content.anchors ?? [];
  if (regions.length === 0 || !content.plain || anchors.length === 0) return undefined;
  const page = regions[0]!.page;
  const spans = anchors.filter((anchor) => anchor.page === page).flatMap((anchor) => {
    const extent = coveredExtent(anchor, regions);
    return extent ? [charactersUnder(anchor, extent)] : [];
  });
  if (spans.length === 0) return undefined;
  const start = Math.min(...spans.map((span) => span.start));
  const end = Math.max(...spans.map((span) => span.end));
  return quoteAt(content.plain, start, end);
}
