import { useCallback, useEffect, useState } from "react";
import { BookOpen, Highlighter, Inbox as InboxIcon, List, ListOrdered, Plus, Radio, Search as SearchIcon, Sparkles, Text } from "lucide-react";
import { AskButton, Button, Inspector, InspectorPanel, InspectorSection, InspectorTab, InspectorTabs, ItemGroup, ItemList, ItemRow, Kbd, Segment, Segmented, Sidebar, SidebarItem, SidebarSection, Toolbar, ToolbarButton, ToolbarGroup, ToolbarTitle, type Key, type Selection } from "@read/ui";
import { MaterialReader } from "./MaterialReader";
import { ErrorBoundary } from "./ErrorBoundary";
import { AddSheet } from "./AddSheet";
import { InboxView, type InboxGrouping } from "./InboxView";
import { QueueView } from "./QueueView";
import { SourcesView } from "./SourcesView";
import { SearchPalette } from "./SearchPalette";
import { InlineError, panelClass } from "./ItemPreview";
import { useLists } from "./useLists";
import { timeOf } from "./format";
import type { MaterialSummary } from "../../shared/contracts";
import { read } from "./api";

type View = "inbox" | "queue" | "library" | "sources";
const titles: Record<View, string> = { inbox: "Inbox", queue: "Queue", library: "Library", sources: "Sources" };

export function App() {
  const [view, setView] = useState<View>("inbox");
  const [askOpen, setAskOpen] = useState(false);
  const [inspectorTab, setInspectorTab] = useState<Key>("contents");
  const lists = useLists();
  const [grouping, setGrouping] = useState<InboxGrouping>("date");
  const [inboxSelected, setInboxSelected] = useState<string | undefined>(undefined);
  const [queueSelected, setQueueSelected] = useState<string | undefined>(undefined);
  const [sourceSelected, setSourceSelected] = useState<string | undefined>(undefined);
  const [library, setLibrary] = useState<MaterialSummary[]>([]);
  const [librarySelected, setLibrarySelected] = useState<Selection>(new Set());
  const [addOpen, setAddOpen] = useState(false);
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState<string | undefined>();
  const [searchOpen, setSearchOpen] = useState(false);
  const [routeError, setRouteError] = useState<string | undefined>(undefined);

  const refreshLibrary = useCallback(async () => setLibrary(await read.listMaterials()), []);
  useEffect(() => { void refreshLibrary(); }, [refreshLibrary]);
  useEffect(() => read.onLibraryChanged(() => { void refreshLibrary(); }), [refreshLibrary]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key === "n") { event.preventDefault(); setAddOpen(true); }
      if (event.key === "k") { event.preventDefault(); setSearchOpen(true); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // The first row is selected once a list arrives, so Enter / q / e have something to act on.
  useEffect(() => { if (inboxSelected === undefined && lists.inbox[0]) setInboxSelected(lists.inbox[0].id); }, [lists.inbox, inboxSelected]);
  useEffect(() => { if (queueSelected === undefined && lists.queue[0]) setQueueSelected(lists.queue[0].id); }, [lists.queue, queueSelected]);
  useEffect(() => { if (sourceSelected === undefined && lists.sources[0]) setSourceSelected(lists.sources[0].id); }, [lists.sources, sourceSelected]);

  const showMaterial = (id: string) => { setView("library"); setLibrarySelected(new Set([id])); };
  const submitUrl = async (url: string) => {
    setAddBusy(true); setAddError(undefined);
    const result = await read.openUrl(url);
    setAddBusy(false);
    if (!result.ok) { setAddError(result.message); return; }
    setAddOpen(false);
    await refreshLibrary();
    showMaterial(result.material.id);
  };
  const submitFile = async (file: File) => {
    setAddBusy(true); setAddError(undefined);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const result = await read.openFile({ name: file.name, mediaType: file.type, bytes });
    setAddBusy(false);
    if (!result.ok) { setAddOpen(true); setAddError(result.message); return; }
    setAddOpen(false);
    await refreshLibrary();
    showMaterial(result.material.id);
  };
  const subscribed = async ({ source, added }: { source: { id: string }; added: number }) => {
    setAddOpen(false);
    await lists.refresh();
    if (added > 0) { setView("inbox"); return; }
    setSourceSelected(source.id); setView("sources");
  };
  const openItemHit = async (id: string) => {
    setRouteError(undefined);
    try {
      const item = await read.getItem(id);
      if (!item) { setRouteError("That item is no longer in the inbox."); return; }
      if (item.queuedAt) { setQueueSelected(id); setView("queue"); return; }
      setInboxSelected(id); setView("inbox");
    } catch (cause: unknown) { setRouteError(cause instanceof Error ? cause.message : "Could not open that item."); }
  };
  useEffect(() => {
    const over = (event: DragEvent) => { event.preventDefault(); };
    const drop = (event: DragEvent) => {
      event.preventDefault();
      const file = event.dataTransfer?.files?.[0];
      if (file) void submitFile(file);
    };
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => { window.removeEventListener("dragover", over); window.removeEventListener("drop", drop); };
  });
  const openLink = (url: string) => { window.open(url, "_blank", "noopener"); };

  const attention = lists.sources.some((source) => source.failureCount > 0);
  const subtitle = view === "inbox" ? `${lists.inbox.length} unread · ${lists.sources.length} ${lists.sources.length === 1 ? "source" : "sources"}` : view === "queue" ? `${lists.queue.length} queued` : view === "sources" ? `${lists.sources.length} ${lists.sources.length === 1 ? "source" : "sources"}` : undefined;
  const shellError = lists.error ?? routeError;

  return (
    <div className={view === "library" ? "grid h-full grid-cols-[236px_420px_minmax(0,1fr)] grid-rows-[56px_minmax(0,1fr)] gap-3 p-3" : askOpen ? "grid h-full grid-cols-[236px_minmax(0,1fr)_360px] grid-rows-[56px_minmax(0,1fr)] gap-3 p-3" : "grid h-full grid-cols-[236px_minmax(0,1fr)] grid-rows-[56px_minmax(0,1fr)] gap-3 p-3"}>
      <Sidebar aria-label="Sidebar" className="row-span-2 titlebar-drag" selectedKeys={new Set([view])} onSelectionChange={(keys) => { const key = [...keys][0]; if (key) setView(key as View); }}>
        <SidebarSection title="Read">
          <SidebarItem id="inbox" icon={<InboxIcon />} label="Inbox" count={lists.inbox.length} />
          <SidebarItem id="queue" icon={<ListOrdered />} label="Queue" count={lists.queue.length} />
          <SidebarItem id="library" icon={<BookOpen />} label="Library" />
          <SidebarItem id="sources" icon={<Radio />} label="Sources" attention={attention} />
        </SidebarSection>
      </Sidebar>

      <Toolbar aria-label="Toolbar" className={`titlebar-drag col-start-2 ${view === "library" ? "col-end-3" : "col-end-[-1]"}`}>
        <ToolbarGroup><ToolbarButton aria-label="Toggle sidebar"><List /></ToolbarButton></ToolbarGroup>
        <ToolbarTitle title={titles[view]} subtitle={subtitle} />
        <ToolbarGroup>
          {view === "inbox" ? <Segmented aria-label="Group by" selectedKeys={[grouping]} onSelectionChange={(keys) => { const key = [...keys][0]; if (key) setGrouping(key as InboxGrouping); }}><Segment id="date">Date</Segment><Segment id="source">Source</Segment></Segmented> : null}
          <ToolbarButton aria-label="Add (⌘N)" isSelected={addOpen} onChange={(on) => setAddOpen(on)}><Plus /></ToolbarButton>
          <ToolbarButton aria-label="Search (⌘K)" isSelected={searchOpen} onChange={(on) => setSearchOpen(on)}><SearchIcon /></ToolbarButton>
          {view !== "library" ? <AskButton aria-label="Ask" isSelected={askOpen} onChange={(open) => { setAskOpen(open); if (open) setInspectorTab("agent"); }}><Sparkles />Ask<Kbd>⌘J</Kbd></AskButton> : null}
        </ToolbarGroup>
      </Toolbar>

      {view === "library" ? (
        <>
          <section className={`col-start-2 row-start-2 flex min-h-0 flex-col overflow-hidden ${panelClass}`}>
            <ItemGroup>Kept · {library.length}</ItemGroup>
            {library.length ? (
              <ItemList aria-label="Library" items={library} selectionMode="single" selectionBehavior="replace" selectedKeys={librarySelected} onSelectionChange={setLibrarySelected} className="flex-1">
                {(item) => <ItemRow id={item.id} title={item.title} source={(item.origin === "file" ? "Local file" : new URL(item.url).hostname)} time={timeOf(item.fetchedAt)} minutes={item.readingMinutes} state="read" signals={item.mediaType === "application/pdf" ? ["pdf"] : []} {...(item.quality.safety === "degraded_plaintext" ? { tag: "summary" as const } : {})} />}
              </ItemList>
            ) : (
              <div className="grid flex-1 place-items-center px-6 text-center text-label-2"><div><strong className="mb-1.5 block text-[16px] font-semibold text-label">Nothing kept yet.</strong><span className="text-[13px]">Press ⌘N and paste a page URL to read it here.</span></div></div>
            )}
          </section>
          <section className="col-start-3 row-start-1 row-span-2 flex min-h-0 flex-col">
            {(() => {
            const chosen = library.find((item) => librarySelected !== "all" && librarySelected.has(item.id));
            return chosen ? (
              <ErrorBoundary key={chosen.id} label="The reader"><MaterialReader id={chosen.id} onOpenLink={openLink} /></ErrorBoundary>
            ) : <div className={`grid flex-1 place-items-center text-center text-label-2 ${panelClass}`}><div><strong className="mb-1.5 block text-[18px] font-semibold text-label">Nothing selected</strong><span className="text-[13px]">Select something you kept.</span></div></div>;
            })()}
          </section>
        </>
      ) : (
        <div className="flex min-h-0 flex-col gap-3">
          {shellError ? <InlineError title="The lists could not be loaded." message={shellError} /> : null}
          {view === "inbox" ? <InboxView items={lists.inbox} grouping={grouping} selectedId={inboxSelected} onSelect={setInboxSelected} refresh={lists.refresh} onOpenLink={openLink} /> : null}
          {view === "queue" ? <QueueView items={lists.queue} selectedId={queueSelected} onSelect={setQueueSelected} refresh={lists.refresh} onOpenLink={openLink} /> : null}
          {view === "sources" ? <SourcesView sources={lists.sources} selectedId={sourceSelected} onSelect={setSourceSelected} refresh={lists.refresh} onOpenLink={openLink} /> : null}
        </div>
      )}

      {askOpen && view !== "library" ? (
        <Inspector aria-label="Inspector" selectedKey={inspectorTab} onSelectionChange={setInspectorTab}>
          <InspectorTabs>
            <InspectorTab id="contents"><Text />Contents</InspectorTab>
            <InspectorTab id="notes"><Highlighter />Notes</InspectorTab>
            <InspectorTab id="agent"><Sparkles />Agent</InspectorTab>
          </InspectorTabs>
          <InspectorPanel id="contents"><InspectorSection title="Contents"><p className="text-[13.5px] text-label-2">Open an article to see its outline.</p></InspectorSection></InspectorPanel>
          <InspectorPanel id="notes"><InspectorSection title="Notes"><p className="text-[13.5px] text-label-2">No notes yet.</p></InspectorSection></InspectorPanel>
          <InspectorPanel id="agent">
            <InspectorSection title="Context"><span className="inline-flex h-[26px] items-center gap-1.5 rounded-pill bg-content px-2.5 text-[12.5px] font-medium shadow-[0_0_0_1px_var(--separator)]">{view === "inbox" && inboxSelected ? "this item" : "Library index"}</span></InspectorSection>
            <InspectorSection title="Ask"><div className="flex flex-wrap gap-1.5"><Button size="sm">Brief these</Button><Button size="sm">Find material about…</Button><Button size="sm">What have I read about…</Button></div></InspectorSection>
            <p className="text-[11.5px] text-label-3">Connect Codex in Settings to use Ask. Reading, queueing and notes work without it.</p>
          </InspectorPanel>
        </Inspector>
      ) : null}
      <AddSheet open={addOpen} busy={addBusy} error={addError} onClose={() => { setAddOpen(false); setAddError(undefined); }} onSubmit={(url) => void submitUrl(url)} onSubscribed={(result) => void subscribed(result)} />
      <SearchPalette open={searchOpen} onOpenChange={setSearchOpen} onOpenMaterial={showMaterial} onOpenItem={(id) => void openItemHit(id)} />
    </div>
  );
}
