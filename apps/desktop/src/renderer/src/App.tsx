import { useCallback, useEffect, useMemo, useState } from "react";
import { Panel, SplitGroup, SplitPanel, SplitSeparator, useSplitPanelRef, useSplitSizes, type Selection } from "@read/ui";
import type { AgentContext } from "../../shared/contracts";
import { AddSheet } from "./AddSheet";
import { AgentPanel } from "./AgentPanel";
import { AgentView } from "./AgentView";
import { AppSidebar } from "./AppSidebar";
import { ListToolbar, ShellActions } from "./AppToolbar";
import type { ShellSlots } from "./ContentPane";
import { InboxView } from "./InboxView";
import { LibraryView } from "./LibraryView";
import { QueueView } from "./QueueView";
import { SearchPalette } from "./SearchPalette";
import { SettingsSheet, type SettingsSection } from "./SettingsSheet";
import { SourcesView } from "./SourcesView";
import { read } from "./api";
import { isTypingTarget } from "./format";
import { applyTheme, loadPrefs } from "./readingPrefs";
import { useAgentSessions } from "./useAgentSessions";
import { useLibrary, type LibraryFocus } from "./useLibrary";
import { useLists } from "./useLists";
import { CUT_LABELS, scopeFamily, useScope, type Scope } from "./useScope";

const SIDEBAR_KEY = "read:layout:sidebar-collapsed";
const SIDEBAR_DEFAULT = 220;
const LIBRARY_CONTEXT: AgentContext = { kind: "library" };

function loadSidebarCollapsed(): boolean {
  try { return localStorage.getItem(SIDEBAR_KEY) === "1"; } catch { return false; }
}
function saveSidebarCollapsed(collapsed: boolean) {
  try { localStorage.setItem(SIDEBAR_KEY, collapsed ? "1" : "0"); } catch { /* storage may be unavailable; the sidebar simply starts open next time */ }
}
/** The part of the scope the Library answers to. */
function focusOf(scope: Scope): LibraryFocus {
  if (scope.kind === "library") return { cut: scope.id, tag: undefined };
  if (scope.kind === "tag") return { cut: "all", tag: scope.id };
  return { cut: "all", tag: undefined };
}

export function App() {
  const [scope, setScope] = useScope();
  const [askOpen, setAskOpen] = useState(false);
  const lists = useLists();
  const focus = useMemo(() => focusOf(scope), [scope]);
  const library = useLibrary(focus);
  const agentSessions = useAgentSessions();
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
    if (panel.isCollapsed()) panel.resize(shellSizes.sizeOf("sidebar", SIDEBAR_DEFAULT)); else panel.collapse();
  }, [sidebarRef, shellSizes]);
  const openSettings = useCallback((section?: SettingsSection) => setSettings({ open: true, section }), []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Esc closes the shell's Agent panel; a reader (listening on `document`, which fires first) closes its own panel instead.
      if (event.key === "Escape" && !event.defaultPrevented && askOpen && !isTypingTarget(event.target)) { setAskOpen(false); return; }
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key === "n") { event.preventDefault(); setAddOpen(true); }
      if (event.key === "k") { event.preventDefault(); setSearchOpen(true); }
      if (event.key === ",") { event.preventDefault(); openSettings(); }
      if (event.key === "\\") { event.preventDefault(); toggleSidebar(); }
      if (event.key.toLowerCase() === "j" && event.shiftKey) { event.preventDefault(); setScope({ kind: "agent" }); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [askOpen, openSettings, setScope, toggleSidebar]);
  // ⌘J toggles the shell's Agent panel (the Library context); an open reader (listening on `document`, which fires
  // first) takes it for its material instead. In the Agent scope the conversation is the whole pane: ⌘J focuses its composer.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key !== "j" || event.shiftKey || event.defaultPrevented) return;
      event.preventDefault();
      if (scope.kind === "agent") { document.querySelector<HTMLTextAreaElement>('section[aria-label="Conversation"] textarea')?.focus(); return; }
      setAskOpen((open) => !open);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [scope.kind]);

  // A source scope is that source's Inbox.
  const inboxItems = useMemo(() => (scope.kind === "source" ? lists.inbox.filter((item) => item.sourceId === scope.id) : lists.inbox), [lists.inbox, scope]);
  // The first row is selected once a list arrives (or the selection left the visible list), so Enter / k / q / e have something to act on.
  useEffect(() => { if (inboxSelected === undefined || !inboxItems.some((item) => item.id === inboxSelected)) setInboxSelected(inboxItems[0]?.id); }, [inboxItems, inboxSelected]);
  useEffect(() => { if (queueSelected === undefined && lists.queue[0]) setQueueSelected(lists.queue[0].id); }, [lists.queue, queueSelected]);
  useEffect(() => { if (sourceSelected === undefined && lists.sources[0]) setSourceSelected(lists.sources[0].id); }, [lists.sources, sourceSelected]);

  // Opening a material from elsewhere (search, a citation, "Open in Library") must show it, whatever the Library was narrowed to.
  const showMaterial = useCallback((id: string) => { library.setQuery(""); setScope({ kind: "library", id: "all" }); setLibrarySelected(new Set([id])); }, [library, setScope]);
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
    if (added > 0) { setScope({ kind: "source", id: source.id }); return; }
    setSourceSelected(source.id); setScope({ kind: "sources" });
  };
  const openItemHit = async (id: string) => {
    setRouteError(undefined);
    try {
      const item = await read.getItem(id);
      if (!item) { setRouteError("That item is no longer in the inbox."); return; }
      if (item.queuedAt) { setQueueSelected(id); setScope({ kind: "queue" }); return; }
      setInboxSelected(id); setScope({ kind: "inbox" });
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

  const libraryScope = scope.kind === "library" || scope.kind === "tag";
  const source = scope.kind === "source" ? lists.sources.find((entry) => entry.id === scope.id) : undefined;
  const heading = (() => {
    switch (scope.kind) {
      case "inbox": return { title: "Inbox", count: inboxItems.length };
      case "queue": return { title: "Queue", count: lists.queue.length };
      case "agent": return { title: "Agent", count: agentSessions.sessions.length };
      case "sources": return { title: "Sources", count: lists.sources.length };
      case "source": return { title: source?.title ?? "Source", count: inboxItems.length };
      case "library": return { title: CUT_LABELS[scope.id], count: library.materials.length };
      case "tag": return { title: scope.id, count: library.materials.length };
    }
  })();
  const shellError = lists.error ?? routeError;
  const shell: ShellSlots = {
    listToolbar: <ListToolbar title={heading.title} count={heading.count} inset={sidebarCollapsed} onShowSidebar={toggleSidebar}
      search={libraryScope ? { value: library.query, onChange: library.setQuery } : undefined} sort={libraryScope ? { value: library.sort, onChange: library.setSort } : undefined} />,
    trailing: <ShellActions addOpen={addOpen} onAdd={setAddOpen} searchOpen={searchOpen} onSearch={setSearchOpen} />,
    // The shell's Agent (the Library context) stands wherever no reader with its own panel is open; the Agent scope is the conversation itself.
    agentPanel: askOpen ? (
      <Panel title="Agent" onClose={() => setAskOpen(false)} className="h-full">
        <AgentPanel context={LIBRARY_CONTEXT} onOpenMaterial={showMaterial} onOpenLink={openLink} onOpenSettings={() => openSettings("agent")} />
      </Panel>
    ) : undefined,
  };
  const view = (() => {
    switch (scope.kind) {
      case "inbox": case "source":
        return <InboxView items={inboxItems} selectedId={inboxSelected} onSelect={setInboxSelected} refresh={lists.refresh} onOpenLink={openLink} onOpenMaterial={showMaterial} shell={shell} error={shellError}
          empty={scope.kind === "source" ? "Nothing undecided from this source." : "Inbox zero — sources bring new items here; ⌘N adds one."} />;
      case "queue":
        return <QueueView items={lists.queue} selectedId={queueSelected} onSelect={setQueueSelected} refresh={lists.refresh} onOpenLink={openLink} onOpenMaterial={showMaterial} shell={shell} error={shellError} />;
      case "library": case "tag":
        return <LibraryView library={library} selected={librarySelected} onSelectionChange={setLibrarySelected} onOpenLink={openLink} onOpenMaterial={showMaterial} onOpenSettings={() => openSettings("agent")} shell={shell} narrowed={scope.kind === "tag" || scope.id !== "all"} />;
      case "agent":
        return <AgentView sessions={agentSessions} onOpenMaterial={showMaterial} onOpenLink={openLink} onOpenSettings={() => openSettings("agent")} shell={shell} />;
      case "sources":
        return <SourcesView sources={lists.sources} selectedId={sourceSelected} onSelect={setSourceSelected} refresh={lists.refresh} onOpenLink={openLink} onAdd={() => setAddOpen(true)} shell={shell} />;
    }
  })();

  return (
    <SplitGroup id="shell" aria-label="Window" className="h-full">
      {/* A collapsible panel mounted below its minimum starts collapsed: that is how the hidden sidebar comes back hidden. */}
      <SplitPanel id="sidebar" panelRef={sidebarRef} defaultSize={sidebarCollapsed ? 0 : shellSizes.sizeOf("sidebar", SIDEBAR_DEFAULT)} minSize={180} maxSize={320} collapsible collapsedSize={0} className="overflow-hidden"
        onResize={(size, id, previous) => {
          shellSizes.onResize("sidebar")(size, id, previous);
          // The mount report is a measurement in progress; the collapsed state follows real changes only.
          if (previous === undefined) return;
          const collapsed = size.inPixels === 0;
          setSidebarCollapsed(collapsed); saveSidebarCollapsed(collapsed);
        }}>
        <AppSidebar scope={scope} onScope={setScope} inbox={lists.inbox} queueCount={lists.queue.length} conversationCount={agentSessions.sessions.length} tags={library.tags} sources={lists.sources} onHide={toggleSidebar} onOpenSettings={() => openSettings()} />
      </SplitPanel>
      {/* With the sidebar hidden the separator takes no room, so the list segment starts at the window's edge. */}
      <SplitSeparator aria-label="Resize sidebar" hit={sidebarCollapsed ? 0 : 10} footprint={sidebarCollapsed ? 0 : 1} line="always" className={sidebarCollapsed ? "invisible" : ""} />
      <SplitPanel id="main" minSize={640}>
        {/* Keyed by family: each family keeps its own list width, applied when its group mounts. */}
        <SplitGroup key={scopeFamily(scope)} id="content" aria-label="Content" className="h-full min-h-0">
          {view}
        </SplitGroup>
      </SplitPanel>
      <AddSheet open={addOpen} busy={addBusy} error={addError} onClose={() => { setAddOpen(false); setAddError(undefined); }} onSubmit={(url) => void submitUrl(url)} onSubscribed={(result) => void subscribed(result)} />
      <SearchPalette open={searchOpen} onOpenChange={setSearchOpen} onOpenMaterial={showMaterial} onOpenItem={(id) => void openItemHit(id)} />
      <SettingsSheet open={settings.open} section={settings.section} onClose={() => setSettings({ open: false })} />
    </SplitGroup>
  );
}
