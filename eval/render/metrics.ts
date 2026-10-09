// RenderMetrics from the raw page facts: what is broken, overflowing or left unrendered, measured by
// program so the judge can treat it as fact. Pure: the browser side (./page-facts) only collects.
import type { RenderedCode, RenderedTable, RenderMetrics } from "./types";
import type { HeadingFact, OverflowCandidate, PageFacts } from "./page-facts";

const SAMPLE_CHARS = 120;
const MAX_SAMPLES = 20;

/** Markup that should have become formatting but shows as text. `$$…$$` counts once. */
export const RAW_MARKUP_PATTERNS: readonly { pattern: string; regex: RegExp }[] = [
  { pattern: "\\<", regex: /\\</g },
  { pattern: "](http", regex: /\]\(https?:/g },
  { pattern: "$$", regex: /\$\$[^$]{0,2000}?\$\$|\$\$/g },
  { pattern: "\\frac", regex: /\\frac(?![A-Za-z])/g },
  { pattern: "\\begin{", regex: /\\begin\{/g },
  { pattern: "<table", regex: /<table\b/gi },
  { pattern: "&lt;", regex: /&lt;/g },
  { pattern: "&amp;", regex: /&amp;/g },
];

/** A visible-text window starting a little before a match, at most SAMPLE_CHARS long. */
export function sampleAround(text: string, start: number): string {
  const from = Math.max(0, start - 40);
  const prefix = from > 0 ? "…" : "";
  return prefix + text.slice(from, from + SAMPLE_CHARS - prefix.length);
}

export function scanRawMarkup(prose: readonly string[]): RenderMetrics["rawMarkup"] {
  let count = 0;
  const samples: RenderMetrics["rawMarkup"]["samples"] = [];
  for (const text of prose) {
    for (const { pattern, regex } of RAW_MARKUP_PATTERNS) {
      for (const match of text.matchAll(new RegExp(regex.source, regex.flags))) {
        count += 1;
        if (samples.length < MAX_SAMPLES) samples.push({ pattern, text: sampleAround(text, match.index) });
      }
    }
  }
  return { count, samples };
}

const DISPLAY_DOLLARS = /\$\$[^$]{1,2000}?\$\$/g;
// One `$…$` run: not escaped or part of a word/`$$`, no space just inside the dollars ("$5 and $10" is money).
const INLINE_DOLLARS = /(?<![\\$\w])\$(?=\S)([^$\n]{1,200}?)(?<=\S)\$(?![\w$])/g;
const TEX_SIGNAL = /\\[A-Za-z]+|[\^_{}=]|^[A-Za-z]$/;

/** `$…$` and `$$…$$` runs left as text that look like TeX (a command, ^, _, braces, = or one letter). */
export function countDollarMath(prose: readonly string[]): number {
  let count = 0;
  for (const text of prose) {
    const display = text.match(DISPLAY_DOLLARS) ?? [];
    count += display.length;
    const rest = text.replace(DISPLAY_DOLLARS, " ");
    for (const match of rest.matchAll(INLINE_DOLLARS)) if (TEX_SIGNAL.test(match[1] ?? "")) count += 1;
  }
  return count;
}

/** Math that failed: reader math left as source or holding an error node, stray error nodes, and `$…$` text. */
export function countMathErrors(facts: Pick<PageFacts, "math" | "strayMathErrors" | "prose">): number {
  const failed = facts.math.filter((m) => m.error || m.status === "source").length;
  return failed + facts.strayMathErrors + countDollarMath(facts.prose);
}

const SCROLLS = new Set(["auto", "scroll"]);

/**
 * Outermost elements wider than the column. Excluded: boxes inside a scrolling/clipping ancestor (that
 * ancestor decides) and scroll containers that fit the column (an intended scrollbar, e.g. pre, tables,
 * display math). A hidden/clip container whose content is cut off with no scrollbar is reported as
 * `<path> [clipped]` with its content width.
 */
export function classifyOverflow(candidates: readonly OverflowCandidate[]): RenderMetrics["overflow"] {
  const reported = new Set<number>();
  const samples: RenderMetrics["overflow"]["samples"] = [];
  const ancestorReported = (index: number) => {
    for (let at = candidates[index]?.parent ?? -1; at >= 0; at = candidates[at]?.parent ?? -1) if (reported.has(at)) return true;
    return false;
  };
  candidates.forEach((candidate, index) => {
    if (candidate.insideClipper || ancestorReported(index)) return;
    const scrolls = SCROLLS.has(candidate.overflowX);
    const clips = !scrolls && candidate.overflowX !== "visible";
    if (candidate.exceeds) {
      reported.add(index);
      samples.push({ path: candidate.path, width: candidate.width });
    } else if (clips && candidate.scrollWidth > candidate.clientWidth + 2) {
      reported.add(index);
      samples.push({ path: `${candidate.path} [clipped]`, width: candidate.scrollWidth });
    }
  });
  return { count: samples.length, samples: samples.slice(0, MAX_SAMPLES) };
}

/** Words for Latin scripts, characters for CJK (as eval/src/summarize counts them). */
export function wordCount(text: string): number {
  const cjk = (text.match(/[㐀-鿿豈-﫿]/g) ?? []).length;
  const latin = text.replace(/[㐀-鿿豈-﫿]/g, " ").split(/\s+/).filter(Boolean).length;
  return cjk + latin;
}

const normalizeHeading = (text: string) => text.toLowerCase().replace(/\s+/g, " ").replace(/[\s.:;,!?–—-]+$/u, "").trim();

/** Headings with no text (and no image), body headings that repeat the title, and the body heading count. */
export function headingChecks(headings: readonly HeadingFact[], title: string): { empty: number; duplicateTitle: number; body: number } {
  const hasBody = headings.some((h) => h.inBody);
  // The reader's own "Notes" heading over the footnotes is not part of the document.
  const body = (hasBody ? headings.filter((h) => h.inBody) : headings).filter((h) => !h.generated);
  const wanted = normalizeHeading(title);
  const matches = wanted ? body.filter((h) => normalizeHeading(h.text) === wanted).length : 0;
  return {
    empty: headings.filter((h) => !h.text && !h.hasMedia).length,
    // Without a body wrapper the title heading itself is among the matches.
    duplicateTitle: hasBody ? matches : Math.max(0, matches - 1),
    body: body.length,
  };
}

const usableSrc = (src: string) => Boolean(src) && !src.startsWith("blob:") && !src.startsWith("data:");

/**
 * The sources of broken images. In the harness a remote image is a blob: URL once fetched and a
 * placeholder without src when not, so the sources come from the proxy's failed fetches first, then
 * from broken <img> elements with a real src; any still unnamed are listed by their alt text.
 */
export function brokenImageSources(images: readonly Pick<PageFacts["images"][number], "src" | "broken" | "label">[], failedSources: readonly string[]): string[] {
  const broken = images.filter((image) => image.broken);
  const named = [...new Set([...failedSources, ...broken.map((image) => image.src).filter(usableSrc)])];
  const unnamed = broken.filter((image) => !usableSrc(image.src)).slice(0, Math.max(0, broken.length - named.length));
  return [...named, ...unnamed.map((image) => `(no src${image.label ? `: ${image.label.slice(0, 80)}` : ""})`)];
}

/** Visible lists whose items draw no marker. */
export function countUnmarkedLists(lists: PageFacts["lists"]): number {
  return lists.filter((list) => list.items > 0 && !list.marked).length;
}

/** Tables with at least 4 body cells of which a quarter or more are empty; at most 5 samples. */
export function emptyCellTables(tables: readonly Pick<PageFacts["tables"][number], "empty" | "cells">[]): RenderMetrics["emptyCellTables"] {
  const flagged = tables.flatMap((table, index) => (table.cells >= 4 && table.empty / table.cells >= 0.25 ? [{ table: index + 1, empty: table.empty, cells: table.cells }] : []));
  return { count: flagged.length, samples: flagged.slice(0, 5) };
}

const HEAD_CHARS = 80;
/** A code block shown as one line this long is almost always several lines run together. */
export const COLLAPSED_CODE_CHARS = 100;

/** Lines of a block's visible text; trailing empty lines (the newline that ends the last line) do not count. */
export function codeLines(text: string): number {
  const lines = text.split("\n");
  while (lines.length > 0 && lines.at(-1)?.trim() === "") lines.pop();
  return lines.length;
}

export function isCollapsedCode(text: string): boolean {
  return codeLines(text) === 1 && text.length >= COLLAPSED_CODE_CHARS;
}

export function countCollapsedCode(code: readonly { text: string }[]): number {
  return code.filter((block) => isCollapsedCode(block.text)).length;
}

/** The first 80 characters, verbatim (a table's head is whitespace-flattened before it gets here). */
export const headOf = (text: string) => text.slice(0, HEAD_CHARS);

/** The tables' inventory; cells and emptyCells are the facts emptyCellTables reads, so its `table` n is t<n>. */
export function buildRenderedTables(tables: readonly (Omit<PageFacts["tables"][number], "top"> & { tile: number | null })[]): RenderedTable[] {
  return tables.map((table, index) => ({ id: `t${index + 1}`, tile: table.tile, rows: table.rows, cols: table.cols, cells: table.cells, emptyCells: table.empty, head: headOf(table.head) }));
}

export function buildRenderedCode(code: readonly { text: string; tile: number | null }[]): RenderedCode[] {
  return code.map((block, index) => ({ id: `c${index + 1}`, tile: block.tile, lines: codeLines(block.text), chars: block.text.length, collapsed: isCollapsedCode(block.text), head: headOf(block.text) }));
}

/** RenderMetrics for one page; failedImageSources are the image fetches the capture answered with an error. */
export function buildMetrics(facts: PageFacts, title: string, failedImageSources: readonly string[] = []): RenderMetrics {
  const broken = facts.images.filter((image) => image.broken);
  const headings = headingChecks(facts.headings, title);
  return {
    images: { total: facts.images.length, broken: broken.length, brokenSrc: brokenImageSources(facts.images, failedImageSources) },
    overflow: classifyOverflow(facts.overflow),
    rawMarkup: scanRawMarkup(facts.prose),
    mathErrors: countMathErrors(facts),
    collapsedCode: countCollapsedCode(facts.code),
    unmarkedLists: countUnmarkedLists(facts.lists),
    emptyCellTables: emptyCellTables(facts.tables),
    emptyHeadings: headings.empty,
    duplicateTitleHeadings: headings.duplicateTitle,
    counts: { ...facts.counts, headings: headings.body, words: wordCount(facts.text) },
    height: Math.round(facts.box.height),
  };
}
