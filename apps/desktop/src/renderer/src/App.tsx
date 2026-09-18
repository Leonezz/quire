import { useCallback, useEffect, useState } from "react";
import { BookOpen, Inbox as InboxIcon, ListOrdered, PanelLeft, Plus, Radio, Search as SearchIcon, Settings as SettingsIcon, Sparkles } from "lucide-react";
import { AskButton, Kbd, Search, Segment, Segmented, Sidebar, SidebarItem, SidebarSection, SplitGroup, SplitPanel, SplitSeparator, Toolbar, ToolbarButton, ToolbarGroup, ToolbarTitle, useSplitPanelRef, useSplitSizes, type Selection } from "@read/ui";
import { AddSheet } from "./AddSheet";
import { InboxView, type InboxGrouping } from "./InboxView";
import { QueueView } from "./QueueView";
import { SourcesView } from "./SourcesView";
import { LibraryView } from "./LibraryView";
import { SearchPalette } from "./SearchPalette";
import { SettingsSheet, type SettingsSection } from "./SettingsSheet";
import { AgentPanel } from "./AgentPanel";
import { InlineError } from "./ItemPreview";
import { useLists } from "./useLists";
import { useLibrary } from "./useLibrary";
import { loadPrefs, applyTheme } from "./readingPrefs";
import { read } from "./api";

type View = "inbox" | "queue" | "library" | "sources";
const titles: Record<View, string> = { inbox: "Inbox", queue: "Queue", library: "Library", sources: "Sources" };
const SIDEBAR_KEY = "read:layout:sidebar-collapsed";

function loadSidebarCollapsed(): boolean {
  try { return localStorage.getItem(SIDEBAR_KEY) === "1"; } catch { return false; }
}
function saveSidebarCollapsed(collapsed: boolean) {
  try { localStorage.setItem(SIDEBAR_KEY, collapsed ? "1" : "0"); } catch { /* storage may be unavailable; the sidebar simply starts open next time */ }
}

export function App() {
  const [view, setView] = useState<View>("inbox");
  const [askOpen, setAskOpen] = useState(false);
  const lists = useLists();
  const library = useLibrary();
  const [grouping, setGrouping] = useState<InboxGrouping>("date");
  const [inboxSelected, setInboxSelected] = useState<string | undefined>(undefined);
  const [queueSelected, setQueueSelected] = useState<string | undefined>(undefined);
  const [sourceSelected, setSourceSelected] = useState<string | undefined>(undefined);
  const [librarySelected, setLibrarySelected] = useState<Selection>(new Set());
  const [addOpen, setAddOpen] = useState(false);
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState<string | undefined>();
  const [searchOpen, setSearchOpen] = useState(false);
  const [settings, setSettings] = useState<{ open: boolean; section?: SettingsSection | undefined }>({ open: false });
  const [routeError, setRouteError] = useState<string | undefined>(undefined);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(loadSidebarCollapsed);
  const sidebarRef = useSplitPanelRef();
  const shellSizes = useSplitSizes("shell");

  // The reading theme applies to the whole window, whether or not a reader is open.
  useEffect(() => { applyTheme(loadPrefs().theme); }, []);
  const toggleSidebar = useCallback(() => {
    const panel = sidebarRef.current;
    if (!panel) return;
    // A panel collapsed since mount has no "most recent size" to expand to, so the remembered width is set outright.
    if (panel.isCollapsed()) panel.resize(shellSizes.sizeOf("sidebar", 236)); else panel.collapse();
  }, [sidebarRef, shellSizes]);
  const openSettings = useCallback((section?: SettingsSection) => setSettings({ open: true, section }), []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key === "n") { event.preventDefault(); setAddOpen(true); }
      if (event.key === "k") { event.preventDefault(); setSearchOpen(true); }
      if (event.key === ",") { event.preventDefault(); openSettings(); }
      if (event.key === "\\") { event.preventDefault(); toggleSidebar(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openSettings, toggleSidebar]);
  // ⌘J toggles the shell's Agent panel outside the Library; an open reader (listening on `document`, which fires first) takes it instead.
  useEffect(() => {
    if (view === "library") return;
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key !== "j" || event.defaultPrevented) return;
      event.preventDefault();
      setAskOpen((open) => !open);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view]);
  // The first row is selected once a list arrives, so Enter / k / q / e have something to act on.
  useEffect(() => { if (inboxSelected === undefined && lists.inbox[0]) setInboxSelected(lists.inbox[0].id); }, [lists.inbox, inboxSelected]);
  useEffect(() => { if (queueSelected === undefined && lists.queue[0]) setQueueSelected(lists.queue[0].id); }, [lists.queue, queueSelected]);
  useEffect(() => { if (sourceSelected === undefined && lists.sources[0]) setSourceSelected(lists.sources[0].id); }, [lists.sources, sourceSelected]);

  // Opening a material from elsewhere (search, a citation, "Open in Library") must show it, whatever the Library was filtered to.
  const showMaterial = (id: string) => { library.clearFilter(); setView("library"); setLibrarySelected(new Set([id])); };
  const submitUrl = async (url: string) => {
    setAddBusy(true); setAddError(undefined);
    const result = await read.openUrl(url);
    setAddBusy(false);
    if (!result.ok) { setAddError(result.message); return; }
    setAddOpen(false);
    await library.refresh();
    showMaterial(result.material.id);
  };
  const submitFile = async (file: File) => {
    setAddBusy(true); setAddError(undefined);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const result = await read.openFile({ name: file.name, mediaType: file.type, bytes });
    setAddBusy(false);
    if (!result.ok) { setAddOpen(true); setAddError(result.message); return; }
    setAddOpen(false);
    await library.refresh();
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

  // The orange dot on Sources: a source is failing right now; it clears with the next successful sync.
  const attention = lists.sources.some((source) => source.failureCount > 0);
  const sourcesLabel = `${lists.sources.length} ${lists.sources.length === 1 ? "source" : "sources"}`;
  const subtitle = view === "inbox" ? `${lists.inbox.length} unread · ${sourcesLabel}` : view === "queue" ? `${lists.queue.length} queued` : view === "sources" ? sourcesLabel : `${library.materials.length} ${library.materials.length === 1 ? "material" : "materials"}`;
  const shellError = lists.error ?? routeError;
  const inspectorOpen = askOpen && view !== "library";

  return (
    <SplitGroup id="shell" aria-label="Window" className="h-full p-3">
      {/* A collapsible panel mounted below its minimum starts collapsed: that is how the hidden sidebar comes back hidden. */}
      <SplitPanel id="sidebar" panelRef={sidebarRef} defaultSize={sidebarCollapsed ? 0 : shellSizes.sizeOf("sidebar", 236)} minSize={180} maxSize={320} collapsible collapsedSize={0}
        onResize={(size, id, previous) => {
          shellSizes.onResize("sidebar")(size, id, previous);
          // The mount report is a measurement in progress; the collapsed state follows real changes only.
          if (previous === undefined) return;
          const collapsed = size.inPixels === 0;
          setSidebarCollapsed(collapsed); saveSidebarCollapsed(collapsed);
        }}>
        <Sidebar aria-label="Sidebar" className="h-full titlebar-drag" selectedKeys={new Set([view])} onSelectionChange={(keys) => { const key = [...keys][0]; if (key) setView(key as View); }}>
          <SidebarSection title="Read">
            <SidebarItem id="inbox" icon={<InboxIcon />} label="Inbox" count={lists.inbox.length} />
            <SidebarItem id="queue" icon={<ListOrdered />} label="Queue" count={lists.queue.length} />
            <SidebarItem id="library" icon={<BookOpen />} label="Library" />
            <SidebarItem id="sources" icon={<Radio />} label="Sources" attention={attention} />
          </SidebarSection>
        </Sidebar>
      </SplitPanel>
      <SplitSeparator aria-label="Resize sidebar" hit={12} footprint={12} line="hover" className={sidebarCollapsed ? "invisible w-0" : ""} />
      <SplitPanel id="main" minSize={640}>
        <div className="grid h-full grid-rows-[56px_minmax(0,1fr)] gap-3">
          <Toolbar aria-label="Toolbar" className={`titlebar-drag ${sidebarCollapsed ? "pl-[92px]" : ""}`}>
            <ToolbarGroup><ToolbarButton aria-label={sidebarCollapsed ? "Show sidebar (⌘\\)" : "Hide sidebar (⌘\\)"} isSelected={false} onChange={toggleSidebar}><PanelLeft /></ToolbarButton></ToolbarGroup>
            <ToolbarTitle title={titles[view]} subtitle={subtitle} />
            <ToolbarGroup>
              {view === "inbox" ? <Segmented aria-label="Group by" selectedKeys={[grouping]} onSelectionChange={(keys) => { const key = [...keys][0]; if (key) setGrouping(key as InboxGrouping); }}><Segment id="date">Date</Segment><Segment id="source">Source</Segment></Segmented> : null}
              {view === "library" ? <Search aria-label="Filter the library" placeholder="Filter titles, authors, tags…" value={library.state.query} onChange={library.setQuery} className="h-8 w-[220px] text-[13px]" /> : null}
              <ToolbarButton aria-label="Add (⌘N)" isSelected={addOpen} onChange={(on) => setAddOpen(on)}><Plus /></ToolbarButton>
              <ToolbarButton aria-label="Search (⌘K)" isSelected={searchOpen} onChange={(on) => setSearchOpen(on)}><SearchIcon /></ToolbarButton>
              {view !== "library" ? <AskButton aria-label="Ask" isSelected={askOpen} onChange={setAskOpen}><Sparkles />Ask<Kbd>⌘J</Kbd></AskButton> : null}
              <ToolbarButton aria-label="Settings (⌘,)" isSelected={settings.open} onChange={(on) => { if (on) openSettings(); else setSettings({ open: false }); }}><SettingsIcon /></ToolbarButton>
            </ToolbarGroup>
          </Toolbar>

          <SplitGroup id="content" aria-label="Content" className="min-h-0">
            <SplitPanel id="view" minSize={480}>
              {view === "library" ? (
                <LibraryView library={library} selected={librarySelected} onSelectionChange={setLibrarySelected} onOpenLink={openLink} onOpenMaterial={showMaterial} onOpenSettings={() => openSettings("agent")} />
              ) : (
                <div className="flex h-full min-h-0 flex-col gap-3">
                  {shellError ? <InlineError title="The lists could not be loaded." message={shellError} /> : null}
                  {view === "inbox" ? <InboxView items={lists.inbox} grouping={grouping} selectedId={inboxSelected} onSelect={setInboxSelected} refresh={lists.refresh} onOpenLink={openLink} onOpenMaterial={showMaterial} /> : null}
                  {view === "queue" ? <QueueView items={lists.queue} selectedId={queueSelected} onSelect={setQueueSelected} refresh={lists.refresh} onOpenLink={openLink} onOpenMaterial={showMaterial} /> : null}
                  {view === "sources" ? <SourcesView sources={lists.sources} selectedId={sourceSelected} onSelect={setSourceSelected} refresh={lists.refresh} onOpenLink={openLink} /> : null}
                </div>
              )}
            </SplitPanel>
            {inspectorOpen ? (
              <>
                <SplitSeparator aria-label="Resize Agent panel" hit={12} footprint={12} line="hover" />
                <SplitPanel id="inspector" defaultSize={shellSizes.sizeOf("inspector", 360)} minSize={300} maxSize={520} onResize={shellSizes.onResize("inspector")}>
                  {/* The shell inspector is the Agent alone: one panel, so no tab strip. */}
                  <aside aria-label="Agent" className="glass flex h-full min-h-0 flex-col overflow-auto rounded-panel px-4 pb-4 pt-4">
                    <AgentPanel context={{ kind: "library" }} onOpenMaterial={showMaterial} onOpenLink={openLink} onOpenSettings={() => openSettings("agent")} />
                  </aside>
                </SplitPanel>
              </>
            ) : null}
          </SplitGroup>
        </div>
      </SplitPanel>
      <AddSheet open={addOpen} busy={addBusy} error={addError} onClose={() => { setAddOpen(false); setAddError(undefined); }} onSubmit={(url) => void submitUrl(url)} onSubscribed={(result) => void subscribed(result)} />
      <SearchPalette open={searchOpen} onOpenChange={setSearchOpen} onOpenMaterial={showMaterial} onOpenItem={(id) => void openItemHit(id)} />
      <SettingsSheet open={settings.open} section={settings.section} onClose={() => setSettings({ open: false })} />
    </SplitGroup>
  );
}
