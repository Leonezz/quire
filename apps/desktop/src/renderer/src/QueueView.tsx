import { useMemo } from "react";
import { Bookmark } from "lucide-react";
import { ItemGroup, ItemList, ItemRow, useDragAndDrop, type Key } from "@read/ui";
import type { ItemRecord } from "../../shared/contracts";
import { ContentToolbar } from "./AppToolbar";
import { ContentColumn, ContentPane, EmptySentence, ListColumn } from "./ContentPane";
import { ErrorBoundary } from "./ErrorBoundary";
import type { ItemViewProps } from "./InboxView";
import { MaterialReader } from "./MaterialReader";
import { InlineError, ItemPreview, KeptNoticeLine } from "./ItemPreview";
import { signalsOf, timeOf } from "./format";
import { useItemReader } from "./useItemReader";
import { useQueueOrder, type Reorder } from "./useQueueOrder";

const shortcuts = { e: "unqueue" } as const;

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
          <ItemRow id={item.id} title={item.title} source={item.sourceTitle} time={timeOf(item.publishedAt)} gist={item.gist} minutes={item.readingMinutes} signals={signalsOf(item.signals)} state="queued" kept={Boolean(item.keptAt)}
            {...(item.introducedBy ? { tag: "agent" as const } : item.summaryOnly ? { tag: "summary" as const } : {})} />
        )}
      </ItemList>
    </>
  );
}

/** The Queue: Continue and Up next on the left (drag to reorder), the preview or the reader on the right. */
export function QueueView({ items, selectedId, onSelect, refresh, onOpenLink, onOpenMaterial, shell, error }: ItemViewProps) {
  const { continuing, upNext, reorderContinuing, reorderUpNext, error: reorderError } = useQueueOrder(items, refresh);
  const orderedIds = useMemo(() => [...continuing, ...upNext].map((item) => item.id), [continuing, upNext]);
  const { reading, failure, decisionError, busy, kept, listRef, select, readNow, keep, decide, closeReader } = useItemReader({ orderedIds, selectedId, onSelect, refresh, leavesOnRead: false, leavesOnKeep: false, shortcuts });
  const current = items.find((item) => item.id === selectedId);
  const keptLine = kept ? <KeptNoticeLine title={kept.title} onOpen={() => onOpenMaterial(kept.materialId)} /> : undefined;
  const onAction = (id: string) => void readNow(id);

  return (
    <>
      <ListColumn family="items" toolbar={shell.listToolbar} listRef={listRef}>
        <div className="list-scroll flex min-h-0 flex-1 flex-col overflow-y-auto py-2.5">
          {error ? <div className="px-3 pb-2"><InlineError title="The lists could not be loaded." message={error} /></div> : null}
          {reorderError ? <div className="px-3 pb-2"><InlineError title="The order was not saved." message={reorderError} /></div> : null}
          {items.length ? (
            <>
              {continuing.length ? <QueueGroup title="Continue" items={continuing} selectedId={selectedId} onSelect={select} onAction={onAction} onReorder={reorderContinuing} /> : null}
              {upNext.length ? <QueueGroup title="Up next" items={upNext} selectedId={selectedId} onSelect={select} onAction={onAction} onReorder={reorderUpNext} /> : null}
            </>
          ) : (
            <EmptySentence>Nothing queued — press q on an Inbox item to save it for later.</EmptySentence>
          )}
        </div>
      </ListColumn>
      <ContentColumn>
        {reading ? (
          <ErrorBoundary key={reading.materialId} label="The reader" onReset={closeReader}><MaterialReader id={reading.materialId} onOpenLink={onOpenLink} onOpenMaterial={onOpenMaterial} onBack={closeReader} trailing={shell.trailing} /></ErrorBoundary>
        ) : (
          <ContentPane toolbar={<ContentToolbar trailing={shell.trailing} />} panel={shell.agentPanel}>
            {current ? (
              <ItemPreview item={current} busy={busy !== undefined} failure={failure?.itemId === current.id ? failure : undefined} error={decisionError?.itemId === current.id ? decisionError.message : undefined} kept={keptLine} onOpenLink={onOpenLink}
                actions={[
                  { label: busy === "read" ? "Opening…" : current.openedAt ? "Continue" : "Read now", kbd: "↵", onPress: () => void readNow(current.id) },
                  { label: busy === "keep" ? "Keeping…" : current.keptAt ? "Kept" : "Keep", kbd: "k", icon: <Bookmark />, onPress: () => void keep(current.id) },
                  { label: "Remove", kbd: "e", variant: "quiet", onPress: () => void decide(current.id, "unqueue") },
                ]} />
            ) : (
              <>
                {keptLine}
                <EmptySentence>Select something to read.</EmptySentence>
              </>
            )}
          </ContentPane>
        )}
      </ContentColumn>
    </>
  );
}
