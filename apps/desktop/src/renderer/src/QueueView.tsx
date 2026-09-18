import { useMemo, useState } from "react";
import { ItemGroup, ItemList, ItemRow, useDragAndDrop, type Key } from "@read/ui";
import type { ItemRecord } from "../../shared/contracts";
import { read } from "./api";
import { ErrorBoundary } from "./ErrorBoundary";
import { MaterialReader } from "./MaterialReader";
import { EmptyState, InlineError, ItemPreview, panelClass } from "./ItemPreview";
import { signalsOf, timeOf } from "./format";
import { useItemReader } from "./useItemReader";

const shortcuts = { e: "unqueue" } as const;

/** `moved` placed before or after `target` in `ids`; the rest keeps its order. */
export function reorderIds(ids: readonly string[], moved: readonly string[], target: string, position: "before" | "after"): string[] {
  const rest = ids.filter((id) => !moved.includes(id));
  const at = rest.indexOf(target);
  if (at < 0) return [...rest, ...moved];
  const index = position === "before" ? at : at + 1;
  return [...rest.slice(0, index), ...moved, ...rest.slice(index)];
}

type Reorder = (moved: string[], target: string, position: "before" | "after") => void;

/**
 * One group of the queue as its own flat list: RAC renders drop indicators only for flat
 * collections, and the groups come from `openedAt`, so reordering never crosses them.
 */
function QueueGroup({ title, items, selectedId, onSelect, onAction, onReorder }: { title: string; items: ItemRecord[]; selectedId: string | undefined; onSelect: (id: string) => void; onAction: (id: string) => void; onReorder: Reorder }) {
  const { dragAndDropHooks } = useDragAndDrop({
    getItems: (keys) => [...keys].map((key) => ({ "text/plain": items.find((item) => item.id === key)?.title ?? String(key) })),
    onReorder: (event) => { if (event.target.dropPosition !== "on") onReorder([...event.keys].map((key: Key) => String(key)), String(event.target.key), event.target.dropPosition); },
  });
  return (
    <>
      <ItemGroup>{title}</ItemGroup>
      <ItemList aria-label={title} items={items} selectionMode="single" selectionBehavior="replace" disallowEmptySelection selectedKeys={selectedId ? new Set([selectedId]) : new Set()}
        onSelectionChange={(keys) => { const key = keys === "all" ? undefined : [...keys][0]; if (key !== undefined && String(key) !== selectedId) onSelect(String(key)); }}
        onAction={(key) => onAction(String(key))} dragAndDropHooks={dragAndDropHooks} className="shrink-0 py-0">
        {(item) => (
          <ItemRow id={item.id} title={item.title} source={item.sourceTitle} time={timeOf(item.publishedAt)} gist={item.gist} minutes={item.readingMinutes} signals={signalsOf(item.signals)} state="queued"
            {...(item.introducedBy ? { tag: "agent" as const } : item.summaryOnly ? { tag: "summary" as const } : {})} />
        )}
      </ItemList>
    </>
  );
}

export function QueueView({ items, selectedId, onSelect, refresh, onOpenLink }: { items: ItemRecord[]; selectedId: string | undefined; onSelect: (id: string | undefined) => void; refresh: () => Promise<void>; onOpenLink: (url: string) => void }) {
  const continuing = useMemo(() => items.filter((item) => item.openedAt), [items]);
  const upNext = useMemo(() => items.filter((item) => !item.openedAt), [items]);
  const orderedIds = useMemo(() => [...continuing, ...upNext].map((item) => item.id), [continuing, upNext]);
  const { reading, failure, decisionError, busy, listRef, select, readNow, decide, closeReader } = useItemReader({ orderedIds, selectedId, onSelect, refresh, leavesOnRead: false, shortcuts });
  const [reorderError, setReorderError] = useState<string | undefined>(undefined);
  const current = items.find((item) => item.id === selectedId);

  const persist = (order: string[]) => {
    setReorderError(undefined);
    read.reorderQueue(order)
      .catch((cause: unknown) => { setReorderError(cause instanceof Error ? cause.message : "Could not save the new order."); })
      .finally(() => { void refresh(); });
  };
  const reorderContinuing: Reorder = (moved, target, position) => persist([...reorderIds(continuing.map((item) => item.id), moved, target, position), ...upNext.map((item) => item.id)]);
  const reorderUpNext: Reorder = (moved, target, position) => persist([...continuing.map((item) => item.id), ...reorderIds(upNext.map((item) => item.id), moved, target, position)]);
  const onAction = (id: string) => void readNow(id);

  return (
    <main className={`grid min-h-0 flex-1 grid-cols-[420px_minmax(0,1fr)] overflow-hidden ${panelClass}`}>
      <div ref={listRef} className="list-scroll flex min-h-0 flex-col overflow-y-auto border-r border-separator-soft py-2.5">
        {reorderError ? <div className="px-3 pb-2"><InlineError title="The order was not saved." message={reorderError} /></div> : null}
        {items.length ? (
          <>
            {continuing.length ? <QueueGroup title="Continue" items={continuing} selectedId={selectedId} onSelect={select} onAction={onAction} onReorder={reorderContinuing} /> : null}
            {upNext.length ? <QueueGroup title="Up next" items={upNext} selectedId={selectedId} onSelect={select} onAction={onAction} onReorder={reorderUpNext} /> : null}
          </>
        ) : (
          <EmptyState title="Nothing queued." hint="Press q on an Inbox item to save it for later." />
        )}
      </div>
      <section className="flex min-h-0 flex-col overflow-hidden">
        {reading ? (
          <ErrorBoundary key={reading.materialId} label="The reader" onReset={closeReader}><MaterialReader id={reading.materialId} onOpenLink={onOpenLink} onBack={closeReader} /></ErrorBoundary>
        ) : current ? (
          <ItemPreview item={current} busy={busy !== undefined} failure={failure?.itemId === current.id ? failure.message : undefined} error={decisionError} onOpenLink={onOpenLink}
            actions={[
              { label: busy === "read" ? "Opening…" : current.openedAt ? "Continue" : "Read now", kbd: "↵", onPress: () => void readNow(current.id) },
              { label: "Remove", kbd: "e", variant: "quiet", onPress: () => void decide(current.id, "unqueue") },
            ]} />
        ) : (
          <EmptyState title="Nothing selected" hint={items.length ? "Select something queued." : "Queued items wait on the left."} />
        )}
      </section>
    </main>
  );
}
