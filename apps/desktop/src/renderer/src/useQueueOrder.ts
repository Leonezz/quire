import { useCallback, useMemo, useRef, useState } from "react";
import type { ItemRecord } from "../../shared/contracts";
import { read } from "./api";

/** `moved` placed before or after `target` in `ids`; the rest keeps its order. */
export function reorderIds(ids: readonly string[], moved: readonly string[], target: string, position: "before" | "after"): string[] {
  const rest = ids.filter((id) => !moved.includes(id));
  const at = rest.indexOf(target);
  if (at < 0) return [...rest, ...moved];
  const index = position === "before" ? at : at + 1;
  return [...rest.slice(0, index), ...moved, ...rest.slice(index)];
}

/** `items` in the order `ids` gives; anything `ids` does not name keeps its place at the end. */
export function orderBy(items: readonly ItemRecord[], ids: readonly string[]): ItemRecord[] {
  const rank = new Map(ids.map((id, index) => [id, index]));
  return [...items].sort((a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER));
}

export type Reorder = (moved: string[], target: string, position: "before" | "after") => void;

/**
 * The queue's order while reorders are in flight. Each drop is applied locally at once and sent
 * with a request generation: a second drop before the first has been saved starts from the local
 * order (not the stale server list), and only the latest save's refresh may hand the order back
 * to the server list — so a fast double reorder never loses a move.
 */
export function useQueueOrder(items: readonly ItemRecord[], refresh: () => Promise<void>) {
  const [pending, setPending] = useState<readonly string[] | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const generation = useRef(0);
  const ordered = useMemo(() => (pending ? orderBy(items, pending) : [...items]), [items, pending]);
  const continuing = useMemo(() => ordered.filter((item) => item.openedAt), [ordered]);
  const upNext = useMemo(() => ordered.filter((item) => !item.openedAt), [ordered]);

  const persist = useCallback((order: string[]) => {
    const mine = ++generation.current;
    setPending(order); setError(undefined);
    read.reorderQueue(order)
      .then(async () => { await refresh(); if (generation.current === mine) setPending(undefined); })
      .catch((cause: unknown) => {
        if (generation.current !== mine) return;
        setPending(undefined);
        setError(cause instanceof Error ? cause.message : "Could not save the new order.");
      });
  }, [refresh]);

  const idsOf = (list: readonly ItemRecord[]) => list.map((item) => item.id);
  const reorderContinuing: Reorder = useCallback((moved, target, position) => persist([...reorderIds(idsOf(continuing), moved, target, position), ...idsOf(upNext)]), [continuing, upNext, persist]);
  const reorderUpNext: Reorder = useCallback((moved, target, position) => persist([...idsOf(continuing), ...reorderIds(idsOf(upNext), moved, target, position)]), [continuing, upNext, persist]);

  return { continuing, upNext, reorderContinuing, reorderUpNext, error };
}
