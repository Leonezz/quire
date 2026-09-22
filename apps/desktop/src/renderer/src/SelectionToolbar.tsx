import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Copy, MessageSquarePlus, Sparkles } from "lucide-react";
import { Button } from "@read/ui";
import type { AnnotationColor } from "../../shared/contracts";
import { ANNOTATION_COLORS } from "./annotations";

export interface SelectionCapture { locator: string; quote: string }

export type ToolbarSide = "above" | "below";
type Placement = { top: number; left: number; side: ToolbarSide; capture: SelectionCapture };
type Box = Pick<DOMRect, "top" | "bottom" | "left" | "width" | "height">;
type BarSize = { width: number; height: number };

/** The gap between the selection and the bar, so the bar never sits on the neighbouring line. */
export const TOOLBAR_GAP = 10;
/** Where the bar sits before it has been measured (the first paint corrects it). */
const DEFAULT_BAR: BarSize = { width: 296, height: 44 };
const EDGE = 4;

/**
 * Where the bar goes for a selection rectangle inside the viewport box: above it with a clear gap,
 * or, when that would leave the frame, below it. Both coordinates are relative to the frame; the
 * bar is centred on `left` (translate -50%) and kept inside the frame's width.
 */
export function placeToolbar(rect: Box, box: Box, bar: BarSize): { top: number; left: number; side: ToolbarSide } | undefined {
  if (rect.bottom < box.top || rect.top > box.bottom) return undefined;
  const above = rect.top - box.top - (bar.height + TOOLBAR_GAP);
  const side: ToolbarSide = above >= EDGE ? "above" : "below";
  const top = side === "above" ? above : rect.bottom - box.top + TOOLBAR_GAP;
  const half = bar.width / 2;
  const centre = rect.left - box.left + rect.width / 2;
  const left = box.width < bar.width + EDGE * 2 ? box.width / 2 : Math.min(box.width - half - EDGE, Math.max(half + EDGE, centre));
  return { top, left, side };
}

/**
 * Floats next to a text selection inside the article: pick a colour to highlight, add a note, copy a
 * citation, or ask the agent about it. Nothing is stored until a button is pressed. The bar stands
 * above the selection with a gap (never over the line before it); on the first lines it drops below.
 */
export function SelectionToolbar({ root, viewport, capture, onHighlight, onNote, onCopy, onAsk }: {
  root: HTMLElement | null;
  viewport: HTMLElement | null;
  /** Turns the live selection into a locator + quote, or undefined when it cannot be anchored (cross-page, outside the text). */
  capture: (selection: Selection) => SelectionCapture | undefined;
  onHighlight: (capture: SelectionCapture, color: AnnotationColor) => void;
  onNote: (capture: SelectionCapture) => void;
  onCopy: (capture: SelectionCapture) => void;
  /** "Ask about this": the reader makes the selection the agent's context and opens the panel. */
  onAsk: (capture: SelectionCapture) => void;
}) {
  const [placement, setPlacement] = useState<Placement | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  // The bar's own size, measured once it is on screen; the placement is redone when it changes.
  const sizeRef = useRef<BarSize>(DEFAULT_BAR);
  const updateRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    if (!root || !viewport) return;
    let frame = 0;
    const place = () => {
      const selection = document.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) { setPlacement(null); return; }
      const range = selection.getRangeAt(0);
      if (!root.contains(range.commonAncestorContainer)) { setPlacement(null); return; }
      const captured = capture(selection);
      if (!captured) { setPlacement(null); return; }
      // Positioned inside the reader frame (not the scrolled content), so viewport-relative
      // coordinates are what the absolute box needs; scrolling re-runs this handler.
      const placed = placeToolbar(range.getBoundingClientRect(), viewport.getBoundingClientRect(), sizeRef.current);
      setPlacement(placed ? { ...placed, capture: captured } : null);
    };
    const update = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(place); };
    updateRef.current = update;
    // While the pointer is down the selection is still being made: hide, and place the bar on release.
    let pointerDown = false;
    const onPointerDown = () => { pointerDown = true; setPlacement(null); };
    const onPointerUp = () => { pointerDown = false; update(); };
    const onSelectionChange = () => { if (pointerDown) setPlacement(null); else update(); };
    const onKeyUp = (event: KeyboardEvent) => { if (event.shiftKey || event.key === "Shift") update(); };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("pointerup", onPointerUp);
    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("keyup", onKeyUp);
    viewport.addEventListener("scroll", update, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      updateRef.current = () => undefined;
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("pointerup", onPointerUp);
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("keyup", onKeyUp);
      viewport.removeEventListener("scroll", update);
    };
  }, [root, viewport, capture]);

  // offsetWidth / offsetHeight: the pop animation scales the bar, which a bounding rect would include.
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const measured = { width: bar.offsetWidth, height: bar.offsetHeight };
    if (measured.width === 0 || measured.height === 0) return;
    if (measured.width === sizeRef.current.width && measured.height === sizeRef.current.height) return;
    sizeRef.current = measured;
    updateRef.current();
  });

  if (!placement) return null;
  const done = () => { document.getSelection()?.removeAllRanges(); setPlacement(null); };
  return (
    <div
      ref={barRef}
      role="toolbar"
      aria-label="Selection"
      data-side={placement.side}
      className="glass-strong toolbar-pop absolute z-20 flex -translate-x-1/2 items-center gap-0.5 rounded-pill p-1"
      style={{ top: placement.top, left: placement.left }}
      onMouseDown={(event) => event.preventDefault()}
    >
      {ANNOTATION_COLORS.map(({ color, label }) => (
        <Button key={color} variant="quiet" size="sm" aria-label={`Highlight ${label.toLowerCase()}`} className="size-8 shrink-0" onPress={() => { onHighlight(placement.capture, color); done(); }}>
          <i aria-hidden="true" className="block size-icon-md shrink-0 rounded-full shadow-[inset_0_0_0_1px_rgba(0,0,0,.08)]" style={{ background: color }} />
        </Button>
      ))}
      <span className="mx-1 h-5 w-px shrink-0 bg-separator" />
      <Button variant="quiet" size="sm" aria-label="Add a note" className="size-8 shrink-0" onPress={() => { onNote(placement.capture); done(); }}><MessageSquarePlus /></Button>
      <Button variant="quiet" size="sm" aria-label="Copy citation" className="size-8 shrink-0" onPress={() => { onCopy(placement.capture); done(); }}><Copy /></Button>
      <Button variant="quiet" size="sm" aria-label="Ask about this" className="size-8 shrink-0" onPress={() => { onAsk(placement.capture); done(); }}><Sparkles /></Button>
    </div>
  );
}
