import { useMemo, useRef, useState } from "react";
import { BookOpen, FileText, Inbox as InboxIcon, ListOrdered, PanelLeft, Settings as SettingsIcon, Sparkles, Tag } from "lucide-react";
import { Button, Icon, Popover, Sidebar, SidebarItem, SidebarSection, ToolbarButton, type SidebarHealth } from "@read/ui";
import type { ItemRecord, SourceRecord, TagCount } from "../../shared/contracts";
import { sourceHealth } from "./format";
import { UpdateBanner } from "./UpdateBanner";
import { CUT_LABELS, LIBRARY_CUTS, scopeKey, scopeOfKey, type Scope } from "./useScope";

const TOP_TAGS = 8;
const ALL_TAGS_KEY = "tags:all";

export interface AppSidebarProps {
  /** The panel's remembered width in pixels; the inner layout keeps it during the slide. */
  width: number;
  scope: Scope;
  onScope: (scope: Scope) => void;
  inbox: ItemRecord[];
  queueCount: number;
  conversationCount: number;
  /** Agent turns in flight: the Agent item then shows a spinner and this number instead of the conversation count. */
  runningCount: number;
  tags: TagCount[];
  sources: SourceRecord[];
  onHide: () => void;
  onOpenSettings: () => void;
}

/** Undecided items per source, from the Inbox: the sidebar's per-source counts. */
export function undecidedBySource(inbox: readonly ItemRecord[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of inbox) counts.set(item.sourceId, (counts.get(item.sourceId) ?? 0) + 1);
  return counts;
}

/**
 * The sidebar: the traffic lights' row on top (52px, draggable, the hide button at its right), then
 * every scope in one list — Inbox · Queue · Agent, the Library's cuts, the most used tags, every
 * source with its health — and Settings pinned at the bottom, under the update notice when there is one.
 */
export function AppSidebar({ width, scope, onScope, inbox, queueCount, conversationCount, runningCount, tags, sources, onHide, onOpenSettings }: AppSidebarProps) {
  const [tagsOpen, setTagsOpen] = useState(false);
  const allTagsRef = useRef<HTMLDivElement>(null);
  const undecided = useMemo(() => undecidedBySource(inbox), [inbox]);
  const shownTags = tags.slice(0, TOP_TAGS);
  const selectedKey = scopeKey(scope);
  const choose = (key: string) => {
    if (key === ALL_TAGS_KEY) { setTagsOpen(true); return; }
    const next = scopeOfKey(key);
    if (next) onScope(next);
  };

  return (
    // Fixed to the remembered width so the content slides behind the edge while the panel animates instead of squashing.
    <div className="grid h-full min-h-0 grid-rows-[52px_minmax(0,1fr)_auto] overflow-hidden" style={{ width }}>
      <div className="titlebar-drag flex items-center justify-end pr-2">
        <ToolbarButton aria-label="Hide sidebar (⌘\\)" isSelected={false} onChange={onHide}><PanelLeft /></ToolbarButton>
      </div>
      <Sidebar aria-label="Scopes" selectedKeys={new Set([selectedKey])} onSelectionChange={(keys) => { const key = keys === "all" ? undefined : [...keys][0]; if (key !== undefined) choose(String(key)); }}>
        <SidebarSection>
          <SidebarItem id="inbox" icon={<InboxIcon />} label="Inbox" count={inbox.length} />
          <SidebarItem id="queue" icon={<ListOrdered />} label="Queue" count={queueCount} />
          <SidebarItem id="agent" icon={<Sparkles />} label="Agent" count={runningCount > 0 ? runningCount : conversationCount} busy={runningCount > 0} />
        </SidebarSection>
        <SidebarSection title="Library">
          {LIBRARY_CUTS.map((cut) => <SidebarItem key={cut} id={`library:${cut}`} icon={cut === "all" ? <BookOpen /> : <FileText />} label={cut === "all" ? "All" : CUT_LABELS[cut]} />)}
        </SidebarSection>
        <SidebarSection title="Tags">
          {shownTags.map((entry) => <SidebarItem key={entry.tag} id={`tag:${entry.tag}`} icon={<Tag />} label={entry.tag} count={entry.count} />)}
          <SidebarItem id={ALL_TAGS_KEY} ref={allTagsRef} label={tags.length ? "All tags…" : "No tags yet"} quiet isDisabled={tags.length === 0} />
        </SidebarSection>
        <SidebarSection title="Sources">
          {sources.map((source) => <SidebarItem key={source.id} id={`source:${source.id}`} health={sourceHealth(source).tone as SidebarHealth} label={source.title} count={undecided.get(source.id) ?? 0} />)}
          <SidebarItem id="sources" label="Manage sources…" quiet />
        </SidebarSection>
      </Sidebar>
      <div className="pb-2.5 pt-1">
        <UpdateBanner />
        <Button variant="quiet" size="sm" className="mx-2.5 w-[calc(100%-20px)] justify-start gap-2 px-2.5 text-[13px] font-medium text-label" onPress={onOpenSettings}><Icon of={SettingsIcon} size="md" className="text-label-2" />Settings</Button>
      </div>
      <Popover triggerRef={allTagsRef} isOpen={tagsOpen} onOpenChange={setTagsOpen} placement="right top" aria-label="All tags" className="max-h-[420px] w-[240px] overflow-auto p-1.5">
        <ul className="m-0 grid list-none gap-px p-0">
          {tags.map((entry) => (
            <li key={entry.tag}>
              <Button variant="quiet" size="sm" className="w-full justify-start gap-2 px-2.5 text-[13px]" onPress={() => { setTagsOpen(false); onScope({ kind: "tag", id: entry.tag }); }}>
                <span className="min-w-0 flex-1 truncate text-left">{entry.tag}</span><span className="tabular-nums text-label-3">{entry.count}</span>
              </Button>
            </li>
          ))}
        </ul>
      </Popover>
    </div>
  );
}
