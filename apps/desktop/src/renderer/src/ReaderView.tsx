import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { SplitGroup, SplitPanel, TocRail, useSplitSizes } from "@read/ui";
import { ColumnSeparator, PAGE_MIN, PANEL_DEFAULT, PANEL_MAX, PANEL_MIN } from "./ContentPane";
import { ReaderToolbar } from "./ReaderToolbar";
import { ReaderDocumentSurface, installTextAnnotationHighlights, renderedTextQuoteSelection, resolveTextQuoteRange, textAnnotationHighlightStyles, useDocumentReadingPosition } from "@read/reader";
import { ANNOTATION_COLORS, citationFor, useAnnotations } from "./annotations";
import type { NoteDraft } from "./NotesPanel";
import { ReaderInspector, type ReaderPanel } from "./ReaderInspector";
import { hostLabel } from "./ArtifactLineage";
import { QualityBanner, canRebuild, type RebuildState } from "./RebuildBanner";
import { agentStore, useAgentRun } from "./agentStore";
import { SelectionToolbar, type SelectionCapture } from "./SelectionToolbar";
import type { AgentContext, Annotation } from "../../shared/contracts";
import { FindBar } from "./FindBar";
import { prefsStyle, useReadingPrefs } from "./readingPrefs";
import { read } from "./api";
import { headerParts } from "./materialMeta";
import type { MaterialRecord, MaterialViewContent } from "../../shared/contracts";
import { annotationView } from "./materialViews";
import type { MaterialViewController } from "./useMaterialView";

type OutlineEntry = { id: string; label: string; level: number };

function qualityLabel(material: Pick<MaterialRecord, "origin">, content: Pick<MaterialViewContent, "quality">): { text: string; low: boolean } {
  const q = content.quality;
  if (material.origin === "agent") return { text: "written by the agent", low: false };
  if (q.safety === "degraded_plaintext") return { text: "plain text only", low: true };
  if (q.completeness === "summary") return { text: "summary only", low: true };
  if (q.conformance === "recoverable") return { text: "web extract · partial", low: true };
  return { text: material.origin === "feed" ? "feed full text" : "web extract", low: false };
}

/** The heading whose top has passed the reading line (a little below the viewport top). */
function currentHeading(viewport: HTMLElement, root: HTMLElement | null): string | undefined {
  if (!root) return undefined;
  const line = viewport.getBoundingClientRect().top + 96;
  let current: string | undefined;
  for (const heading of root.querySelectorAll<HTMLHeadingElement>("h2, h3, h4")) {
    if (!heading.id) continue;
    if (heading.getBoundingClientRect().top <= line) current = heading.id;
    else break;
  }
  return current;
}

/** Headings in the rendered document become the Contents list; ids are assigned once per render. */
function outlineOf(root: HTMLElement | null): OutlineEntry[] {
  if (!root) return [];
  const entries: OutlineEntry[] = [];
  root.querySelectorAll<HTMLHeadingElement>("h2, h3, h4").forEach((heading, index) => {
    const label = heading.textContent?.trim();
    if (!label) return;
    if (!heading.id) heading.id = `s-${index}-${label.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-").slice(0, 40)}`;
    entries.push({ id: heading.id, label, level: Number(heading.tagName.slice(1)) });
  });
  return entries;
}

export interface ReaderProps {
  /** The record: title, metadata, origin, the views. */
  material: MaterialRecord;
  /** The body being read: the chosen view's content (the record's own for the primary view). */
  content: MaterialViewContent;
  /** The chosen view and how to switch: the toolbar's segment and the Info panel's list. */
  views: MaterialViewController;
  /** A note on this view to scroll to as soon as the body is up (the Notes panel jumped here from another view); `onJumpDone` once handled. */
  pendingJump?: Annotation | undefined;
  onJumpDone: () => void;
  /** The Notes panel jumps to a note on another view: the owner switches the view and hands the jump to the next reader. */
  onJumpAcross: (annotation: Annotation) => void;
  /** The panel that was open before a view switch, and where the reader reports its own. */
  initialPanel?: ReaderPanel | null | undefined;
  onPanelChange?: ((panel: ReaderPanel | null) => void) | undefined;
  onBack?: (() => void) | undefined;
  onOpenLink: (url: string) => void;
  /** Opens another library material (a citation in an agent answer, an artifact's source, the rebuilt version). */
  onOpenMaterial: (id: string) => void;
  /** Reports the scrolled fraction (0–1) so the owner can record a finished reading. */
  onProgress?: ((fraction: number) => void) | undefined;
  /** The Info panel saved metadata: the owner replaces its record so the header and body follow. */
  onMaterialSaved: (record: MaterialRecord) => void;
  onOpenSettings?: (() => void) | undefined;
  /** The shell's Add · Search icons, at the far right of the toolbar segment. Escape closes the panel, then calls `onBack`. */
  trailing?: ReactNode;
}

export function ReaderView({ material, content, views, pendingJump, onJumpDone, onJumpAcross, initialPanel, onPanelChange, onBack, onOpenLink, onOpenMaterial, onProgress, onMaterialSaved, onOpenSettings, trailing }: ReaderProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const onProgressRef = useRef(onProgress);
  onProgressRef.current = onProgress;
  const bodyRef = useRef<HTMLDivElement>(null);
  const [panel, setPanel] = useState<ReaderPanel | null>(initialPanel ?? null);
  useEffect(() => { onPanelChange?.(panel); }, [onPanelChange, panel]);
  const view = content.view;
  const sizes = useSplitSizes("reader");
  const [outline, setOutline] = useState<OutlineEntry[]>([]);
  const [activeHeading, setActiveHeading] = useState<string | undefined>(undefined);
  const [tocPinned, setTocPinned] = useState(false);
  const [progress, setProgress] = useState(0);
    const [prefs, setPrefs] = useReadingPrefs();
  const [findOpen, setFindOpen] = useState(false);
  const [bodyGeneration, setBodyGeneration] = useState(0);
  const { annotations, error: annotationsError, add, update, remove } = useAnnotations(material.id);
  // Only this view's notes are anchored in this body; the Notes panel still lists every view's.
  const primaryView = material.primaryView;
  const ownAnnotation = useCallback((annotation: Annotation) => annotationView(annotation, primaryView) === view, [primaryView, view]);
  const viewAnnotations = useMemo(() => annotations.filter(ownAnnotation), [annotations, ownAnnotation]);
  const [noteDraft, setNoteDraft] = useState<NoteDraft | null>(null);
  const [activeAnnotation, setActiveAnnotation] = useState<string | undefined>(undefined);
  // "Ask about this" narrows the agent's context to the selected passage until it is dropped.
  const [asked, setAsked] = useState<SelectionCapture | null>(null);
  const agentContext: AgentContext = asked ? { kind: "selection", materialId: material.id, quote: asked.quote, locator: asked.locator } : { kind: "material", materialId: material.id };
  // "Rebuild with the agent": the store runs the rebuild in the material's conversation (the one the panel shows, or a new one the
  // panel then opens); the banner follows that run and switches once `rebuiltAs` arrives with the library change.
  const [panelSession, setPanelSession] = useState<string | undefined>(undefined);
  const [rebuildSession, setRebuildSession] = useState<string | undefined>(undefined);
  const [rebuildPhase, setRebuildPhase] = useState<{ kind: "idle" } | { kind: "starting" } | { kind: "failed"; error?: string | undefined }>({ kind: "idle" });
  const rebuildRun = useAgentRun(rebuildSession);
  useEffect(() => { setRebuildSession(undefined); setRebuildPhase({ kind: "idle" }); }, [material.id]);
  const rebuildOutcome = rebuildRun?.outcome;
  useEffect(() => { if (rebuildOutcome && rebuildOutcome.status !== "done") setRebuildPhase({ kind: "failed", error: rebuildOutcome.message }); }, [rebuildOutcome]);
  const rebuild: RebuildState = rebuildPhase.kind === "starting" || (rebuildRun !== undefined && rebuildOutcome === undefined) ? "running" : rebuildPhase.kind === "failed" ? "failed" : "idle";
  const startRebuild = useCallback(async () => {
    setAsked(null); setPanel("agent"); setRebuildPhase({ kind: "starting" });
    // Focus mode hides the panel, and the rebuild is worth watching: leave it.
    if (prefs.focus) setPrefs({ ...prefs, focus: false });
    try {
      const result = await agentStore.ask({ context: { kind: "material", materialId: material.id }, task: "rebuild", text: "", ...(panelSession ? { sessionId: panelSession } : {}) });
      if (!result.ok) { setRebuildPhase({ kind: "failed", error: result.message }); return; }
      setRebuildSession(result.sessionId); setRebuildPhase({ kind: "idle" });
    } catch (cause: unknown) { setRebuildPhase({ kind: "failed", error: cause instanceof Error ? cause.message : "The agent did not answer." }); }
  }, [material.id, panelSession, prefs, setPrefs]);
  const onRebuild = canRebuild(material) ? () => void startRebuild() : undefined;
  const rebuildError = rebuildPhase.kind === "failed" ? rebuildPhase.error : undefined;
  // Focus mode closes the panel; an explicit request for one (button, i / n / ⌘J) leaves focus mode again.
  useEffect(() => { if (prefs.focus) setPanel(null); }, [prefs.focus]);
  useEffect(() => { if (panel !== null && prefs.focus) setPrefs({ ...prefs, focus: false }); }, [panel, prefs, setPrefs]);
  const quality = qualityLabel(material, content);
  const identity = content.reader ? `${material.id}:${view}:${content.reader.schema}` : `${material.id}:${view}`;

  useDocumentReadingPosition(viewportRef, identity);

  // The ::highlight() rules for notes are generated once per page.
  useEffect(() => {
    if (document.getElementById("read-note-highlight-styles")) return;
    const style = document.createElement("style");
    style.id = "read-note-highlight-styles";
    style.textContent = textAnnotationHighlightStyles("read-note");
    document.head.append(style);
  }, []);

  useEffect(() => {
    const root = bodyRef.current;
    if (!root || viewAnnotations.length === 0) return;
    const installed = installTextAnnotationHighlights({
      annotations: viewAnnotations.map((annotation) => ({ id: annotation.id, locator: annotation.locator, quote: annotation.quote, kind: annotation.kind, color: annotation.color, ...(annotation.note ? { note: annotation.note } : {}) })),
      namePrefix: "read-note",
      onActivate: (id) => { setActiveAnnotation(id); setPanel("notes"); },
      root,
    });
    return installed.dispose;
  }, [viewAnnotations, bodyGeneration]);

  const sectionOf = (range: Range | undefined) => {
    if (!range) return undefined;
    let node: Node | null = range.startContainer;
    while (node && node !== bodyRef.current) {
      let sibling: Node | null = node;
      while (sibling) {
        if (sibling instanceof HTMLElement && /^H[2-4]$/.test(sibling.tagName)) return sibling.textContent?.trim();
        sibling = sibling.previousSibling;
      }
      node = node.parentNode;
    }
    return undefined;
  };
  const copyText = async (text: string) => { await navigator.clipboard.writeText(text); };
  const jumpTo = (annotation: Annotation) => {
    const root = bodyRef.current;
    if (!root) return;
    const range = resolveTextQuoteRange(root, annotation.locator, annotation.quote);
    if (!range) return;
    (range.startContainer.parentElement ?? root).scrollIntoView({ block: "center", behavior: "smooth" });
    setActiveAnnotation(annotation.id);
  };
  const captureSelection = useCallback((selection: Selection) => {
    const root = bodyRef.current;
    if (!root) return undefined;
    const captured = renderedTextQuoteSelection(root, selection);
    return captured.kind === "capture" ? captured.capture : undefined;
  }, []);
  const onHighlight = (capture: SelectionCapture, color: Annotation["color"]) => { void add({ ...capture, kind: "highlight", color, view }); };
  const onNote = async (capture: SelectionCapture) => {
    const saved = await add({ ...capture, kind: "comment", color: ANNOTATION_COLORS[0]!.color, view });
    setPanel("notes");
    setActiveAnnotation(saved.id);
    setNoteDraft({ id: saved.id, value: "" });
  };
  const onCopyCapture = (capture: SelectionCapture) => {
    const range = bodyRef.current ? resolveTextQuoteRange(bodyRef.current, capture.locator, capture.quote) : undefined;
    void copyText(citationFor(material, { quote: capture.quote }, sectionOf(range)));
  };

  useEffect(() => {
    const frame = requestAnimationFrame(() => { setOutline(outlineOf(bodyRef.current)); setBodyGeneration((value) => value + 1); });
    return () => cancelAnimationFrame(frame);
  }, [material.id]);

  // The jump handed over from another view runs once the body has rendered (bodyGeneration moves past 0).
  useEffect(() => {
    if (!pendingJump || bodyGeneration === 0) return;
    jumpTo(pendingJump);
    setPanel("notes");
    onJumpDone();
    // jumpTo reads the current body through refs; the jump is keyed by the request and the body generation.
  }, [pendingJump, bodyGeneration, onJumpDone]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    let idle: number | undefined;
    const onScroll = () => {
      const max = viewport.scrollHeight - viewport.clientHeight;
      const fraction = max > 0 ? Math.min(1, viewport.scrollTop / max) : 1;
      setProgress(Math.round(fraction * 100));
      onProgressRef.current?.(fraction);
      setActiveHeading(currentHeading(viewport, bodyRef.current));
      if (idle !== undefined) window.clearTimeout(idle);
    };
    viewport.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => viewport.removeEventListener("scroll", onScroll);
  }, [material.id]);

  // On `document`, not `window`: the shell's own ⌘J listens on the window and yields when a reader already handled it.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      if (event.key === "Escape") { event.preventDefault(); if (panel) setPanel(null); else onBack?.(); }
      if (event.key === "t") { event.preventDefault(); setTocPinned((pinned) => !pinned); }
      if (event.key === "n" && !event.metaKey && !event.ctrlKey) { event.preventDefault(); setPanel((open) => (open === "notes" ? null : "notes")); }
      if (event.key === "i" && !event.metaKey && !event.ctrlKey) { event.preventDefault(); setPanel((open) => (open === "info" ? null : "info")); }
      if ((event.metaKey || event.ctrlKey) && event.key === "j") { event.preventDefault(); setPanel((open) => (open === "agent" ? null : "agent")); }
      if ((event.metaKey || event.ctrlKey) && event.key === "f") { event.preventDefault(); setFindOpen(true); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [panel, onBack]);

  // A stable resolver: the surface keys its image cache by resolver identity, so a new function per render
  // would re-request every image on each scroll tick (flicker and layout jumps).
  const resolveImage = useCallback((url: string) => read.resolveImage(url), []);
  const fallback = useMemo(() => (content.markdown ? { content: content.markdown, format: "gfm" as const } : { content: content.plain ?? "", format: "plain" as const }), [content]);
  const host = hostLabel(material);
  const subtitle = [material.origin === "agent" ? "Agent" : host, `${progress}%`, `${content.readingMinutes} min`].join(" · ");
  const viewSwitch = { view, views: views.views, fetching: views.fetching, onSelect: views.select };
  const panelOpen = panel !== null && !prefs.focus;
  const lineageCount = material.origin === "agent" ? (material.lineage?.length ?? 0) : 0;

  return (
    <div className="grid h-full grid-cols-[minmax(0,1fr)] grid-rows-[52px_minmax(0,1fr)]">
      <ReaderToolbar title={material.title} subtitle={subtitle} badge={quality} tocPinned={tocPinned} onTocChange={setTocPinned} panel={panel} onPanelChange={setPanel} prefs={prefs} onPrefsChange={setPrefs} trailing={trailing} views={viewSwitch} />

      <SplitGroup id="reader" aria-label="Reader and panel" className="h-full">
      <SplitPanel id="page" minSize={PAGE_MIN}>
      <main key={material.id} className="reader-enter relative grid h-full min-h-0 grid-rows-[2px_minmax(0,1fr)] overflow-hidden bg-content">
        <div className="bg-separator-soft">{prefs.focus ? null : <i className="block h-full bg-accent opacity-80" style={{ width: `${progress}%` }} />}</div>
        {findOpen ? <FindBar root={bodyRef.current} generation={bodyGeneration} onClose={() => setFindOpen(false)} /> : null}
        <SelectionToolbar root={bodyRef.current} viewport={viewportRef.current} capture={captureSelection} onHighlight={onHighlight} onNote={(capture) => void onNote(capture)} onCopy={onCopyCapture} onAsk={(capture) => { setAsked(capture); setPanel("agent"); }} />
        {outline.length > 1 ? (
          <div className="pointer-events-none absolute inset-y-6 right-5 z-10 flex items-center">
            <TocRail aria-label="Contents" entries={outline.map((entry) => ({ id: entry.id, label: entry.label, level: entry.level - 1 }))} activeId={activeHeading} pinned={tocPinned} onSelect={(id) => document.getElementById(id)?.scrollIntoView({ block: "start", behavior: "smooth" })} />
          </div>
        ) : null}
        <div ref={viewportRef} className="reader-viewport overflow-auto px-14 pb-[120px] pt-12" style={prefsStyle(prefs)}>
          <article ref={bodyRef} className="reader-body" style={{ textAlign: prefs.justify ? "justify" : "start" }}>
            {lineageCount ? <button type="button" className="mb-3 block cursor-default border-0 bg-transparent p-0 text-[13px] font-medium text-accent-text hover:underline" onClick={() => setPanel("info")}>{host} · sources in Info</button> : <p className="mb-3 text-[13px] font-medium text-accent-text">{host}</p>}
            <h1>{material.title}</h1>
            <div className="mb-8 flex flex-wrap gap-x-3 text-[12.5px] text-label-2">
              {headerParts(material.meta).map((part) => <span key={part}>{part}</span>)}
              <span>{content.readingMinutes} min</span>
              {material.origin === "agent" ? null : <a href={material.finalUrl} onClick={(event) => { event.preventDefault(); onOpenLink(material.finalUrl); }}>Open original ↗</a>}
            </div>
            <QualityBanner material={material} low={quality.low} onOpenLink={onOpenLink} onOpenMaterial={onOpenMaterial} onRebuild={onRebuild} rebuild={rebuild} rebuildError={rebuildError} />
            <ReaderDocumentSurface
              schema={content.reader?.schema ?? "none"}
              payload={content.reader?.payload ?? ""}
              fallback={fallback}
              onOpenLink={onOpenLink}
              resolveImageSource={resolveImage}
              resolveRemoteImageSource={resolveImage}
              showFallbackNotice={false}
            />
          </article>
        </div>
      </main>
      </SplitPanel>
      {panelOpen ? (
        <>
          <ColumnSeparator label="Resize panel" />
          <SplitPanel id="inspector" defaultSize={sizes.sizeOf("inspector", PANEL_DEFAULT)} minSize={PANEL_MIN} maxSize={PANEL_MAX} onResize={sizes.onResize("inspector")}>
            <ReaderInspector material={material} views={views} panel={panel} onClose={() => setPanel(null)} subject={material.title} agentContext={agentContext} onClearSelection={() => setAsked(null)}
              agentSessionId={rebuildSession} onAgentSessionChange={setPanelSession} onRebuild={onRebuild} rebuild={rebuild} rebuildError={rebuildError}
              annotations={annotations} annotationsError={annotationsError} activeAnnotation={activeAnnotation} noteDraft={noteDraft} onNoteDraftChange={setNoteDraft}
              onJump={(annotation) => (ownAnnotation(annotation) ? jumpTo(annotation) : onJumpAcross(annotation))} onUpdateNote={(id, note) => void update(id, { note })} onDeleteAnnotation={(id) => void remove(id)}
              sectionFor={(annotation) => (ownAnnotation(annotation) && bodyRef.current ? sectionOf(resolveTextQuoteRange(bodyRef.current, annotation.locator, annotation.quote)) : undefined)}
              onMaterialSaved={onMaterialSaved} onOpenLink={onOpenLink} onOpenMaterial={onOpenMaterial} onOpenSettings={onOpenSettings} />
          </SplitPanel>
        </>
      ) : null}
      </SplitGroup>
    </div>
  );
}
