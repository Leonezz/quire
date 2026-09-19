import { useMemo } from "react";
import { Bookmark } from "lucide-react";
import { ItemList, ItemRow, ItemSection } from "@read/ui";
import type { ItemRecord } from "../../shared/contracts";
import { ContentToolbar } from "./AppToolbar";
import { ContentColumn, ContentPane, EmptySentence, ListColumn, type ShellSlots } from "./ContentPane";
import { ErrorBoundary } from "./ErrorBoundary";
import { MaterialReader } from "./MaterialReader";
import { InlineError, ItemPreview, KeptNoticeLine } from "./ItemPreview";
import { dayLabel, signalsOf, timeOf } from "./format";
import { useItemReader } from "./useItemReader";

interface Group { id: string; title: string; items: ItemRecord[] }

/** Newest first, by day; groups appear in the order their first item does. */
function groupByDay(items: ItemRecord[]): Group[] {
  const groups = new Map<string, Group>();
  for (const item of items) {
    const title = dayLabel(item.publishedAt);
    const group = groups.get(title) ?? { id: `day:${title}`, title, items: [] };
    groups.set(title, { ...group, items: [...group.items, item] });
  }
  return [...groups.values()];
}

const shortcuts = { q: "queue", e: "dismiss" } as const;

export interface ItemViewProps {
  items: ItemRecord[];
  selectedId: string | undefined;
  onSelect: (id: string | undefined) => void;
  refresh: () => Promise<void>;
  onOpenLink: (url: string) => void;
  onOpenMaterial: (id: string) => void;
  shell: ShellSlots;
  /** The lists could not be loaded: said at the top of the list, never swallowed. */
  error?: string | undefined;
}

/** The Inbox (or one source's undecided items): day groups on the left, the preview or the reader on the right. */
export function InboxView({ items, selectedId, onSelect, refresh, onOpenLink, onOpenMaterial, shell, error, empty }: ItemViewProps & { empty: string }) {
  const groups = useMemo(() => groupByDay(items), [items]);
  const orderedIds = useMemo(() => groups.flatMap((group) => group.items.map((item) => item.id)), [groups]);
  const { reading, failure, decisionError, busy, kept, listRef, select, readNow, keep, decide, closeReader } = useItemReader({ orderedIds, selectedId, onSelect, refresh, leavesOnRead: true, leavesOnKeep: true, shortcuts });
  const current = items.find((item) => item.id === selectedId);
  const keptLine = kept ? <KeptNoticeLine title={kept.title} onOpen={() => onOpenMaterial(kept.materialId)} /> : undefined;

  return (
    <>
      <ListColumn family="items" toolbar={shell.listToolbar} listRef={listRef}>
        {error ? <div className="p-3"><InlineError title="The lists could not be loaded." message={error} /></div> : null}
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
          <EmptySentence>{empty}</EmptySentence>
        )}
      </ListColumn>
      <ContentColumn>
        {reading ? (
          <ErrorBoundary key={reading.materialId} label="The reader" onReset={closeReader}><MaterialReader id={reading.materialId} onOpenLink={onOpenLink} onOpenMaterial={onOpenMaterial} onBack={closeReader} trailing={shell.trailing} /></ErrorBoundary>
        ) : (
          <ContentPane toolbar={<ContentToolbar trailing={shell.trailing} />} panel={shell.agentPanel}>
            {current ? (
              <ItemPreview item={current} busy={busy !== undefined} failure={failure?.itemId === current.id ? failure : undefined} error={decisionError?.itemId === current.id ? decisionError.message : undefined} kept={keptLine} onOpenLink={onOpenLink}
                actions={[
                  { label: busy === "read" ? "Opening…" : "Read now", kbd: "↵", onPress: () => void readNow(current.id) },
                  { label: busy === "keep" ? "Keeping…" : "Keep", kbd: "k", icon: <Bookmark />, onPress: () => void keep(current.id) },
                  { label: "Queue", kbd: "q", onPress: () => void decide(current.id, "queue") },
                  { label: "Dismiss", kbd: "e", variant: "quiet", onPress: () => void decide(current.id, "dismiss") },
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
