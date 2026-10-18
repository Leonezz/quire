import { parseHTML } from "linkedom";

const MAX_MATH_SPAN_CHARACTERS = 16 * 1024;
export const FALLBACK_DROP_SELECTOR =
  "script,style,noscript,template,iframe,object,embed,svg,canvas";

/** richUnits order: pre, figure, picture, image, table, math, noteref, endnotes, link, citation, heading, list, details. */
export type ContentStats = Readonly<{
  richUnits: readonly number[];
  textCharacters: number;
}>;

function countBoundedDelimitedMath(
  value: string,
  opening: string,
  closing: string,
) {
  // `$$` uses the same token to open and close a unit. Keeping a single
  // cursor for the other delimiters is important: searching a 16 KiB window
  // again for every opener makes a page with many unmatched tokens quadratic.
  let count = 0;
  let openerIndex = -1;
  let cursor = 0;
  while (cursor < value.length) {
    const hasOpening = value.startsWith(opening, cursor);
    const hasClosing = value.startsWith(closing, cursor);
    const isOpening =
      hasOpening && (cursor === 0 || value[cursor - 1] !== "\\");
    const isClosing =
      hasClosing && (cursor === 0 || value[cursor - 1] !== "\\");

    if ((hasOpening && !isOpening) || (hasClosing && !isClosing)) {
      cursor += Math.max(
        hasOpening ? opening.length : 0,
        hasClosing ? closing.length : 0,
        1,
      );
      continue;
    }

    if (opening === closing && isOpening) {
      if (openerIndex < 0) {
        openerIndex = cursor;
      } else {
        const maxClosingIndex =
          openerIndex + opening.length + MAX_MATH_SPAN_CHARACTERS;
        if (cursor <= maxClosingIndex) count += 1;
        openerIndex = -1;
      }
      cursor += opening.length;
      continue;
    }

    if (openerIndex >= 0) {
      const maxClosingIndex =
        openerIndex + opening.length + MAX_MATH_SPAN_CHARACTERS;
      if (cursor > maxClosingIndex) openerIndex = -1;
    }
    if (isOpening) {
      if (openerIndex < 0) openerIndex = cursor;
      cursor += opening.length;
      continue;
    }
    if (isClosing) {
      if (openerIndex >= 0) count += 1;
      openerIndex = -1;
      cursor += closing.length;
      continue;
    }
    cursor += 1;
  }
  return count;
}

function countBoundedDisplayMathEnvironments(value: string) {
  type PendingEnvironment = { limit: number };
  type PendingEnvironmentQueue = {
    entries: PendingEnvironment[];
    head: number;
  };

  let count = 0;
  const pending = new Map<string, PendingEnvironmentQueue>();
  const tokens =
    /\\(begin|end)\{(equation|align|gather|multline|flalign|alignat)(\*)?\}/gu;
  for (const match of value.matchAll(tokens)) {
    const index = match.index ?? -1;
    if (index < 0 || (index > 0 && value[index - 1] === "\\")) continue;
    const environment = `${match[2]}${match[3] ?? ""}`;
    const queue =
      pending.get(environment) ??
      ({ entries: [], head: 0 } satisfies PendingEnvironmentQueue);
    const { entries } = queue;
    while (queue.head < entries.length && entries[queue.head]!.limit < index) {
      queue.head += 1;
    }

    if (match[1] === "begin") {
      if (queue.head === entries.length) {
        queue.entries = [];
        queue.head = 0;
      }
      queue.entries.push({
        limit: index + match[0].length + MAX_MATH_SPAN_CHARACTERS,
      });
      pending.set(environment, queue);
      continue;
    }

    count += entries.length - queue.head;
    pending.delete(environment);
  }
  return count;
}

function countBoundedMath(value: string) {
  return (
    countBoundedDelimitedMath(value, "\\(", "\\)") +
    countBoundedDelimitedMath(value, "\\[", "\\]") +
    countBoundedDelimitedMath(value, "$$", "$$") +
    countBoundedDisplayMathEnvironments(value)
  );
}

function contentStats(html: string): ContentStats {
  // A parse of its own, so what a reader never sees is removed from it in place.
  const document = parseHTML(`<html><body>${html}</body></html>`)
    .document as unknown as Document;
  document
    .querySelectorAll(FALLBACK_DROP_SELECTOR)
    .forEach((element) => element.remove());
  const text =
    document.body?.textContent ?? document.documentElement?.textContent ?? "";
  const mathUnits = countBoundedMath(text);
  const standaloneImages = Array.from(document.querySelectorAll("img")).filter(
    (image) => image.closest("picture") === null,
  ).length;
  const richUnits = [
    document.querySelectorAll("pre").length,
    document.querySelectorAll("figure").length,
    document.querySelectorAll("picture").length,
    standaloneImages,
    document.querySelectorAll("table").length,
    Math.max(
      document.querySelectorAll("math, .math, .katex").length,
      mathUnits,
    ),
    document.querySelectorAll(
      "[role='doc-noteref'], a.footnote-ref, sup[id^='fnref'] > a[href^='#fn']",
    ).length,
    document.querySelectorAll("[role='doc-endnotes'], .footnotes, #footnotes")
      .length,
    document.querySelectorAll("a[href]").length,
    document.querySelectorAll(
      "cite, [role='doc-bibliography'], [role='doc-biblioentry'], .bibliography, .references, #bibliography, #references",
    ).length,
    document.querySelectorAll("h1, h2, h3, h4, h5, h6").length,
    document.querySelectorAll("ul, ol, dl").length,
    document.querySelectorAll("details").length,
  ];
  return {
    richUnits,
    textCharacters: text.replace(/\s+/gu, " ").trim().length,
  };
}

/**
 * Content statistics for one normalization, each HTML string parsed once. The quality gates, the candidate
 * ranking and the final length check measure the same two or three extractions up to eleven times, and every
 * measurement is a full parse of the extraction.
 */
export function memoizedContentStats(): (html: string) => ContentStats {
  const measured = new Map<string, ContentStats>();
  return (html) => {
    const known = measured.get(html);
    if (known) return known;
    const stats = contentStats(html);
    measured.set(html, stats);
    return stats;
  };
}
