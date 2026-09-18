import { useMemo } from "react";
import { Bookmark } from "lucide-react";
import { ItemList, ItemRow, ItemSection, SplitGroup, SplitPanel, SplitSeparator, useSplitSizes } from "@read/ui";
import type { ItemRecord } from "../../shared/contracts";
import { ErrorBoundary } from "./ErrorBoundary";
import { MaterialReader } from "./MaterialReader";
import { EmptyState, ItemPreview, KeptNoticeLine, panelClass } from "./ItemPreview";
import { dayLabel, signalsOf, timeOf } from "./format";
import { useItemReader } from "./useItemReader";

export type InboxGrouping = "date" | "source";
interface Group { id: string; title: string; items: ItemRecord[] }

/** Newest first; groups appear in the order their first item does. */
function groupItems(items: ItemRecord[], grouping: InboxGrouping): Group[] {
  const groups = new Map<string, Group>();
  for (const item of items) {
    const title = grouping === "date" ? dayLabel(item.publishedAt) : item.sourceTitle;
    const group = groups.get(title) ?? { id: `${grouping}:${title}`, title, items: [] };
    groups.set(title, { ...group, items: [...group.items, item] });
  }
  return [...groups.values()];
}

const shortcuts = { q: "queue", e: "dismiss" } as const;

export function InboxView({ items, grouping, selectedId, onSelect, refresh, onOpenLink, onOpenMaterial }: { items: ItemRecord[]; grouping: InboxGrouping; selectedId: string | undefined; onSelect: (id: string | undefined) => void; refresh: () => Promise<void>; onOpenLink: (url: string) => void; onOpenMaterial: (id: string) => void }) {
  const groups = useMemo(() => groupItems(items, grouping), [items, grouping]);
  const orderedIds = useMemo(() => groups.flatMap((group) => group.items.map((item) => item.id)), [groups]);
  const { reading, failure, decisionError, busy, kept, listRef, select, readNow, keep, decide, closeReader } = useItemReader({ orderedIds, selectedId, onSelect, refresh, leavesOnRead: true, leavesOnKeep: true, shortcuts });
  const current = items.find((item) => item.id === selectedId);
  const sizes = useSplitSizes("inbox");
  const keptLine = kept ? <KeptNoticeLine title={kept.title} onOpen={() => onOpenMaterial(kept.materialId)} /> : undefined;

  return (
    <SplitGroup id="inbox" aria-label="Inbox" className={`min-h-0 flex-1 overflow-hidden ${panelClass}`}>
      <SplitPanel id="list" defaultSize={sizes.sizeOf("list", 420)} minSize={280} maxSize={560} onResize={sizes.onResize("list")}>
      <div ref={listRef} className="flex h-full min-h-0 flex-col">
        {items.length ? (
          <ItemList aria-label="Inbox" items={groups} selectionMode="single" selectionBehavior="replace" disallowEmptySelection selectedKeys={selectedId ? new Set([selectedId]) : new Set()}
            onSelectionChange={(keys) => { const key = keys === "all" ? undefined : [...keys][0]; if (key !== undefined && String(key) !== selectedId) select(String(key)); }}
            onAction={(key) => void readNow(String(key))} className="flex-1">
            {(group) => (
              <ItemSection id={group.id} title={group.title} items={group.items}>
                {(item) => (
                  <ItemRow id={item.id} title={item.title} source={item.sourceTitle} time={timeOf(item.publishedAt)} gist={item.gist} minutes={item.readingMinutes} signals={signalsOf(item.signals)} state="unread"
                    {...(item.introducedBy ? { tag: "agent" as const } : item.summaryOnly ? { tag: "summary" as const } : {})} />
                )}
              </ItemSection>
            )}
          </ItemList>
        ) : (
          <EmptyState title="Inbox zero." hint="Sources bring new items here; ⌘N adds one." />
        )}
      </div>
      </SplitPanel>
      <SplitSeparator aria-label="Resize list" />
      <SplitPanel id="detail" minSize={360}>
      <section className="flex h-full min-h-0 flex-col overflow-hidden">
        {reading ? (
          <ErrorBoundary key={reading.materialId} label="The reader" onReset={closeReader}><MaterialReader id={reading.materialId} onOpenLink={onOpenLink} onOpenMaterial={onOpenMaterial} onBack={closeReader} /></ErrorBoundary>
        ) : current ? (
          <ItemPreview item={current} busy={busy !== undefined} failure={failure?.itemId === current.id ? failure : undefined} error={decisionError} kept={keptLine} onOpenLink={onOpenLink}
            actions={[
              { label: busy === "read" ? "Opening…" : "Read now", kbd: "↵", onPress: () => void readNow(current.id) },
              { label: busy === "keep" ? "Keeping…" : "Keep", kbd: "k", icon: <Bookmark className="size-3.5" />, onPress: () => void keep(current.id) },
              { label: "Queue", kbd: "q", onPress: () => void decide(current.id, "queue") },
              { label: "Dismiss", kbd: "e", variant: "quiet", onPress: () => void decide(current.id, "dismiss") },
            ]} />
        ) : (
          <>
            {keptLine}
            <EmptyState title="Nothing selected" hint={items.length ? "Select an item to preview it." : "New items appear on the left."} />
          </>
        )}
      </section>
      </SplitPanel>
    </SplitGroup>
  );
}
