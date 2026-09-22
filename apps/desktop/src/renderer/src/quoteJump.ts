import { useSyncExternalStore } from "react";
import { encodeTextQuoteV2Locator, resolveTextQuoteRange } from "@read/reader";

// A citation pill in an agent answer can carry the passage it quotes. Opening the material then
// jumps to that passage: the shell records the request here, the reader that shows the material
// resolves it once its body is up, and reports whether the passage was found so the panel can say so.

/** A request to show a material and reveal a quoted passage in it; `nonce` makes each click its own request. */
export interface MaterialQuoteJump { materialId: string; quote: string; nonce: number }

/** What became of a jump: the passage was revealed, or the material opened without it. */
export interface QuoteJumpReport { materialId: string; quote: string; found: boolean }

export const QUOTE_FLASH_MS = 1500;
const JUMP_HIGHLIGHT = "read-jump";
/** The reader's own flash for a block (see packages/reader reader.css), used where the CSS Highlight API is missing. */
const FOCUS_ATTRIBUTE = "data-reader-navigation-focus";

let lastReport: QuoteJumpReport | undefined;
const listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) listener(); };

/** A reader tells how the jump went; the panels that show the status line follow. */
export function reportQuoteJump(report: QuoteJumpReport) { lastReport = report; notify(); }
/** A new citation was pressed: the previous outcome no longer applies. */
export function clearQuoteJumpReport() { if (lastReport) { lastReport = undefined; notify(); } }

export function useQuoteJumpReport(): QuoteJumpReport | undefined {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => lastReport, () => lastReport);
}

/** A locator for the first occurrence of a bare quote (no prefix or suffix known), as the text-quote resolver wants one. */
export function quoteLocator(): string {
  return encodeTextQuoteV2Locator({ occurrence: 0, prefix: "", suffix: "" });
}

/** The first rendered occurrence of the quote in the body, whitespace aside; undefined when it is not there. */
export function resolveQuoteRange(root: HTMLElement, quote: string): Range | undefined {
  const trimmed = quote.trim();
  return trimmed ? resolveTextQuoteRange(root, quoteLocator(), trimmed) : undefined;
}

export function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

type HighlightWindow = Window & { CSS?: { highlights?: { set: (name: string, value: unknown) => unknown; delete: (name: string) => unknown } }; Highlight?: new (...ranges: Range[]) => unknown };

/**
 * Marks the range for a moment (the `read-jump` highlight, or the reader's block flash without the
 * Highlight API). A static mark for `QUOTE_FLASH_MS`, so reduced motion needs nothing more. Returns the undo.
 */
export function flashQuoteRange(root: HTMLElement, range: Range, ms = QUOTE_FLASH_MS): () => void {
  const view = root.ownerDocument.defaultView as HighlightWindow | null;
  const registry = view?.CSS?.highlights;
  const HighlightConstructor = view?.Highlight;
  let undo: () => void;
  if (registry && HighlightConstructor) {
    registry.set(JUMP_HIGHLIGHT, new HighlightConstructor(range));
    undo = () => { registry.delete(JUMP_HIGHLIGHT); };
  } else {
    const element = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
    if (!element) return () => undefined;
    element.setAttribute(FOCUS_ATTRIBUTE, "true");
    undo = () => { element.removeAttribute(FOCUS_ATTRIBUTE); };
  }
  const timer = window.setTimeout(undo, ms);
  return () => { window.clearTimeout(timer); undo(); };
}

/** Scrolls the range to the middle of its scroller (no smoothing under reduced motion). */
export function scrollQuoteIntoView(root: HTMLElement, range: Range) {
  const target = range.startContainer instanceof Element ? range.startContainer : (range.startContainer.parentElement ?? root);
  target.scrollIntoView({ block: "center", behavior: prefersReducedMotion() ? "auto" : "smooth" });
}
