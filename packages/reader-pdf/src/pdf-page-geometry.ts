import { parsePdfRegionLocator, type PdfRegion } from "./pdf-region-locator";

export type PdfSelectionRect = Readonly<{
  height: number;
  width: number;
  x: number;
  y: number;
}>;

export type PdfSelection =
  | Readonly<{
      height: number;
      kind: "selection";
      pageNumber: number;
      rects: readonly PdfSelectionRect[];
      text: string;
      width: number;
      x: number;
      y: number;
    }>
  | Readonly<{
      kind: "blocked";
      reason: string;
    }>;

/** The most rectangles one `pdf-regions:v1:` locator carries. */
export const MAX_PDF_LOCATOR_RECTS = 128;
const PDF_LOCATOR_DECIMALS = 4;

export function clampUnit(value: number) {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}

function locatorCoordinates(rect: PdfSelectionRect) {
  return [rect.x, rect.y, rect.width, rect.height].map((value) =>
    clampUnit(value).toFixed(PDF_LOCATOR_DECIMALS),
  );
}

/**
 * Encodes a one-page selection (as returned by `readSelection()`) as the
 * `pdf-regions:v1:<page>:<x,y,w,h>[;…]` locator `parsePdfRegionsLocator`
 * reads. Rectangles are in canonical page space, rounded to 4 decimals; a
 * rectangle that collapses to nothing at that precision is dropped, and a
 * selection with more rectangles than a locator carries falls back to its
 * enclosing bounds. Returns `undefined` for a blocked or empty selection.
 */
export function pdfRegionLocatorForSelection(
  selection: PdfSelection,
): string | undefined {
  if (selection.kind !== "selection") return undefined;
  const sourceRects: readonly PdfSelectionRect[] =
    selection.rects.length && selection.rects.length <= MAX_PDF_LOCATOR_RECTS
      ? selection.rects
      : [selection];
  const coordinates = sourceRects
    .map(locatorCoordinates)
    .filter(([, , width, height]) => Number(width) > 0 && Number(height) > 0)
    .map((values) => values.join(","));
  if (!coordinates.length) return undefined;
  return `pdf-regions:v1:${selection.pageNumber}:${coordinates.join(";")}`;
}

/** The selected text with whitespace collapsed; `undefined` when blocked or empty. */
export function pdfSelectionText(selection: PdfSelection): string | undefined {
  if (selection.kind !== "selection") return undefined;
  const text = selection.text.replace(/\s+/g, " ").trim();
  return text || undefined;
}

export function normalizedRotation(value: number) {
  const normalized = ((Number(value) % 360) + 360) % 360;
  return normalized === 90 || normalized === 180 || normalized === 270
    ? normalized
    : 0;
}

function boundedRect(rect: PdfSelectionRect): PdfSelectionRect {
  const x = clampUnit(rect.x);
  const y = clampUnit(rect.y);
  return {
    height: Number(Math.min(clampUnit(rect.height), 1 - y).toFixed(6)),
    width: Number(Math.min(clampUnit(rect.width), 1 - x).toFixed(6)),
    x: Number(x.toFixed(6)),
    y: Number(y.toFixed(6)),
  };
}

/**
 * Locators are always stored in the unrotated PDF page coordinate space. The
 * reader can therefore rotate freely without moving a region away from the
 * content it points at.
 */
export function canonicalPdfRect(
  rect: PdfSelectionRect,
  rotation: number,
): PdfSelectionRect {
  const bounded = boundedRect(rect);
  switch (((rotation % 360) + 360) % 360) {
    case 90:
      return boundedRect({
        height: bounded.width,
        width: bounded.height,
        x: bounded.y,
        y: 1 - bounded.x - bounded.width,
      });
    case 180:
      return boundedRect({
        ...bounded,
        x: 1 - bounded.x - bounded.width,
        y: 1 - bounded.y - bounded.height,
      });
    case 270:
      return boundedRect({
        height: bounded.width,
        width: bounded.height,
        x: 1 - bounded.y - bounded.height,
        y: bounded.x,
      });
    default:
      return bounded;
  }
}

export function displayedPdfRect(
  rect: PdfSelectionRect,
  rotation: number,
): PdfSelectionRect {
  const bounded = boundedRect(rect);
  switch (((rotation % 360) + 360) % 360) {
    case 90:
      return boundedRect({
        height: bounded.width,
        width: bounded.height,
        x: 1 - bounded.y - bounded.height,
        y: bounded.x,
      });
    case 180:
      return boundedRect({
        ...bounded,
        x: 1 - bounded.x - bounded.width,
        y: 1 - bounded.y - bounded.height,
      });
    case 270:
      return boundedRect({
        height: bounded.width,
        width: bounded.height,
        x: bounded.y,
        y: 1 - bounded.x - bounded.width,
      });
    default:
      return bounded;
  }
}

export function enclosingRect(rects: readonly PdfSelectionRect[]) {
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  return boundedRect({
    height: bottom - top,
    width: right - left,
    x: left,
    y: top,
  });
}

export function pageFromPdfLocator(locator: string) {
  const match = /^pdf-(?:page|region|regions):v1:(\d+)(?::|$)/.exec(locator);
  if (!match) return undefined;
  const page = Number(match[1]);
  return Number.isSafeInteger(page) && page > 0 ? page : undefined;
}

export function parsePdfRegionsLocator(locator: string): readonly PdfRegion[] {
  const single = parsePdfRegionLocator(locator);
  if (single) return [single];
  const match = /^pdf-regions:v1:(\d+):(.+)$/.exec(locator);
  if (!match) return [];
  const page = Number(match[1]);
  if (!Number.isSafeInteger(page) || page < 1) return [];
  const rects = match[2]!.split(";").map((value) => value.split(",").map(Number));
  if (!rects.length || rects.length > MAX_PDF_LOCATOR_RECTS) return [];
  const regions = rects.flatMap(([x, y, width, height]) => {
    if (
      ![x, y, width, height].every(Number.isFinite) ||
      width! <= 0 ||
      height! <= 0
    )
      return [];
    const boundedX = clampUnit(x!);
    const boundedY = clampUnit(y!);
    const boundedWidth = Math.min(clampUnit(width!), 1 - boundedX);
    const boundedHeight = Math.min(clampUnit(height!), 1 - boundedY);
    if (boundedWidth <= 0 || boundedHeight <= 0) return [];
    return [{
      height: boundedHeight,
      page,
      width: boundedWidth,
      x: boundedX,
      y: boundedY,
    }];
  });
  return regions.length === rects.length ? regions : [];
}

function nodeElement(node: Node | null) {
  if (!node) return undefined;
  if (node.nodeType === Node.ELEMENT_NODE) return node as Element;
  return node.parentElement ?? undefined;
}

export function pageElementForNode(node: Node | null) {
  return nodeElement(node)?.closest<HTMLElement>("[data-pdf-page-number]");
}

export function normalizedRectsForRange(
  range: Range,
  pageElement: HTMLElement,
): readonly PdfSelectionRect[] {
  const pageRect = pageElement.getBoundingClientRect();
  const pageWidth = pageRect.width || pageElement.clientWidth;
  const pageHeight = pageRect.height || pageElement.clientHeight;
  if (!pageWidth || !pageHeight) return [];
  const clientRects = typeof range.getClientRects === "function"
    ? Array.from(range.getClientRects())
    : [];
  const boundingRect = typeof range.getBoundingClientRect === "function"
    ? range.getBoundingClientRect()
    : undefined;
  const sourceRects = clientRects.length
    ? clientRects
    : boundingRect
      ? [boundingRect]
      : [];
  const seen = new Set<string>();
  return sourceRects.flatMap((rect) => {
    if (!rect.width || !rect.height) return [];
    const x = clampUnit((rect.left - pageRect.left) / pageWidth);
    const y = clampUnit((rect.top - pageRect.top) / pageHeight);
    const right = clampUnit((rect.right - pageRect.left) / pageWidth);
    const bottom = clampUnit((rect.bottom - pageRect.top) / pageHeight);
    const normalized = {
      height: Number((bottom - y).toFixed(6)),
      width: Number((right - x).toFixed(6)),
      x: Number(x.toFixed(6)),
      y: Number(y.toFixed(6)),
    };
    if (normalized.width <= 0 || normalized.height <= 0) return [];
    const key = `${normalized.x}:${normalized.y}:${normalized.width}:${normalized.height}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [normalized];
  });
}

export const CROSS_PAGE_SELECTION_REASON =
  "Select text from one page at a time to create an excerpt.";

export function normalizedSelection(
  selection: Selection,
  pageElement: HTMLElement,
  rotation: number,
): PdfSelection | undefined {
  if (!selection.rangeCount) return undefined;
  const range = selection.getRangeAt(0);
  const selectedText = (selection.toString() || range.toString()).trim();
  if (!selectedText) return undefined;

  const startPage = pageElementForNode(range.startContainer);
  const endPage = pageElementForNode(range.endContainer);
  if (!startPage || !endPage) return undefined;
  if (startPage !== endPage) {
    return { kind: "blocked", reason: CROSS_PAGE_SELECTION_REASON };
  }

  const pageRect = pageElement.getBoundingClientRect();
  const rangeRect = range.getBoundingClientRect();
  const pageWidth = pageRect.width || pageElement.clientWidth;
  const pageHeight = pageRect.height || pageElement.clientHeight;
  if (!pageWidth || !pageHeight || !rangeRect.width || !rangeRect.height) {
    return {
      kind: "blocked",
      reason:
        "The selected text bounds are not available yet. Try again after the page finishes rendering.",
    };
  }

  const displayX = clampUnit((rangeRect.left - pageRect.left) / pageWidth);
  const displayY = clampUnit((rangeRect.top - pageRect.top) / pageHeight);
  const right = Math.min(
    1,
    Math.max(displayX, (rangeRect.right - pageRect.left) / pageWidth),
  );
  const bottom = Math.min(
    1,
    Math.max(displayY, (rangeRect.bottom - pageRect.top) / pageHeight),
  );
  const pageNumber = Number(startPage.dataset.pdfPageNumber);
  if (!Number.isSafeInteger(pageNumber) || pageNumber < 1) return undefined;

  const displayRects = normalizedRectsForRange(range, pageElement);
  const displayBounds = {
    height: Number((bottom - displayY).toFixed(6)),
    width: Number((right - displayX).toFixed(6)),
    x: Number(displayX.toFixed(6)),
    y: Number(displayY.toFixed(6)),
  };
  const rects = (displayRects.length ? displayRects : [displayBounds]).map(
    (rect) => canonicalPdfRect(rect, rotation),
  );
  const bounds = enclosingRect(rects);
  return {
    height: Number(bounds.height.toFixed(6)),
    kind: "selection",
    pageNumber,
    rects,
    text: selectedText,
    width: Number(bounds.width.toFixed(6)),
    x: Number(bounds.x.toFixed(6)),
    y: Number(bounds.y.toFixed(6)),
  };
}

export function scrollPageToOffset(
  root: HTMLElement,
  pageElement: HTMLElement,
  pageOffset: number,
  behavior: ScrollBehavior,
  regionY?: number,
) {
  const rootRect = root.getBoundingClientRect();
  const pageRect = pageElement.getBoundingClientRect();
  const normalizedOffset = clampUnit(regionY ?? pageOffset);
  const viewportLead = regionY === undefined ? 24 : root.clientHeight * 0.28;
  const targetTop = Math.max(
    0,
    root.scrollTop +
      pageRect.top -
      rootRect.top +
      normalizedOffset * pageRect.height -
      viewportLead,
  );

  if (typeof root.scrollTo === "function") {
    root.scrollTo({ behavior, top: targetTop });
    return;
  }

  pageElement.scrollIntoView?.({ behavior, block: "start" });
}
