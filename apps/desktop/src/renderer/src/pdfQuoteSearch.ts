import { GlobalWorkerOptions, getDocument } from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { flashQuoteRange } from "./quoteJump";

// A citation's quote in a PDF: the pages' text is scanned for it (the same page text pdf.js gives
// the viewer's own search), the viewer goes to that page, and once its text layer is on screen the
// match is marked for a moment. The viewer handle exposes navigation only, so the scan runs here on
// a second handle to the same bytes, closed as soon as the page is known.

export interface PdfQuoteHit { page: number; occurrence: number }

/** How long the text layer of the target page is waited for before the jump settles for the page alone. */
const LAYER_WAIT_MS = 4000;
const LAYER_POLL_MS = 80;

if (typeof window !== "undefined" && !GlobalWorkerOptions.workerSrc) GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

type TextItem = { str?: unknown };
const pageText = (items: readonly TextItem[]) => items.map((item) => (typeof item.str === "string" ? item.str : "")).join(" ");
const normalize = (text: string) => text.replace(/\s+/g, " ").trim().toLocaleLowerCase();

/** The first page whose text holds the quote (case and whitespace aside), and which occurrence on that page. */
export async function findPdfQuote(url: string, quote: string, isCancelled: () => boolean = () => false): Promise<PdfQuoteHit | undefined> {
  const needle = normalize(quote);
  if (!needle) return undefined;
  const task = getDocument({ url });
  const pdf = await task.promise;
  try {
    for (let page = 1; page <= pdf.numPages; page += 1) {
      if (isCancelled()) return undefined;
      const content = await (await pdf.getPage(page)).getTextContent();
      const haystack = normalize(pageText(content.items as readonly TextItem[]));
      const at = haystack.indexOf(needle);
      if (at >= 0) return { page, occurrence: 0 };
    }
    return undefined;
  } finally { await task.destroy(); }
}

/**
 * The range of the n-th occurrence of `quote` in a rendered text layer (whitespace folded, case ignored),
 * so it can be marked on screen; undefined when the layer does not hold it.
 */
export function textLayerQuoteRange(layer: HTMLElement, quote: string, occurrence = 0): Range | undefined {
  const needle = normalize(quote);
  if (!needle) return undefined;
  // The layer's text folded like the quote (one space between runs, lower case), each character mapped to its text node.
  const walker = layer.ownerDocument.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
  const positions: { node: Text; offset: number }[] = [];
  let text = "";
  const push = (node: Text, offset: number, character: string) => { text += character; positions.push({ node, offset }); };
  let boundary = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!(node instanceof Text) || !node.data) continue;
    for (let offset = 0; offset < node.data.length; offset += 1) {
      const character = node.data[offset] ?? "";
      if (/\s/.test(character)) { if (text && !text.endsWith(" ")) push(node, offset, " "); continue; }
      // Text layer spans are separate words or lines: a space stands between them, as in the page text.
      if (boundary && text && !text.endsWith(" ")) push(node, offset, " ");
      boundary = false;
      push(node, offset, character.toLocaleLowerCase());
    }
    boundary = true;
  }
  let start = -1;
  let cursor = 0;
  for (let index = 0; index <= occurrence; index += 1) {
    start = text.indexOf(needle, cursor);
    if (start < 0) return undefined;
    cursor = start + Math.max(1, needle.length);
  }
  const first = positions[start];
  const last = positions[start + needle.length - 1];
  if (!first || !last) return undefined;
  const range = layer.ownerDocument.createRange();
  range.setStart(first.node, first.offset);
  range.setEnd(last.node, last.offset + 1);
  return range;
}

/** The rendered text layer of a page, once the viewer has laid it out (polled for a while), else undefined. */
async function waitForTextLayer(pageRoot: () => HTMLElement | null, page: number, isCancelled: () => boolean): Promise<HTMLElement | undefined> {
  const deadline = Date.now() + LAYER_WAIT_MS;
  while (Date.now() < deadline) {
    if (isCancelled()) return undefined;
    const layer = pageRoot()?.querySelector<HTMLElement>(`[data-pdf-page-number="${page}"] .react-pdf__Page__textContent`);
    if (layer?.textContent) return layer;
    await new Promise((resolve) => { window.setTimeout(resolve, LAYER_POLL_MS); });
  }
  return undefined;
}

export interface RevealPdfQuoteOptions {
  url: string;
  quote: string;
  /** The element that holds the rendered pages. */
  pageRoot: () => HTMLElement | null;
  goToPage: (page: number) => void;
  isCancelled?: (() => boolean) | undefined;
}

/**
 * Finds the quote, goes to its page and marks the match for a moment. Resolves with whether the quote
 * was found in the document (a page without a rendered text layer still counts: the page was reached).
 */
export async function revealPdfQuote({ url, quote, pageRoot, goToPage, isCancelled = () => false }: RevealPdfQuoteOptions): Promise<boolean> {
  const hit = await findPdfQuote(url, quote, isCancelled);
  if (!hit || isCancelled()) return hit !== undefined;
  goToPage(hit.page);
  const layer = await waitForTextLayer(pageRoot, hit.page, isCancelled);
  if (!layer || isCancelled()) return true;
  const range = textLayerQuoteRange(layer, quote, hit.occurrence);
  if (range) flashQuoteRange(layer, range);
  return true;
}
