import { useCallback, useEffect, useRef, useState } from "react";
import type { ItemDecision } from "../../shared/contracts";
import { read } from "./api";
import { isTypingTarget } from "./format";

export interface ReaderTarget { itemId: string; materialId: string }
export interface ReadFailure { itemId: string; message: string }
export type ItemBusy = "read" | ItemDecision;

/** The row to land on when `id` leaves the list: the next one, or the previous when it was last. */
export function neighbourOf(ids: readonly string[], id: string): string | undefined {
  const index = ids.indexOf(id);
  if (index < 0) return ids[0];
  return ids[index + 1] ?? ids[index - 1];
}

interface Options {
  /** Every row id in display order (across groups). */
  orderedIds: readonly string[];
  selectedId: string | undefined;
  onSelect: (id: string | undefined) => void;
  refresh: () => Promise<void>;
  /** Whether reading removes the item from this list (Inbox: yes; Queue: it stays, under Continue). */
  leavesOnRead: boolean;
  /** Letter shortcuts to decisions, e.g. { q: "queue", e: "dismiss" }. */
  shortcuts: Partial<Record<string, ItemDecision>>;
}

/**
 * The Inbox / Queue loop shared by both views: Read now (embedded reader on the right, or the
 * failure shown inline), decisions that move the selection on, and the keyboard map
 * (Enter / letters / j k ↓ ↑) while focus is not in a text field and the reader is closed.
 */
export function useItemReader({ orderedIds, selectedId, onSelect, refresh, leavesOnRead, shortcuts }: Options) {
  const [reading, setReading] = useState<ReaderTarget | undefined>(undefined);
  const [failure, setFailure] = useState<ReadFailure | undefined>(undefined);
  const [decisionError, setDecisionError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState<ItemBusy | undefined>(undefined);
  const listRef = useRef<HTMLDivElement>(null);
  const focusPending = useRef(false);

  const closeReader = useCallback(() => { setReading(undefined); setFailure(undefined); }, []);
  /** A selection made by the user: the reader gives way to the preview. */
  const select = useCallback((id: string | undefined) => { onSelect(id); closeReader(); }, [onSelect, closeReader]);

  const readNow = useCallback(async (id: string) => {
    setBusy("read"); setFailure(undefined); setDecisionError(undefined);
    try {
      const result = await read.readItem(id);
      if (!result.ok) { setFailure({ itemId: id, message: result.message }); return; }
      setReading({ itemId: id, materialId: result.material.id });
      if (leavesOnRead) onSelect(neighbourOf(orderedIds, id));
      await refresh();
    } catch (cause: unknown) {
      setFailure({ itemId: id, message: cause instanceof Error ? cause.message : "Could not open this item." });
    } finally { setBusy(undefined); }
  }, [leavesOnRead, onSelect, orderedIds, refresh]);

  const decide = useCallback(async (id: string, decision: ItemDecision) => {
    setBusy(decision); setDecisionError(undefined);
    try {
      await read.decideItem(id, decision);
      if (reading?.itemId === id) closeReader();
      onSelect(neighbourOf(orderedIds, id));
      await refresh();
    } catch (cause: unknown) {
      setDecisionError(cause instanceof Error ? cause.message : `Could not ${decision} this item.`);
    } finally { setBusy(undefined); }
  }, [closeReader, onSelect, orderedIds, reading, refresh]);

  const move = useCallback((delta: 1 | -1) => {
    if (orderedIds.length === 0) return;
    const index = selectedId ? orderedIds.indexOf(selectedId) : -1;
    const next = orderedIds[Math.min(orderedIds.length - 1, Math.max(0, index + delta))];
    if (next && next !== selectedId) { focusPending.current = true; select(next); }
  }, [orderedIds, selectedId, select]);

  // The selected row stays in view; after j / k it also takes focus so ↑/↓ continue from it.
  useEffect(() => {
    const row = listRef.current?.querySelector<HTMLElement>('[role="row"][aria-selected="true"]');
    if (!row) return;
    row.scrollIntoView({ block: "nearest" });
    if (focusPending.current) { focusPending.current = false; row.focus(); }
  }, [selectedId, orderedIds]);

  // Escape while focus is on a row: the grid consumes it before the reader's own listener, so it is
  // taken in the capture phase here. From anywhere else the reader handles it (inspector first, then back).
  useEffect(() => {
    if (!reading) return;
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !(event.target instanceof Node) || !listRef.current?.contains(event.target)) return;
      event.preventDefault(); event.stopPropagation(); closeReader();
    };
    window.addEventListener("keydown", onEscape, true);
    return () => window.removeEventListener("keydown", onEscape, true);
  }, [reading, closeReader]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (reading || busy || isTypingTarget(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      const onControl = target?.closest("button, a, [role='button'], [role='option'], [role='tab'], [role='menuitem']") !== null;
      const inGrid = target?.closest("[role='grid']") !== null;
      if (event.key === "j" || (event.key === "ArrowDown" && !inGrid && !onControl)) { event.preventDefault(); move(1); return; }
      if (event.key === "k" || (event.key === "ArrowUp" && !inGrid && !onControl)) { event.preventDefault(); move(-1); return; }
      if (!selectedId) return;
      // Enter on a focused row is the list's own action (onAction); on a control it is that control's.
      if (event.key === "Enter" && !inGrid && !onControl) { event.preventDefault(); void readNow(selectedId); return; }
      const decision = shortcuts[event.key];
      if (decision) { event.preventDefault(); void decide(selectedId, decision); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, decide, move, readNow, reading, selectedId, shortcuts]);

  return { reading, failure, decisionError, busy, listRef, select, readNow, decide, closeReader };
}
