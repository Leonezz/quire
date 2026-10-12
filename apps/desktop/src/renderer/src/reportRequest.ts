import { decodeTextQuoteLocator } from "@read/reader";
import type { RenderingFeedbackDraft } from "../../shared/contracts";
import type { SelectionCapture } from "./SelectionToolbar";

// What a reader hands the report panel when "Report" is asked for (the shortcut, the selection toolbar,
// the quality pill, the Info Quality row, the low-quality banner): a way to measure where the reader is at
// the moment the report is submitted, and the passage the reader pointed at, if any.

export type FeedbackViewport = NonNullable<RenderingFeedbackDraft["viewport"]>;
export type FeedbackRect = NonNullable<RenderingFeedbackDraft["selection"]>["rect"];

/** A selected passage attached to a report: the quote with its context, its box when Report was pressed, and its locator (to measure it again). */
export interface ReportSelection extends SelectionCapture {
  prefix: string;
  suffix: string;
  rect: FeedbackRect;
}

export interface ReportMeasure {
  viewport?: FeedbackViewport;
  /** The attached passage's box now, when the reader can find it again (the text readers); otherwise the box from when Report was pressed stands. */
  selectionRect?: FeedbackRect;
}

export interface ReportRequest {
  /** Read when the report is submitted, so the screenshot box matches what is on screen then. */
  measure: (selection: ReportSelection | undefined) => ReportMeasure;
  selection?: ReportSelection;
}

/**
 * A layout box in window CSS pixels (getBoundingClientRect is relative to the window's content, which is the
 * whole window under the hidden-inset title bar), widened to whole pixels so a capture never cuts a glyph.
 */
export function rectOf(box: Pick<DOMRect, "left" | "top" | "right" | "bottom">): FeedbackRect {
  const x = Math.floor(box.left);
  const y = Math.floor(box.top);
  return { x, y, width: Math.max(0, Math.ceil(box.right) - x), height: Math.max(0, Math.ceil(box.bottom) - y) };
}

/** The reading viewport's box and the scroll position (0–1). */
export function viewportOf(element: HTMLElement | null, scrollFraction: number): FeedbackViewport | undefined {
  if (!element) return undefined;
  return { ...rectOf(element.getBoundingClientRect()), scrollFraction: Math.min(1, Math.max(0, scrollFraction)) };
}

/** The capture as a report selection: prefix and suffix come from a text-quote locator; a PDF region locator has none. */
export function reportSelectionOf(capture: SelectionCapture, box: Pick<DOMRect, "left" | "top" | "right" | "bottom">): ReportSelection {
  const hint = decodeTextQuoteLocator(capture.locator);
  return { locator: capture.locator, quote: capture.quote, prefix: hint?.prefix ?? "", suffix: hint?.suffix ?? "", rect: rectOf(box) };
}

/**
 * The live selection inside `root`, when it can be anchored, as a report selection; the selection is then cleared,
 * so neither it nor the selection toolbar is in the screenshot of the reader.
 */
export function takeLiveSelection(root: HTMLElement | null, capture: (selection: Selection) => SelectionCapture | undefined): ReportSelection | undefined {
  const selection = document.getSelection();
  if (!root || !selection || selection.isCollapsed || selection.rangeCount === 0) return undefined;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return undefined;
  const captured = capture(selection);
  if (!captured) return undefined;
  const taken = reportSelectionOf(captured, range.getBoundingClientRect());
  selection.removeAllRanges();
  return taken;
}

/** The draft's selection: the quote and its context, and the box measured now or, failing that, the one from when Report was pressed. */
export function draftSelectionOf(selection: ReportSelection, measured: ReportMeasure): NonNullable<RenderingFeedbackDraft["selection"]> {
  return { quote: selection.quote, prefix: selection.prefix, suffix: selection.suffix, rect: measured.selectionRect ?? selection.rect };
}
