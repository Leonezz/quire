import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, Highlighter, Info, List, Sparkles } from "lucide-react";
import { AskButton, Kbd, SplitGroup, SplitPanel, SplitSeparator, TocRail, Toolbar, ToolbarButton, ToolbarGroup, ToolbarTitle, useSplitSizes } from "@read/ui";
import { PdfCanvasViewer, parsePdfRegionsLocator, pdfReadingProgress, pdfRegionLocatorForSelection, pdfSelectionText, usePdfReaderStateMemory, type PdfCanvasViewerHandle, type PdfOutlineEntry, type PdfReaderState, type PdfRegionOverlay } from "@read/reader-pdf";
import { ANNOTATION_COLORS, citationFor, useAnnotations } from "./annotations";
import type { NoteDraft } from "./NotesPanel";
import { ReaderInspector, type ReaderTab } from "./ReaderInspector";
import { hostLabel } from "./ArtifactLineage";
import type { ReaderProps } from "./ReaderView";
import { SelectionToolbar, type SelectionCapture } from "./SelectionToolbar";
import type { AgentContext, Annotation } from "../../shared/contracts";
import { read } from "./api";
import { ReadingSettings } from "./ReadingSettings";
import { useReadingPrefs } from "./readingPrefs";

type Loaded = { status: "loading" } | { status: "ready"; url: string } | { status: "error"; message: string };

/** PDF reading: the same toolbar contract as the article reader, the pages rendered by pdf.js. */
export function PdfReaderView({ material, onBack, onOpenLink, onOpenMaterial, onProgress, onMaterialSaved, onOpenSettings, embedded = false }: ReaderProps) {
  const pdf = material.pdf;
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  const [prefs, setPrefs] = useReadingPrefs();
  const [progress, setProgress] = useState(0);
  const [inspectorTab, setInspectorTab] = useState<ReaderTab | null>(null);
  const sizes = useSplitSizes("reader");
  const { annotations, error: annotationsError, add, update, remove } = useAnnotations(material.id);
  const [noteDraft, setNoteDraft] = useState<NoteDraft | null>(null);
  const [activeAnnotation, setActiveAnnotation] = useState<string | undefined>(undefined);
  const [asked, setAsked] = useState<SelectionCapture | null>(null);
  const agentContext: AgentContext = asked ? { kind: "selection", materialId: material.id, quote: asked.quote, locator: asked.locator } : { kind: "material", materialId: material.id };
  const mainRef = useRef<HTMLElement>(null);
  const [outline, setOutline] = useState<readonly PdfOutlineEntry[]>([]);
  const [page, setPage] = useState(1);
  const [tocPinned, setTocPinned] = useState(false);
  const viewerRef = useRef<PdfCanvasViewerHandle>(null);
  const identity = `${material.id}:pdf`;
  const { initialState, remember } = usePdfReaderStateMemory(identity, pdf?.pages ?? 0);
  const urlRef = useRef<string | undefined>(undefined);

  // The bytes cross the bridge once and become a blob: URL that pdf.js reads with range requests.
  useEffect(() => {
    let cancelled = false;
    setLoaded({ status: "loading" });
    read.getMaterialBytes(material.id)
      .then((bytes) => {
        if (cancelled) return;
        if (!bytes) { setLoaded({ status: "error", message: "The PDF bytes are missing from the library. Add the file again." }); return; }
        const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/pdf" }));
        urlRef.current = url;
        setLoaded({ status: "ready", url });
      })
      .catch((error: unknown) => { if (!cancelled) setLoaded({ status: "error", message: error instanceof Error ? error.message : "Could not load the PDF." }); });
    return () => {
      cancelled = true;
      if (urlRef.current) { URL.revokeObjectURL(urlRef.current); urlRef.current = undefined; }
    };
  }, [material.id]);

  // On `document`, not `window`: the shell's own ⌘J listens on the window and yields when a reader already handled it.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target?.tagName === "INPUT" || target?.tagName === "TEXTAREA";
      if (event.key === "Escape" && !typing) { event.preventDefault(); if (inspectorTab) setInspectorTab(null); else onBack?.(); }
      if ((event.metaKey || event.ctrlKey) && event.key === "j") { event.preventDefault(); setInspectorTab((tab) => (tab === "agent" ? null : "agent")); }
      if (event.key === "n" && !typing && !event.metaKey && !event.ctrlKey) { event.preventDefault(); setInspectorTab((tab) => (tab === "notes" ? null : "notes")); }
      if (event.key === "i" && !typing && !event.metaKey && !event.ctrlKey) { event.preventDefault(); setInspectorTab((tab) => (tab === "info" ? null : "info")); }
      if (event.key === "t" && !typing && !event.metaKey && !event.ctrlKey) { event.preventDefault(); setTocPinned((pinned) => !pinned); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [inspectorTab, onBack]);

  // The current section is the last outline entry that starts on or before the visible page.
  const activeEntry = useMemo(() => outline.filter((entry) => entry.page <= page).at(-1)?.id, [outline, page]);
  const tocEntries = useMemo(() => outline.map((entry) => ({ id: entry.id, label: entry.title, level: entry.level })), [outline]);

  const onReaderStateChange = (state: PdfReaderState) => {
    remember(state);
    setPage(state.page);
    const fraction = pdfReadingProgress(state, pdf?.pages);
    if (fraction !== undefined) { setProgress(Math.round(fraction * 100)); onProgress?.(fraction); }
  };

  const regions = useMemo<PdfRegionOverlay[]>(() => annotations.map((annotation) => ({ id: annotation.id, locator: annotation.locator, color: annotation.color, kind: annotation.kind })), [annotations]);
  const captureSelection = useCallback((selection: Selection): SelectionCapture | undefined => {
    if (selection.isCollapsed) return undefined;
    const captured = viewerRef.current?.readSelection();
    if (!captured || captured.kind !== "selection") return undefined;
    const locator = pdfRegionLocatorForSelection(captured);
    const quote = pdfSelectionText(captured);
    return locator && quote ? { locator, quote } : undefined;
  }, []);
  const jumpTo = (annotation: Annotation) => { viewerRef.current?.goToLocator(annotation.locator); setActiveAnnotation(annotation.id); };
  const sectionFor = (annotation: Annotation) => { const page = parsePdfRegionsLocator(annotation.locator)?.[0]?.page; return page ? `p. ${page}` : undefined; };
  const onNote = async (capture: SelectionCapture) => {
    const saved = await add({ ...capture, kind: "comment", color: ANNOTATION_COLORS[0]!.color });
    setInspectorTab("notes"); setActiveAnnotation(saved.id); setNoteDraft({ id: saved.id, value: "" });
  };
  const inspectorOpen = inspectorTab !== null;

  const subtitle = [material.origin === "agent" ? "Agent" : hostLabel(material), pdf ? `${pdf.pages} pages` : "", `${progress}%`].filter(Boolean).join(" · ");

  return (
    <div className={`grid h-full grid-cols-[minmax(0,1fr)] grid-rows-[56px_minmax(0,1fr)] gap-3 ${embedded ? "p-0" : "p-3"}`}>
      <Toolbar aria-label="Reader toolbar" className={`${embedded ? "" : "titlebar-drag pl-[92px]"} col-span-full`}>
        {embedded ? <span /> : <ToolbarGroup><ToolbarButton aria-label="Back" isSelected={false} onChange={() => onBack?.()}><ChevronLeft /></ToolbarButton></ToolbarGroup>}
        <ToolbarTitle title={material.title} subtitle={subtitle} />
        <ToolbarGroup>
          <span className={`mr-1.5 inline-flex h-[22px] items-center gap-1 rounded-pill px-2.5 text-[11.5px] font-medium ${pdf?.textLayer === "absent" ? "bg-orange-soft text-orange-text" : "bg-fill text-label-2"}`}>{pdf?.textLayer === "absent" ? "scanned PDF" : "PDF"}</span>
          <ToolbarButton aria-label="Contents (t)" isSelected={tocPinned} isDisabled={outline.length === 0} onChange={setTocPinned}><List /></ToolbarButton>
          <ToolbarButton aria-label="Info (i)" isSelected={inspectorTab === "info"} onChange={(on) => setInspectorTab(on ? "info" : null)}><Info /></ToolbarButton>
          <ToolbarButton aria-label="Notes (n)" isSelected={inspectorTab === "notes"} onChange={(on) => setInspectorTab(on ? "notes" : null)}><Highlighter /></ToolbarButton>
          <ReadingSettings prefs={prefs} onChange={setPrefs} />
          <AskButton aria-label="Ask" isSelected={inspectorTab === "agent"} onChange={(on) => setInspectorTab(on ? "agent" : null)}><Sparkles />Ask<Kbd>⌘J</Kbd></AskButton>
        </ToolbarGroup>
      </Toolbar>

      <SplitGroup id="reader" aria-label="Reader and inspector" className="h-full">
      <SplitPanel id="page" minSize={360}>
      <main ref={mainRef} key={material.id} className="reader-enter relative grid h-full min-h-0 grid-rows-[2px_minmax(0,1fr)] overflow-hidden rounded-panel bg-content shadow-[0_0_0_1px_var(--separator-soft),0_6px_20px_rgba(15,17,21,.04)]">
        <div className="bg-separator-soft"><i className="block h-full bg-accent opacity-80" style={{ width: `${progress}%` }} /></div>
        <SelectionToolbar root={mainRef.current} viewport={mainRef.current} capture={captureSelection} onHighlight={(capture, color) => void add({ ...capture, kind: "highlight", color })} onNote={(capture) => void onNote(capture)} onCopy={(capture) => void navigator.clipboard.writeText(citationFor(material, { quote: capture.quote }))} onAsk={(capture) => { setAsked(capture); setInspectorTab("agent"); }} />
        {outline.length > 1 ? (
          <div className="pointer-events-none absolute inset-y-6 right-6 z-10 flex items-center">
            <TocRail aria-label="Contents" entries={tocEntries} activeId={activeEntry} pinned={tocPinned} onSelect={(id) => { const entry = outline.find((item) => item.id === id); if (entry) viewerRef.current?.goToPage(entry.page); }} />
          </div>
        ) : null}
        {loaded.status === "ready" && pdf ? (
          <PdfCanvasViewer
            ref={viewerRef}
            url={loaded.url}
            title={material.title}
            pageCount={pdf.pages}
            textLayer={pdf.textLayer}
            initialState={initialState}
            onReaderStateChange={onReaderStateChange}
            onOutlineChange={setOutline}
            regions={regions}
            activeRegionId={activeAnnotation}
            onRegionActivate={(id) => { setActiveAnnotation(id); setInspectorTab("notes"); }}
          />
        ) : loaded.status === "error" ? (
          <div className="grid place-items-center p-10 text-center"><div className="grid max-w-[420px] gap-2"><strong className="text-[16px] text-label">Could not open this PDF.</strong><span className="text-[13px] text-label-2">{loaded.message}</span></div></div>
        ) : (
          <div className="grid place-items-center text-[13px] text-label-3">Opening…</div>
        )}
      </main>
      </SplitPanel>
      {inspectorOpen ? (
        <>
          <SplitSeparator aria-label="Resize inspector" hit={12} footprint={12} line="hover" />
          <SplitPanel id="inspector" defaultSize={sizes.sizeOf("inspector", 360)} minSize={300} maxSize={520} onResize={sizes.onResize("inspector")}>
            <ReaderInspector material={material} tab={inspectorTab} onTabChange={setInspectorTab} subject={material.title} agentContext={agentContext} onClearSelection={() => setAsked(null)}
              annotations={annotations} annotationsError={annotationsError} activeAnnotation={activeAnnotation} noteDraft={noteDraft} onNoteDraftChange={setNoteDraft}
              onJump={jumpTo} onUpdateNote={(id, note) => void update(id, { note })} onDeleteAnnotation={(id) => void remove(id)} sectionFor={sectionFor}
              onMaterialSaved={onMaterialSaved} onOpenLink={onOpenLink} onOpenMaterial={onOpenMaterial} onOpenSettings={onOpenSettings} />
          </SplitPanel>
        </>
      ) : null}
      </SplitGroup>
    </div>
  );
}
