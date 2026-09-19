import { useEffect, useState } from "react";
import { Copy, MessageSquarePlus, Sparkles } from "lucide-react";
import { Button } from "@read/ui";
import type { AnnotationColor } from "../../shared/contracts";
import { ANNOTATION_COLORS } from "./annotations";

export interface SelectionCapture { locator: string; quote: string }

type Placement = { top: number; left: number; capture: SelectionCapture };

/**
 * Floats above a text selection inside the article: pick a colour to highlight,
 * add a note, copy a citation, or ask the agent about it. Nothing is stored until a button is pressed.
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

  useEffect(() => {
    if (!root || !viewport) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const selection = document.getSelection();
        if (!selection || selection.isCollapsed || selection.rangeCount === 0) { setPlacement(null); return; }
        const range = selection.getRangeAt(0);
        if (!root.contains(range.commonAncestorContainer)) { setPlacement(null); return; }
        const captured = capture(selection);
        if (!captured) { setPlacement(null); return; }
        const rect = range.getBoundingClientRect();
        const box = viewport.getBoundingClientRect();
        // Positioned inside the reader frame (not the scrolled content), so viewport-relative
        // coordinates are what the absolute box needs; scrolling re-runs this handler.
        const top = rect.top - box.top - 44;
        if (top < -40 || rect.top > box.bottom) { setPlacement(null); return; }
        setPlacement({
          top: Math.max(4, top),
          left: Math.min(box.width - 140, Math.max(140, rect.left - box.left + rect.width / 2)),
          capture: captured,
        });
      });
    };
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
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("pointerup", onPointerUp);
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("keyup", onKeyUp);
      viewport.removeEventListener("scroll", update);
    };
  }, [root, viewport, capture]);

  if (!placement) return null;
  const done = () => { document.getSelection()?.removeAllRanges(); setPlacement(null); };
  return (
    <div
      role="toolbar"
      aria-label="Selection"
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
