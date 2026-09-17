import { useCallback, useEffect, useState } from "react";
import { BookOpen, Highlighter, Inbox as InboxIcon, List, ListOrdered, Plus, Radio, Search as SearchIcon, Sparkles, Text } from "lucide-react";
import { AskButton, Button, Inspector, InspectorPanel, InspectorSection, InspectorTab, InspectorTabs, ItemGroup, ItemList, ItemRow, Kbd, Segment, Segmented, Sidebar, SidebarItem, SidebarSection, Toolbar, ToolbarButton, ToolbarGroup, ToolbarTitle, type Key, type Selection } from "@read/ui";
import { items, signalsOf, timeOf } from "./fixtures";
import { ReaderView } from "./ReaderView";
import { PdfReaderView } from "./PdfReaderView";
import { ErrorBoundary } from "./ErrorBoundary";
import { AddSheet } from "./AddSheet";
import type { MaterialRecord, MaterialSummary } from "../../shared/contracts";
import { read } from "./api";

type View = "inbox" | "queue" | "library" | "sources";
const titles: Record<View, string> = { inbox: "Inbox", queue: "Queue", library: "Library", sources: "Sources" };

export function App() {
  const [view, setView] = useState<View>("inbox");
  const [selected, setSelected] = useState<Selection>(new Set(["a"]));
  const [askOpen, setAskOpen] = useState(false);
  const [inspectorTab, setInspectorTab] = useState<Key>("contents");
  const current = items.find((item) => selected !== "all" && selected.has(item.id));
  const unread = items.filter((item) => item.readState === "unread").length;
  const [library, setLibrary] = useState<MaterialSummary[]>([]);
  const [librarySelected, setLibrarySelected] = useState<Selection>(new Set());
  const [reading, setReading] = useState<MaterialRecord | undefined>();
  const [addOpen, setAddOpen] = useState(false);
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState<string | undefined>();

  const refreshLibrary = useCallback(async () => setLibrary(await read.listMaterials()), []);
  useEffect(() => { void refreshLibrary(); }, [refreshLibrary]);
  useEffect(() => read.onLibraryChanged(() => { void refreshLibrary(); }), [refreshLibrary]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if ((event.metaKey || event.ctrlKey) && event.key === "n") { event.preventDefault(); setAddOpen(true); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const submitUrl = async (url: string) => {
    setAddBusy(true); setAddError(undefined);
    const result = await read.openUrl(url);
    setAddBusy(false);
    if (!result.ok) { setAddError(result.message); return; }
    setAddOpen(false);
    await refreshLibrary();
    setView("library");
    setReading(result.material);
  };
  const submitFile = async (file: File) => {
    setAddBusy(true); setAddError(undefined);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const result = await read.openFile({ name: file.name, mediaType: file.type, bytes });
    setAddBusy(false);
    if (!result.ok) { setAddOpen(true); setAddError(result.message); return; }
    setAddOpen(false);
    await refreshLibrary();
    setView("library");
    setReading(result.material);
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
  const openMaterial = async (id: string) => {
    const material = await read.getMaterial(id);
    if (material) setReading(material);
  };
  const openLink = (url: string) => { window.open(url, "_blank", "noopener"); };

  // The sheet lives outside the view switch so a dropped file (and its error) is visible while reading too.
  const addSheet = <AddSheet open={addOpen} busy={addBusy} error={addError} onClose={() => { setAddOpen(false); setAddError(undefined); }} onSubmit={(url) => void submitUrl(url)} />;
  if (reading) return <><ErrorBoundary key={reading.id} label="The reader" onReset={() => setReading(undefined)}>{reading.pdf ? <PdfReaderView material={reading} onBack={() => setReading(undefined)} /> : <ReaderView material={reading} onBack={() => setReading(undefined)} onOpenLink={openLink} />}</ErrorBoundary>{addSheet}</>;

  return (
    <div className={askOpen ? "grid h-full grid-cols-[236px_minmax(0,1fr)_360px] grid-rows-[56px_minmax(0,1fr)] gap-3 p-3" : "grid h-full grid-cols-[236px_minmax(0,1fr)] grid-rows-[56px_minmax(0,1fr)] gap-3 p-3"}>
      <Sidebar aria-label="Sidebar" className="row-span-2 titlebar-drag" selectedKeys={new Set([view])} onSelectionChange={(keys) => { const key = [...keys][0]; if (key) setView(key as View); }}>
        <SidebarSection title="Read">
          <SidebarItem id="inbox" icon={<InboxIcon />} label="Inbox" count={unread} />
          <SidebarItem id="queue" icon={<ListOrdered />} label="Queue" count={12} />
          <SidebarItem id="library" icon={<BookOpen />} label="Library" />
          <SidebarItem id="sources" icon={<Radio />} label="Sources" attention />
        </SidebarSection>
      </Sidebar>

      <Toolbar aria-label="Toolbar" className="titlebar-drag col-start-2 col-end-[-1]">
        <ToolbarGroup><ToolbarButton aria-label="Toggle sidebar"><List /></ToolbarButton></ToolbarGroup>
        <ToolbarTitle title={titles[view]} subtitle={view === "inbox" ? `${unread} unread · 9 sources` : undefined} />
        <ToolbarGroup>
          {view === "inbox" ? <Segmented aria-label="Group by" defaultSelectedKeys={["date"]}><Segment id="date">Date</Segment><Segment id="source">Source</Segment></Segmented> : null}
          <ToolbarButton aria-label="Add (⌘N)" isSelected={addOpen} onChange={(on) => setAddOpen(on)}><Plus /></ToolbarButton>
          <ToolbarButton aria-label="Search"><SearchIcon /></ToolbarButton>
          <AskButton aria-label="Ask" isSelected={askOpen} onChange={(open) => { setAskOpen(open); if (open) setInspectorTab("agent"); }}><Sparkles />Ask<Kbd>⌘J</Kbd></AskButton>
        </ToolbarGroup>
      </Toolbar>

      <main className="grid min-h-0 grid-cols-[420px_minmax(0,1fr)] overflow-hidden rounded-panel bg-content shadow-[0_0_0_1px_var(--separator-soft),0_6px_20px_rgba(15,17,21,.04)]">
        {view === "library" ? (
          <div className="flex min-h-0 flex-col border-r border-separator-soft">
            <ItemGroup>Kept · {library.length}</ItemGroup>
            {library.length ? (
              <ItemList aria-label="Library" items={library} selectionMode="single" selectedKeys={librarySelected} onSelectionChange={setLibrarySelected} onAction={(key) => void openMaterial(String(key))} className="flex-1">
                {(item) => <ItemRow id={item.id} title={item.title} source={(item.origin === "file" ? "Local file" : new URL(item.url).hostname)} time={timeOf(item.fetchedAt)} minutes={item.readingMinutes} state="read" signals={item.mediaType === "application/pdf" ? ["pdf"] : []} {...(item.quality.safety === "degraded_plaintext" ? { tag: "summary" as const } : {})} />}
              </ItemList>
            ) : (
              <div className="grid flex-1 place-items-center px-6 text-center text-label-2"><div><strong className="mb-1.5 block text-[16px] font-semibold text-label">Nothing kept yet.</strong><span className="text-[13px]">Press ⌘N and paste a page URL to read it here.</span></div></div>
            )}
          </div>
        ) : (
        <div className="flex min-h-0 flex-col border-r border-separator-soft">
          <ItemGroup>Today</ItemGroup>
          <ItemList aria-label={titles[view]} items={items} selectionMode="single" selectedKeys={selected} onSelectionChange={setSelected} className="flex-1">
            {(item) => (
              <ItemRow
                id={item.id}
                title={item.title}
                source={item.sourceTitle}
                time={timeOf(item.publishedAt)}
                gist={item.gist}
                minutes={item.readingMinutes}
                signals={signalsOf(item)}
                state={item.readState}
                {...(item.introducedBy ? { tag: "agent" as const } : item.summaryOnly ? { tag: "summary" as const } : {})}
              />
            )}
          </ItemList>
        </div>
        )}
        <section className="flex min-h-0 flex-col overflow-auto">
          {view === "library" ? (() => {
            const chosen = library.find((item) => librarySelected !== "all" && librarySelected.has(item.id));
            return chosen ? (
              <>
                <div className="px-9 pt-7">
                  <div className="flex items-center gap-2 text-[12.5px] text-label-2">{(chosen.origin === "file" ? "Local file" : new URL(chosen.url).hostname)}<span className="rounded-pill bg-fill px-2 py-px text-[11.5px] font-medium">{chosen.quality.safety === "degraded_plaintext" ? "plain text only" : "web extract"}</span></div>
                  <h1 className="mb-1.5 mt-2.5 text-[24px] font-bold leading-[29px] tracking-[-.02em] text-balance">{chosen.title}</h1>
                  <div className="flex flex-wrap gap-x-3 text-[12.5px] text-label-2">{chosen.byline ? <span>{chosen.byline}</span> : null}<span>{chosen.readingMinutes} min</span><span>kept {timeOf(chosen.fetchedAt)}</span></div>
                </div>
                <div className="flex items-center gap-2 px-9 py-[18px]"><Button variant="primary" onPress={() => void openMaterial(chosen.id)}>Open <Kbd>↵</Kbd></Button></div>
              </>
            ) : <div className="grid flex-1 place-items-center text-center text-label-2"><div><strong className="mb-1.5 block text-[18px] font-semibold text-label">Nothing selected</strong><span className="text-[13px]">Select something you kept.</span></div></div>;
          })() : current ? (
            <>
              <div className="px-9 pt-7">
                <div className="flex items-center gap-2 text-[12.5px] text-label-2">{current.sourceTitle}<span className="rounded-pill bg-fill px-2 py-px text-[11.5px] font-medium">feed full text</span></div>
                <h1 className="mb-1.5 mt-2.5 text-[24px] font-bold leading-[29px] tracking-[-.02em] text-balance">{current.title}</h1>
                <div className="flex flex-wrap gap-x-3 text-[12.5px] text-label-2"><span>{timeOf(current.publishedAt)}</span><span>{current.readingMinutes} min</span></div>
              </div>
              <div className="flex items-center gap-2 px-9 py-[18px]">
                <Button variant="primary">Read now <Kbd>↵</Kbd></Button>
                <Button>Queue <Kbd>q</Kbd></Button>
                <Button variant="quiet">Dismiss <Kbd>e</Kbd></Button>
                <span className="ml-auto text-[11.5px] text-label-3">Previewing does not mark it read</span>
              </div>
              <div className="max-w-[752px] px-9 pb-10"><p className="text-[16px] leading-[1.6] text-label">{current.gist}</p></div>
            </>
          ) : (
            <div className="grid flex-1 place-items-center text-center text-label-2"><div><strong className="mb-1.5 block text-[18px] font-semibold text-label">Nothing selected</strong><span className="text-[13px]">Select an item to preview it.</span></div></div>
          )}
        </section>
      </main>

      {askOpen ? (
        <Inspector aria-label="Inspector" selectedKey={inspectorTab} onSelectionChange={setInspectorTab}>
          <InspectorTabs>
            <InspectorTab id="contents"><Text />Contents</InspectorTab>
            <InspectorTab id="notes"><Highlighter />Notes</InspectorTab>
            <InspectorTab id="agent"><Sparkles />Agent</InspectorTab>
          </InspectorTabs>
          <InspectorPanel id="contents"><InspectorSection title="Contents"><p className="text-[13.5px] text-label-2">Open an article to see its outline.</p></InspectorSection></InspectorPanel>
          <InspectorPanel id="notes"><InspectorSection title="Notes"><p className="text-[13.5px] text-label-2">No notes yet.</p></InspectorSection></InspectorPanel>
          <InspectorPanel id="agent">
            <InspectorSection title="Context"><span className="inline-flex h-[26px] items-center gap-1.5 rounded-pill bg-content px-2.5 text-[12.5px] font-medium shadow-[0_0_0_1px_var(--separator)]">{current ? "this item" : "Library index"}</span></InspectorSection>
            <InspectorSection title="Ask"><div className="flex flex-wrap gap-1.5"><Button size="sm">Brief these</Button><Button size="sm">Find material about…</Button><Button size="sm">What have I read about…</Button></div></InspectorSection>
            <p className="text-[11.5px] text-label-3">Connect Codex in Settings to use Ask. Reading, queueing and notes work without it.</p>
          </InspectorPanel>
        </Inspector>
      ) : null}
      {addSheet}
    </div>
  );
}
