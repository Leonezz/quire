import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SplitGroup, SplitPanel, TocRail, useSplitSizes } from "@read/ui";
import { ColumnSeparator, PAGE_MIN, PANEL_DEFAULT, PANEL_MAX, PANEL_MIN } from "./ContentPane";
import { ReaderToolbar } from "./ReaderToolbar";
import { PdfCanvasViewer, parsePdfRegionsLocator, pdfReadingProgress, pdfRegionLocatorForSelection, pdfSelectionText, usePdfReaderStateMemory, type PdfCanvasViewerHandle, type PdfOutlineEntry, type PdfReaderState, type PdfRegionOverlay } from "@read/reader-pdf";
import { ANNOTATION_COLORS, citationFor, useAnnotations } from "./annotations";
import type { NoteDraft } from "./NotesPanel";
import { ReaderInspector, type ReaderPanel } from "./ReaderInspector";
import { hostLabel } from "./ArtifactLineage";
import { headerParts } from "./materialMeta";
import type { ReaderProps } from "./ReaderView";
import { SelectionToolbar, type SelectionCapture } from "./SelectionToolbar";
import type { AgentContext, Annotation } from "../../shared/contracts";
import { read } from "./api";
import { mirroredViews, resolveViewAnnotations } from "./mirroredAnnotations";
import { useReadingPrefs } from "./readingPrefs";
import { useTextViewContent } from "./useTextViewContent";
import { reportQuoteJump } from "./quoteJump";
import { revealPdfQuote } from "./pdfQuoteSearch";

type Loaded = { status: "loading" } | { status: "ready"; url: string } | { status: "error"; message: string };

/** PDF reading: the same toolbar contract as the article reader, the pages rendered by pdf.js. */
export function PdfReaderView({ material, content, views, pendingJump, onJumpDone, onJumpAcross, jumpToQuote, initialPanel, onPanelChange, onBack, onOpenLink, onOpenMaterial, onProgress, onMaterialSaved, onOpenSettings, trailing }: ReaderProps) {
  const pdf = content.pdf;
  const view = content.view;
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  const [prefs, setPrefs] = useReadingPrefs();
  const [progress, setProgress] = useState(0);
  const [panel, setPanel] = useState<ReaderPanel | null>(initialPanel ?? null);
  useEffect(() => { onPanelChange?.(panel); }, [onPanelChange, panel]);
  const sizes = useSplitSizes("reader");
  const { annotations, error: annotationsError, add, update, remove } = useAnnotations(material.id);
  // This view's notes are regions on these pages, and so are the text view's once its anchors are loaded; the Notes panel still lists every view's.
  const primaryView = material.primaryView;
  const textView = useTextViewContent(material);
  const textContent = textView.status === "ready" ? textView.content : undefined;
  const viewAnnotations = useMemo(() => resolveViewAnnotations(annotations, view, primaryView, textContent), [annotations, view, primaryView, textContent]);
  const shownAnnotation = useCallback((annotation: Annotation) => viewAnnotations.find((entry) => entry.id === annotation.id), [viewAnnotations]);
  const [noteDraft, setNoteDraft] = useState<NoteDraft | null>(null);
  const [activeAnnotation, setActiveAnnotation] = useState<string | undefined>(undefined);
  const [asked, setAsked] = useState<SelectionCapture | null>(null);
  const agentContext: AgentContext = asked ? { kind: "selection", materialId: material.id, quote: asked.quote, locator: asked.locator } : { kind: "material", materialId: material.id };
  const mainRef = useRef<HTMLElement>(null);
  const [outline, setOutline] = useState<readonly PdfOutlineEntry[]>([]);
  const [page, setPage] = useState(1);
  const [tocPinned, setTocPinned] = useState(false);
  const viewerRef = useRef<PdfCanvasViewerHandle>(null);
  const identity = `${material.id}:${view}`;
  const { initialState, remember } = usePdfReaderStateMemory(identity, pdf?.pages ?? 0);
  const urlRef = useRef<string | undefined>(undefined);

  // The bytes cross the bridge once and become a blob: URL that pdf.js reads with range requests.
  useEffect(() => {
    let cancelled = false;
    setLoaded({ status: "loading" });
    read.getMaterialBytes(material.id, view)
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
  }, [material.id, view]);

  // The jump handed over from another view: the viewer keeps the navigation pending until the page is laid out.
  useEffect(() => {
    if (!pendingJump || loaded.status !== "ready") return;
    viewerRef.current?.goToLocator((shownAnnotation(pendingJump) ?? pendingJump).locator);
    setActiveAnnotation(pendingJump.id);
    setPanel("notes");
    onJumpDone();
  }, [pendingJump, loaded.status, onJumpDone, shownAnnotation]);

  // A citation's quote: the pages are searched for it, the viewer goes to its page and the match is marked for a moment; each request runs once.
  const handledQuoteJump = useRef<number | undefined>(undefined);
  const [jumpError, setJumpError] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (!jumpToQuote || loaded.status !== "ready" || jumpToQuote.materialId !== material.id || handledQuoteJump.current === jumpToQuote.nonce) return;
    handledQuoteJump.current = jumpToQuote.nonce;
    const { quote } = jumpToQuote;
    let cancelled = false;
    revealPdfQuote({ url: loaded.url, quote, pageRoot: () => mainRef.current, goToPage: (page) => viewerRef.current?.goToPage(page), isCancelled: () => cancelled })
      .then((found) => { if (!cancelled) reportQuoteJump({ materialId: material.id, quote, found }); })
      .catch((cause: unknown) => { if (!cancelled) setJumpError(cause instanceof Error ? cause.message : "Could not search the PDF for the quoted passage."); });
    return () => { cancelled = true; };
  }, [jumpToQuote, loaded, material.id]);

  // On `document`, not `window`: the shell's own ⌘J listens on the window and yields when a reader already handled it.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target?.tagName === "INPUT" || target?.tagName === "TEXTAREA";
      if (event.key === "Escape" && !typing) { event.preventDefault(); if (panel) setPanel(null); else onBack?.(); }
      if ((event.metaKey || event.ctrlKey) && event.key === "j") { event.preventDefault(); setPanel((open) => (open === "agent" ? null : "agent")); }
      if (event.key === "n" && !typing && !event.metaKey && !event.ctrlKey) { event.preventDefault(); setPanel((open) => (open === "notes" ? null : "notes")); }
      if (event.key === "i" && !typing && !event.metaKey && !event.ctrlKey) { event.preventDefault(); setPanel((open) => (open === "info" ? null : "info")); }
      if (event.key === "t" && !typing && !event.metaKey && !event.ctrlKey) { event.preventDefault(); setTocPinned((pinned) => !pinned); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [panel, onBack]);

  // The current section is the last outline entry that starts on or before the visible page.
  const activeEntry = useMemo(() => outline.filter((entry) => entry.page <= page).at(-1)?.id, [outline, page]);
  const tocEntries = useMemo(() => outline.map((entry) => ({ id: entry.id, label: entry.title, level: entry.level })), [outline]);

  const onReaderStateChange = (state: PdfReaderState) => {
    remember(state);
    setPage(state.page);
    const fraction = pdfReadingProgress(state, pdf?.pages);
    if (fraction !== undefined) { setProgress(Math.round(fraction * 100)); onProgress?.(fraction); }
  };

  const regions = useMemo<PdfRegionOverlay[]>(() => viewAnnotations.map((annotation) => ({ id: annotation.id, locator: annotation.locator, color: annotation.color, kind: annotation.kind })), [viewAnnotations]);
  const captureSelection = useCallback((selection: Selection): SelectionCapture | undefined => {
    if (selection.isCollapsed) return undefined;
    const captured = viewerRef.current?.readSelection();
    if (!captured || captured.kind !== "selection") return undefined;
    const locator = pdfRegionLocatorForSelection(captured);
    const quote = pdfSelectionText(captured);
    return locator && quote ? { locator, quote } : undefined;
  }, []);
  const jumpTo = (annotation: Annotation) => { viewerRef.current?.goToLocator(annotation.locator); setActiveAnnotation(annotation.id); };
  const sectionFor = (annotation: Annotation) => { const shown = shownAnnotation(annotation); const page = shown ? parsePdfRegionsLocator(shown.locator)[0]?.page : undefined; return page ? `p. ${page}` : undefined; };
  const onNote = async (capture: SelectionCapture) => {
    const saved = await add({ ...capture, kind: "comment", color: ANNOTATION_COLORS[0]!.color, view });
    setPanel("notes"); setActiveAnnotation(saved.id); setNoteDraft({ id: saved.id, value: "" });
  };
  const panelOpen = panel !== null;
  const badge = pdf?.textLayer === "absent" ? { text: "scanned PDF", low: true } : { text: "PDF", low: false };

  // The PDF has no header of its own, so creators · publication · date ride in the title bar before the host.
  const subtitle = [...headerParts(material.meta), material.origin === "agent" ? "Agent" : hostLabel(material), pdf ? `${pdf.pages} pages` : "", `${content.readingMinutes} min`, `${progress}%`].filter(Boolean).join(" · ");
  const viewSwitch = { view, views: views.views, fetching: views.fetching, onSelect: views.select };

  return (
    <div className="grid h-full grid-cols-[minmax(0,1fr)] grid-rows-[52px_minmax(0,1fr)]">
      <ReaderToolbar title={material.title} subtitle={subtitle} badge={badge} tocPinned={tocPinned} tocDisabled={outline.length === 0} onTocChange={setTocPinned} panel={panel} onPanelChange={setPanel} prefs={prefs} onPrefsChange={setPrefs} trailing={trailing} views={viewSwitch} />

      <SplitGroup id="reader" aria-label="Reader and panel" className="h-full">
      <SplitPanel id="page" minSize={PAGE_MIN}>
      <main ref={mainRef} key={material.id} className="reader-enter relative grid h-full min-h-0 grid-rows-[2px_minmax(0,1fr)] overflow-hidden bg-content">
        <div className="bg-separator-soft"><i className="block h-full bg-accent opacity-80" style={{ width: `${progress}%` }} /></div>
        <SelectionToolbar root={mainRef.current} viewport={mainRef.current} capture={captureSelection} onHighlight={(capture, color) => void add({ ...capture, kind: "highlight", color, view })} onNote={(capture) => void onNote(capture)} onCopy={(capture) => void navigator.clipboard.writeText(citationFor(material, { quote: capture.quote }))} onAsk={(capture) => { setAsked(capture); setPanel("agent"); }} />
        {outline.length > 1 ? (
          <div className="pointer-events-none absolute inset-y-6 right-1.5 z-10 flex items-center">
            <TocRail aria-label="Contents" entries={tocEntries} activeId={activeEntry} pinned={tocPinned} resting="hidden" onSelect={(id) => { const entry = outline.find((item) => item.id === id); if (entry) viewerRef.current?.goToPage(entry.page); }} />
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
            onRegionActivate={(id) => { setActiveAnnotation(id); setPanel("notes"); }}
          />
        ) : loaded.status === "error" ? (
          <div className="grid place-items-center p-10 text-center"><div className="grid max-w-[420px] gap-2"><strong className="text-[16px] text-label">Could not open this PDF.</strong><span className="text-[13px] text-label-2">{loaded.message}</span></div></div>
        ) : (
          <div className="grid place-items-center text-[13px] text-label-3">Opening…</div>
        )}
        {textView.status === "error" ? (
          <div role="alert" className="absolute bottom-3 left-1/2 max-w-[min(640px,90%)] -translate-x-1/2 truncate rounded-pill bg-red-soft px-3.5 py-1.5 text-[12.5px] text-red-text shadow-float">Notes from the Text view cannot be shown — {textView.message}</div>
        ) : jumpError ? (
          <div role="alert" className="absolute bottom-3 left-1/2 max-w-[min(640px,90%)] -translate-x-1/2 truncate rounded-pill bg-red-soft px-3.5 py-1.5 text-[12.5px] text-red-text shadow-float">{jumpError}</div>
        ) : null}
      </main>
      </SplitPanel>
      {panelOpen ? (
        <>
          <ColumnSeparator label="Resize panel" />
          <SplitPanel id="inspector" defaultSize={sizes.sizeOf("inspector", PANEL_DEFAULT)} minSize={PANEL_MIN} maxSize={PANEL_MAX} onResize={sizes.onResize("inspector")}>
            <ReaderInspector material={material} views={views} panel={panel} onClose={() => setPanel(null)} subject={material.title} agentContext={agentContext} onClearSelection={() => setAsked(null)}
              annotations={annotations} annotationsError={annotationsError} mirroredViews={mirroredViews(view, textContent)} activeAnnotation={activeAnnotation} noteDraft={noteDraft} onNoteDraftChange={setNoteDraft}
              onJump={(annotation) => { const shown = shownAnnotation(annotation); if (shown) jumpTo(shown); else onJumpAcross(annotation); }} onUpdateNote={(id, note) => void update(id, { note })} onDeleteAnnotation={(id) => void remove(id)} sectionFor={sectionFor}
              onMaterialSaved={onMaterialSaved} onOpenLink={onOpenLink} onOpenMaterial={onOpenMaterial} onOpenSettings={onOpenSettings} />
          </SplitPanel>
        </>
      ) : null}
      </SplitGroup>
    </div>
  );
}
