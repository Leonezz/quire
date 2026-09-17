export type PdfSearchResult = Readonly<{
  occurrence: number;
  page: number;
}>;

/** The slice of a PDF.js document proxy that full-text search relies on. */
export type PdfSearchableDocument = Readonly<{
  getPage: (pageNumber: number) => Promise<
    Readonly<{
      getTextContent: () => Promise<Readonly<{ items: readonly object[] }>>;
    }>
  >;
  numPages: number;
}>;

export type PdfSearchOutcome = Readonly<{
  hasText: boolean;
  results: readonly PdfSearchResult[];
}>;

function pageText(items: readonly object[]) {
  return items
    .map((item) =>
      "str" in item && typeof item.str === "string" ? item.str : "",
    )
    .join(" ");
}

function occurrencesOf(haystack: string, needle: string) {
  const occurrences: number[] = [];
  let start = haystack.indexOf(needle);
  while (start >= 0) {
    occurrences.push(start);
    start = haystack.indexOf(needle, start + Math.max(1, needle.length));
  }
  return occurrences;
}

/**
 * Scans every page for a case-insensitive query. Page text is memoized in
 * `cache` so repeated searches never re-extract text. Returns `undefined` as
 * soon as `isCancelled()` reports the request is stale.
 */
export async function searchPdfText(
  pdf: PdfSearchableDocument,
  query: string,
  cache: Map<number, string>,
  isCancelled: () => boolean,
): Promise<PdfSearchOutcome | undefined> {
  const normalizedQuery = query.toLocaleLowerCase();
  const results: PdfSearchResult[] = [];
  let hasText = false;
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    if (isCancelled()) return undefined;
    let text = cache.get(pageNumber);
    if (text === undefined) {
      const pdfPage = await pdf.getPage(pageNumber);
      if (isCancelled()) return undefined;
      const textContent = await pdfPage.getTextContent();
      if (isCancelled()) return undefined;
      text = pageText(textContent.items);
      cache.set(pageNumber, text);
    }
    hasText ||= Boolean(text.trim());
    const occurrences = occurrencesOf(
      text.toLocaleLowerCase(),
      normalizedQuery,
    );
    for (const [occurrence] of occurrences.entries())
      results.push({ occurrence, page: pageNumber });
  }
  if (isCancelled()) return undefined;
  return { hasText, results };
}

/**
 * Locates the n-th occurrence of `query` inside a rendered text layer and
 * returns a DOM range spanning it, so the match can be measured on screen.
 */
export function textRangeForOccurrence(
  root: HTMLElement,
  query: string,
  occurrence: number,
) {
  const walker = root.ownerDocument.createTreeWalker(root, 4);
  const segments: Array<{ end: number; node: Text; start: number }> = [];
  let text = "";
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!(node instanceof Text) || !node.data) continue;
    if (text) text += " ";
    const start = text.length;
    text += node.data;
    segments.push({ end: text.length, node, start });
  }
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return undefined;
  const haystack = text.toLocaleLowerCase();
  let matchStart = -1;
  let cursor = 0;
  for (let index = 0; index <= occurrence; index += 1) {
    matchStart = haystack.indexOf(needle, cursor);
    if (matchStart < 0) return undefined;
    cursor = matchStart + Math.max(1, needle.length);
  }
  const matchEnd = matchStart + needle.length;
  const first = segments.find((segment) => segment.end > matchStart);
  const last = [...segments].reverse().find((segment) => segment.start < matchEnd);
  if (!first || !last) return undefined;
  const range = root.ownerDocument.createRange();
  range.setStart(first.node, Math.max(0, matchStart - first.start));
  range.setEnd(last.node, Math.min(last.node.length, matchEnd - last.start));
  return range;
}
