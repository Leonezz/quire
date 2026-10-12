import type { RenderingFeedback, RenderingFeedbackDraft } from "../../shared/contracts";

// The pure half of the one-step report's screenshots (feedback-submit.ts drives them, main/feedback-capturer.ts
// takes them with Electron): which rectangle to shoot, how to tile the full article, how the original page is
// made to load its CSS and images from its own site, and how the side-by-side composite is laid out.

export interface Rect { x: number; y: number; width: number; height: number }
export interface Size { width: number; height: number }

/** Full-article tiles: the eval capture's tile height (eval/render/capture.mjs) and at most this many tiles. */
export const TILE_HEIGHT = 1600;
export const MAX_FULL_TILES = 8;
/** The full-article window's width when the reader's viewport is unknown; the original page always renders at this width (its desktop layout). */
export const DEFAULT_RENDER_WIDTH = 1280;
const MIN_RENDER_WIDTH = 320;
const MAX_RENDER_WIDTH = 4_000;
/** The selection screenshot shows this much of the page above and below the selected passage. */
export const SELECTION_PADDING = 120;
/** findInPage gets the first words of the quote: long needles stop matching across inline markup. */
export const MAX_FIND_TEXT = 80;
/** The composite stays small enough to paste into an issue comment. */
export const MAX_COMPOSITE_BYTES = 2 * 1024 * 1024;

export const SCREENSHOTS_DIR = "screenshots";
export const SHOT = {
  viewport: `${SCREENSHOTS_DIR}/reader-viewport.png`,
  selection: `${SCREENSHOTS_DIR}/reader-selection.png`,
  originalTop: `${SCREENSHOTS_DIR}/original-top.png`,
  originalAtSelection: `${SCREENSHOTS_DIR}/original-at-selection.png`,
  composite: `${SCREENSHOTS_DIR}/composite.png`,
} as const;

/** `screenshots/reader-full-01.jpg`: 1-based, two digits so they sort. */
export function fullTileName(index: number): string {
  return `${SCREENSHOTS_DIR}/reader-full-${String(index + 1).padStart(2, "0")}.jpg`;
}
export const FULL_TILE_PATTERN = /(^|\/)reader-full-\d+\.jpg$/;

/** A window-pixel rectangle as capturePage takes it: whole pixels, never negative, at least one pixel each way. */
export function roundRect(rect: Rect): Rect {
  const x = Math.max(0, Math.floor(rect.x));
  const y = Math.max(0, Math.floor(rect.y));
  return { x, y, width: Math.max(1, Math.ceil(rect.x + rect.width) - x), height: Math.max(1, Math.ceil(rect.y + rect.height) - y) };
}

/**
 * The selection screenshot's rectangle: the reading column (the viewport's width) from SELECTION_PADDING above
 * the passage to as far below it, clamped to the viewport. Without a viewport, the passage's own box padded the same way.
 */
export function selectionCaptureRect(selection: Rect, viewport: Rect | undefined, padding = SELECTION_PADDING): Rect {
  const top = selection.y - padding;
  const bottom = selection.y + selection.height + padding;
  if (!viewport) return roundRect({ x: selection.x, y: top, width: selection.width, height: bottom - top });
  const clampedTop = Math.min(Math.max(top, viewport.y), viewport.y + viewport.height - 1);
  const clampedBottom = Math.max(Math.min(bottom, viewport.y + viewport.height), clampedTop + 1);
  return roundRect({ x: viewport.x, y: clampedTop, width: viewport.width, height: clampedBottom - clampedTop });
}

/**
 * A rectangle in the page's CSS pixels as capturePage takes it: in window DIPs (CSS px × zoom factor), rounded
 * outwards and clipped to the window's content area. Undefined when nothing of it is inside the window.
 */
export function windowCaptureRect(rect: Rect, zoom: number, content: Size): Rect | undefined {
  if (!(zoom > 0)) throw new Error(`zoom factor must be positive, got ${zoom}`);
  const left = Math.max(0, Math.floor(rect.x * zoom));
  const top = Math.max(0, Math.floor(rect.y * zoom));
  const right = Math.min(Math.floor(content.width), Math.ceil((rect.x + rect.width) * zoom));
  const bottom = Math.min(Math.floor(content.height), Math.ceil((rect.y + rect.height) * zoom));
  return right > left && bottom > top ? { x: left, y: top, width: right - left, height: bottom - top } : undefined;
}

/** The full-article window's width: the reader's viewport width when known, within what the render harness accepts. */
export function renderWidthOf(viewport: RenderingFeedbackDraft["viewport"]): number {
  const width = viewport ? Math.round(viewport.width) : DEFAULT_RENDER_WIDTH;
  return Math.min(MAX_RENDER_WIDTH, Math.max(MIN_RENDER_WIDTH, width));
}

export interface Tile { index: number; y: number; height: number }
export interface TilePlan { tiles: Tile[]; truncated: boolean }

/** Cuts [top, top + height) into tiles of tileHeight (the last one shorter), at most maxTiles; truncated when cut off. Same rule as eval/render/tiles.ts. */
export function planTiles(top: number, height: number, tileHeight: number, maxTiles: number): TilePlan {
  if (!(tileHeight > 0)) throw new Error(`tile height must be positive, got ${tileHeight}`);
  const total = Math.max(0, Math.ceil(height));
  if (total === 0 || maxTiles <= 0) return { tiles: [], truncated: total > 0 };
  const needed = Math.ceil(total / tileHeight);
  const count = Math.min(needed, maxTiles);
  const start = Math.max(0, Math.floor(top));
  const tiles = Array.from({ length: count }, (_, index) => {
    const y = start + index * tileHeight;
    return { index, y, height: Math.min(tileHeight, start + total - y) };
  });
  return { tiles, truncated: needed > count };
}

/** What findInPage looks for: the quote's first words on one line, at most MAX_FIND_TEXT characters; undefined for a blank quote. */
export function findTextOf(quote: string): string | undefined {
  const single = quote.replace(/\s+/g, " ").trim();
  if (!single) return undefined;
  if (single.length <= MAX_FIND_TEXT) return single;
  const cut = single.slice(0, MAX_FIND_TEXT);
  // End on a word boundary when there is one in the second half, so the needle is not half a word.
  const space = cut.lastIndexOf(" ");
  return space > MAX_FIND_TEXT / 2 ? cut.slice(0, space) : cut;
}

// --- The original page: the snapshot with a <base> at its final URL (eval/render/reference.ts, same rule) ---

const HEAD_OPEN = /<head(?=[\s>/])[^>]*>/i;
const HTML_OPEN = /<html(?=[\s>])[^>]*>/i;
const DOCTYPE = /^\s*<!doctype[^>]*>/i;
const BASE_TAG = /<base\b[^>]*>/gi;
const HREF_ATTR = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The href of the page's own first <base href>, resolved against finalUrl, if it has a usable one. */
function existingBase(html: string, finalUrl: string): string | undefined {
  for (const tag of html.match(BASE_TAG) ?? []) {
    const match = HREF_ATTR.exec(tag);
    const raw = match ? (match[1] ?? match[2] ?? match[3] ?? "") : undefined;
    if (raw === undefined || raw.trim() === "") continue;
    try { return new URL(raw.trim(), finalUrl).href; } catch { return undefined; }
  }
  return undefined;
}

/**
 * Puts `<base href>` first in <head> (creating <head> when there is none). A base the page declares
 * itself is resolved against finalUrl and replaces it, so the page's relative URLs mean what they meant.
 */
export function injectBase(html: string, finalUrl: string): string {
  const href = existingBase(html, finalUrl) ?? finalUrl;
  const tag = `<base href="${escapeAttribute(href)}">`;
  const stripped = html.replace(BASE_TAG, "");
  const head = HEAD_OPEN.exec(stripped);
  if (head) return stripped.slice(0, head.index + head[0].length) + tag + stripped.slice(head.index + head[0].length);
  const root = HTML_OPEN.exec(stripped);
  if (root) return stripped.slice(0, root.index + root[0].length) + `<head>${tag}</head>` + stripped.slice(root.index + root[0].length);
  const doctype = DOCTYPE.exec(stripped);
  const at = doctype ? doctype[0].length : 0;
  return `${stripped.slice(0, at)}<head>${tag}</head>${stripped.slice(at)}`;
}

/** The saved page as text, in the charset its media type names (UTF-8 otherwise); an unknown charset decodes as UTF-8 with a warning. */
export function decodeCapture(bytes: Uint8Array, mediaType: string | undefined): { html: string; warning?: string } {
  const label = /charset\s*=\s*"?([^";\s]+)/i.exec(mediaType ?? "")?.[1]?.toLowerCase() ?? "utf-8";
  try {
    return { html: new TextDecoder(label).decode(bytes) };
  } catch {
    return { html: new TextDecoder("utf-8").decode(bytes), warning: `The saved page declares charset "${label}", which is unknown here; it was decoded as UTF-8.` };
  }
}

// --- The composite: reader | original, side by side, under a caption ---

export interface CompositeCaption { title: string; detail: string }

/** The composite's caption: the title, then URL, view and the problem kinds the reader picked. */
export function compositeCaption(record: Pick<RenderingFeedback, "title" | "url" | "view" | "kinds">): CompositeCaption {
  const kinds = record.kinds.length > 0 ? record.kinds.join(", ") : "no kind picked";
  return { title: record.title.replace(/\s+/g, " ").trim(), detail: `${record.url} · ${record.view} view · ${kinds}` };
}

export interface CompositeColumn { label: string; width: number; height: number }
export interface CompositeLayout { width: number; height: number; padding: number; captionHeight: number; labelHeight: number; columns: CompositeColumn[] }

const COMPOSITE_COLUMN = 776;
const COMPOSITE_PADDING = 16;
const CAPTION_HEIGHT = 56;
const LABEL_HEIGHT = 24;
/** Tall screenshots (a selection near the top of a long viewport) are scaled down to this height. */
const MAX_COLUMN_HEIGHT = 1_800;

function fitColumn(size: Size): Size {
  if (!(size.width > 0) || !(size.height > 0)) throw new Error(`a composite image must have a size, got ${size.width}×${size.height}`);
  const scale = Math.min(COMPOSITE_COLUMN / size.width, MAX_COLUMN_HEIGHT / size.height);
  return { width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)) };
}

/** The composite page's size in CSS pixels: one column per image (each at most COMPOSITE_COLUMN wide), the caption above. */
export function compositeLayout(left: Size, right: Size | undefined): CompositeLayout {
  const columns: CompositeColumn[] = [{ label: "Quire reader", ...fitColumn(left) }, ...(right ? [{ label: "Original page", ...fitColumn(right) }] : [])];
  const width = COMPOSITE_PADDING + columns.length * (COMPOSITE_COLUMN + COMPOSITE_PADDING);
  const height = COMPOSITE_PADDING * 2 + CAPTION_HEIGHT + LABEL_HEIGHT + Math.max(...columns.map((column) => column.height));
  return { width, height, padding: COMPOSITE_PADDING, captionHeight: CAPTION_HEIGHT, labelHeight: LABEL_HEIGHT, columns };
}

/** The composite page: a self-contained HTML document with the images as data: URLs, rendered without JavaScript. */
export function compositeHtml(layout: CompositeLayout, images: readonly string[], caption: CompositeCaption): string {
  if (images.length !== layout.columns.length) throw new Error(`the composite has ${layout.columns.length} columns but ${images.length} images`);
  const columns = layout.columns.map((column, index) => [
    `<figure style="margin:0;width:${COMPOSITE_COLUMN}px">`,
    `<figcaption style="height:${layout.labelHeight}px;font:600 13px/20px -apple-system,system-ui,sans-serif;color:#555">${escapeText(column.label)}</figcaption>`,
    `<img src="${escapeAttribute(images[index] ?? "")}" width="${column.width}" height="${column.height}" style="display:block;border:1px solid #ddd">`,
    "</figure>",
  ].join("")).join("");
  return [
    "<!doctype html><html><head><meta charset=\"utf-8\">",
    `<style>html,body{margin:0;background:#fff;width:${layout.width}px;height:${layout.height}px;overflow:hidden}</style>`,
    "</head><body>",
    `<div style="padding:${layout.padding}px">`,
    `<div style="height:${layout.captionHeight}px;overflow:hidden;font:15px/24px -apple-system,system-ui,sans-serif;color:#111">`,
    `<div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeText(caption.title)}</div>`,
    `<div style="font-size:12px;color:#555;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeText(caption.detail)}</div>`,
    "</div>",
    `<div style="display:flex;gap:${layout.padding}px;align-items:flex-start">${columns}</div>`,
    "</div></body></html>",
  ].join("");
}

/**
 * A script for the original page (evaluated over the DevTools protocol, which works with the page's JavaScript
 * off): finds `needle` in the body text ignoring whitespace, also across inline elements, scrolls it to a third
 * of the way down the window and selects it in a highlight colour. Answers `{ found, y }`.
 * (webContents.findInPage was tried first: in a hidden offscreen window its results never arrive.)
 */
export function locateTextScript(needle: string): string {
  return `(() => {
  const target = ${JSON.stringify(needle)}.replace(/\\s+/g, "");
  if (!target || !document.body) return { found: false, y: 0 };
  const skip = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/;
  // No filter callback: with the page's JavaScript off, the DOM cannot call back into a script function.
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let text = "";
  const nodes = [];
  const offsets = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.parentNode && skip.test(node.parentNode.nodeName)) continue;
    const value = node.nodeValue || "";
    for (let i = 0; i < value.length; i += 1) {
      if (/\\s/.test(value[i])) continue;
      text += value[i];
      nodes.push(node);
      offsets.push(i);
    }
  }
  const at = text.indexOf(target);
  if (at < 0) return { found: false, y: 0 };
  const last = at + target.length - 1;
  const range = document.createRange();
  range.setStart(nodes[at], offsets[at]);
  range.setEnd(nodes[last], offsets[last] + 1);
  const style = document.createElement("style");
  style.textContent = "::selection { background: #ffd400 !important; color: #000 !important; }";
  document.head ? document.head.appendChild(style) : document.body.appendChild(style);
  const selection = window.getSelection();
  if (selection) { selection.removeAllRanges(); selection.addRange(range); }
  const box = range.getBoundingClientRect();
  window.scrollTo(0, Math.max(0, box.top + window.scrollY - window.innerHeight / 3));
  return { found: true, y: window.scrollY };
})()`;
}
