import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Button, CompanionPlayer, Presence, ShimmerText, SplitGroup, SplitPanel, TocRail, VideoDockFrame, useSplitSizes, type MediaCacheBadgeState } from "@read/ui";
import { ColumnSeparator, PAGE_MIN, PANEL_DEFAULT, PANEL_MAX, PANEL_MIN } from "./ContentPane";
import { ReaderToolbar } from "./ReaderToolbar";
import { installTextAnnotationHighlights, renderedTextQuoteSelection, resolveTextQuoteAnchor, resolveTextQuoteRange, textAnnotationHighlightStyles, useDocumentReadingPosition, type TextAnnotationPlacement } from "@read/reader";
import { ANNOTATION_COLORS, citationFor, useAnnotations } from "./annotations";
import type { NoteDraft } from "./NotesPanel";
import { ReaderInspector, type ReaderPanel } from "./ReaderInspector";
import { hostLabel } from "./ArtifactLineage";
import { QualityBanner, canRebuild, type RebuildState } from "./RebuildBanner";
import { agentStore, useAgentRun } from "./agentStore";
import { transcribeStore, useTranscriptionJob } from "./transcribeStore";
import { SelectionToolbar, type SelectionCapture } from "./SelectionToolbar";
import type { AgentContext, Annotation } from "../../shared/contracts";
import { FindBar } from "./FindBar";
import { useReadingPrefs } from "./readingPrefs";
import { ReaderArticle } from "./ReaderArticle";
import { ArtifactVersionBar, useArtifactVersions } from "./ArtifactVersions";
import { read } from "./api";
import type { MaterialRecord, MaterialViewContent } from "../../shared/contracts";
import { durationLabel } from "./format";
import { activeChapterOf, mediaStore, useMediaPlayback } from "./mediaStore";
import { VIDEO_DOCK_SLOT_ID } from "./YoutubeBridgeHost";
import { mirroredViews, resolveViewAnnotations } from "./mirroredAnnotations";
import { TextViewBanner } from "./TextViewBanner";
import { activeParagraphForTime, timeRangeForQuote } from "./transcriptAnchors";
import type { MaterialViewController } from "./useMaterialView";
import { flashQuoteRange, reportQuoteJump, resolveQuoteRange, scrollQuoteIntoView, type MaterialQuoteJump } from "./quoteJump";
import { qualityLabel } from "./qualityLabel";
import { isReportShortcut } from "./keyboardMap";
import { reportSelectionOf, takeLiveSelection, viewportOf, rectOf, type ReportRequest, type ReportSelection } from "./reportRequest";

type OutlineEntry = { id: string; label: string; level: number };
const NO_PLACEMENTS: ReadonlyMap<string, TextAnnotationPlacement> = new Map();

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
  /** A passage a citation quoted: revealed and flashed once the body is up, and reported through quoteJump.ts. */
  jumpToQuote?: MaterialQuoteJump | undefined;
  /** The panel that was open before a view switch, and where the reader reports its own. */
  initialPanel?: ReaderPanel | null | undefined;
  onPanelChange?: ((panel: ReaderPanel | null) => void) | undefined;
  onBack?: (() => void) | undefined;
  onOpenLink: (url: string) => void;
  /** Opens another library material (a citation in an agent answer, an artifact's source, the rebuilt version); a citation may pass the passage it quotes. */
  onOpenMaterial: (id: string, quote?: string) => void;
  /** Reports the scrolled fraction (0–1) so the owner can record a finished reading. */
  onProgress?: ((fraction: number) => void) | undefined;
  /** The Info panel saved metadata: the owner replaces its record so the header and body follow. */
  onMaterialSaved: (record: MaterialRecord) => void;
  onOpenSettings?: (() => void) | undefined;
  /**
   * "Report" (⌥⌘R, the selection toolbar, the quality pill, the Info panel, the quality banner): the owner opens the report
   * panel for the current view, with a way to measure this reader at submit time and the passage pointed at, if any.
   */
  onReport: (request: ReportRequest) => void;
  /** The shell's Add · Search icons, at the far right of the toolbar segment. Escape closes the panel, then calls `onBack`. */
  trailing?: ReactNode;
}

export function ReaderView({ material, content, views, pendingJump, onJumpDone, onJumpAcross, jumpToQuote, initialPanel, onPanelChange, onBack, onOpenLink, onOpenMaterial, onProgress, onMaterialSaved, onOpenSettings, onReport, trailing }: ReaderProps) {
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
  // The exact scrolled fraction, for a report's screenshot position (the state above is rounded for the bar).
  const fractionRef = useRef(0);
  const [prefs, setPrefs] = useReadingPrefs();
  const [findOpen, setFindOpen] = useState(false);
  const [bodyGeneration, setBodyGeneration] = useState(0);
  const { annotations, error: annotationsError, add, update, remove } = useAnnotations(material.id);
  // This view's notes are anchored in this body, and — when this is the text view — the PDF's notes carried over
  // through the anchors; the Notes panel still lists every view's.
  const primaryView = material.primaryView;
  const textContent = content.view === "text" ? content : undefined;
  const transcriptContent = content.view === "transcript" ? content : undefined;
  const viewAnnotations = useMemo(
    () => resolveViewAnnotations(annotations, view, primaryView, textContent, transcriptContent),
    [annotations, view, primaryView, textContent, transcriptContent],
  );
  const shownAnnotation = useCallback((annotation: Annotation) => viewAnnotations.find((entry) => entry.id === annotation.id), [viewAnnotations]);
  const playback = useMediaPlayback();
  const hasMedia = material.media !== undefined;
  const isCurrentMedia = hasMedia && playback.materialId === material.id;
  const [drifted, setDrifted] = useState(false);

  useEffect(() => {
    mediaStore.setMountedReader(material.id);
    return () => { mediaStore.setMountedReader(undefined); };
  }, [material.id]);

  useEffect(() => {
    setDrifted(false);
    if (material.media) void mediaStore.hydrateMaterial(material);
  }, [material]);

  const activeAnchor = useMemo(
    () => (isCurrentMedia ? activeParagraphForTime(transcriptContent?.timeAnchors, playback.positionSec) : undefined),
    [isCurrentMedia, playback.positionSec, transcriptContent?.timeAnchors],
  );
  const activeParagraphIndex = activeAnchor?.paragraphIndex;
  const [noteDraft, setNoteDraft] = useState<NoteDraft | null>(null);
  const [activeAnnotation, setActiveAnnotation] = useState<string | undefined>(undefined);
  // Where the highlight layer placed each shown note; the Notes panel lists the unplaced ones and takes sections from the rest.
  const [placements, setPlacements] = useState(NO_PLACEMENTS);
  // "Ask about this" narrows the agent's context to the selected passage until it is dropped.
  const [asked, setAsked] = useState<SelectionCapture | null>(null);
  const agentContext: AgentContext = asked ? { kind: "selection", materialId: material.id, quote: asked.quote, locator: asked.locator } : { kind: "material", materialId: material.id };
  // "Rebuild with the agent": the store runs the rebuild in the material's conversation (the one the panel shows, or a new one the
  // panel then opens); the banner follows that run and switches once `rebuiltAs` arrives with the library change.
  const [panelSession, setPanelSession] = useState<string | undefined>(undefined);
  const [rebuildSession, setRebuildSession] = useState<string | undefined>(undefined);
  const [rebuildPhase, setRebuildPhase] = useState<{ kind: "idle" } | { kind: "starting" } | { kind: "failed"; error?: string | undefined }>({ kind: "idle" });
  const [cleanupError, setCleanupError] = useState<string | undefined>(undefined);
  const rebuildRun = useAgentRun(rebuildSession);
  useEffect(() => { setRebuildSession(undefined); setRebuildPhase({ kind: "idle" }); setCleanupError(undefined); }, [material.id]);
  const rebuildOutcome = rebuildRun?.outcome;
  useEffect(() => { if (rebuildOutcome && rebuildOutcome.status !== "done") setRebuildPhase({ kind: "failed", error: rebuildOutcome.message }); }, [rebuildOutcome]);
  const rebuild: RebuildState = rebuildPhase.kind === "starting" || (rebuildRun !== undefined && rebuildOutcome === undefined) ? "running" : rebuildPhase.kind === "failed" ? "failed" : "idle";
  const transcription = useTranscriptionJob(hasMedia ? material.id : undefined);
  useEffect(() => {
    const completedChunks = transcription.job?.completedChunks ?? 0;
    if (transcription.completedNonce === undefined && completedChunks === 0) return;
    read.getMaterial(material.id)
      .then((rec) => {
        if (!rec) return;
        onMaterialSaved(rec);
        if (rec.readyViews.includes("transcript") && views.view !== "transcript") {
          views.select("transcript");
        }
      })
      .catch(() => undefined);
  }, [material.id, onMaterialSaved, transcription.completedNonce, transcription.job?.completedChunks, views]);
  const startCleanupTranscript = useCallback(async () => {
    setAsked(null); setPanel("agent"); setCleanupError(undefined);
    if (prefs.focus) setPrefs({ ...prefs, focus: false });
    try {
      const result = await agentStore.ask({
        context: { kind: "material", materialId: material.id },
        task: "cleanup_transcript",
        text: "",
        ...(panelSession ? { sessionId: panelSession } : {}),
      });
      if (!result.ok) { setCleanupError(result.message); return; }
      setRebuildSession(result.sessionId);
    } catch (cause: unknown) {
      setCleanupError(cause instanceof Error ? cause.message : "The agent did not answer.");
    }
  }, [material.id, panelSession, prefs, setPrefs]);
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
  const artifactVersions = useArtifactVersions(material, content, onMaterialSaved);
  // An artifact that fails while running: the agent reads it, finds the cause and edits it, in the material's conversation.
  const fixArtifact = useCallback((error: string) => {
    setAsked(null); setPanel("agent");
    if (prefs.focus) setPrefs({ ...prefs, focus: false });
    const text = `This artifact fails when it runs, with the error: ${error}\nRead it with material_read, find the cause and fix it with artifact_update.`;
    void agentStore.ask({ context: { kind: "material", materialId: material.id }, task: "ask", text, ...(panelSession ? { sessionId: panelSession } : {}) }).catch(() => undefined);
  }, [material.id, panelSession, prefs, setPrefs]);
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
    if (!root || viewAnnotations.length === 0) { setPlacements(NO_PLACEMENTS); return; }
    const installed = installTextAnnotationHighlights({
      annotations: viewAnnotations.map((annotation) => ({ id: annotation.id, locator: annotation.locator, quote: annotation.quote, kind: annotation.kind, color: annotation.color, ...(annotation.note ? { note: annotation.note } : {}) })),
      namePrefix: "read-note",
      onActivate: (id) => { setActiveAnnotation(id); setPanel("notes"); },
      root,
    });
    setPlacements(installed.placements);
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
  const placedRange = (annotation: Annotation) => { const placement = placements.get(annotation.id); return placement && placement.status !== "unplaced" ? placement.range : undefined; };
  const copyText = async (text: string) => { await navigator.clipboard.writeText(text); };
  const jumpTo = (annotation: Annotation) => {
    const root = bodyRef.current;
    if (!root) return;
    // Approximately too: a stale note jumps to where it is drawn; an unplaced one has no jump in the Notes panel.
    const range = resolveTextQuoteAnchor(root, annotation.locator, annotation.quote)?.range;
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
  const onHighlight = (capture: SelectionCapture, color: Annotation["color"]) => {
    const timeRange = transcriptContent ? timeRangeForQuote(transcriptContent, capture) : undefined;
    void add({ ...capture, kind: "highlight", color, view, ...(timeRange ? { timeRange } : {}) });
  };
  const onNote = async (capture: SelectionCapture) => {
    const timeRange = transcriptContent ? timeRangeForQuote(transcriptContent, capture) : undefined;
    const saved = await add({ ...capture, kind: "comment", color: ANNOTATION_COLORS[0]!.color, view, ...(timeRange ? { timeRange } : {}) });
    setPanel("notes");
    setActiveAnnotation(saved.id);
    setNoteDraft({ id: saved.id, value: "" });
  };
  const onCopyCapture = (capture: SelectionCapture) => {
    const range = bodyRef.current ? resolveTextQuoteRange(bodyRef.current, capture.locator, capture.quote) : undefined;
    const timeRange = transcriptContent ? timeRangeForQuote(transcriptContent, capture) : undefined;
    void copyText(citationFor(material, { quote: capture.quote, ...(timeRange ? { timeRange } : {}) }, sectionOf(range)));
  };
  const onListenCapture = hasMedia && transcriptContent?.timeAnchors?.length
    ? (capture: SelectionCapture) => {
        const timeRange = timeRangeForQuote(transcriptContent, capture);
        if (timeRange) void mediaStore.playSnippet(material, timeRange[0], timeRange[1]);
      }
    : undefined;
  const seekAndPlay = useCallback((seconds: number) => {
    setDrifted(false);
    void mediaStore.seekTo(seconds, material, true);
  }, [material]);
  const jumpToCurrentMedia = useCallback(() => {
    setDrifted(false);
    mediaStore.setFollowing(true);
    const root = bodyRef.current;
    if (!root || activeParagraphIndex === undefined) return;
    const paragraphs = root.querySelectorAll<HTMLParagraphElement>(".reader-document > p");
    paragraphs[activeParagraphIndex]?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [activeParagraphIndex]);
  // A report measures the viewport when it is submitted, and finds an attached passage again for its box then.
  const measureReport = useCallback((selection: ReportSelection | undefined) => {
    const viewport = viewportOf(viewportRef.current, fractionRef.current);
    const range = selection && bodyRef.current ? resolveTextQuoteRange(bodyRef.current, selection.locator, selection.quote) : undefined;
    return { ...(viewport ? { viewport } : {}), ...(range ? { selectionRect: rectOf(range.getBoundingClientRect()) } : {}) };
  }, []);
  const report = useCallback((selection?: ReportSelection) => onReport({ measure: measureReport, ...(selection ? { selection } : {}) }), [onReport, measureReport]);
  const reportFromChrome = useCallback(() => report(), [report]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => { setOutline(outlineOf(bodyRef.current)); setBodyGeneration((value) => value + 1); });
    return () => cancelAnimationFrame(frame);
  }, [identity]);

  // The jump handed over from another view runs once the body has rendered (bodyGeneration moves past 0).
  useEffect(() => {
    if (!pendingJump || bodyGeneration === 0) return;
    jumpTo(shownAnnotation(pendingJump) ?? pendingJump);
    setPanel("notes");
    onJumpDone();
    // jumpTo reads the current body through refs; the jump is keyed by the request and the body generation.
  }, [pendingJump, bodyGeneration, onJumpDone, shownAnnotation]);

  // A citation's quote: found in the rendered body, it is scrolled to the middle and marked for a moment; each request runs once.
  const handledQuoteJump = useRef<number | undefined>(undefined);
  useEffect(() => {
    const root = bodyRef.current;
    if (!jumpToQuote || bodyGeneration === 0 || !root || jumpToQuote.materialId !== material.id || handledQuoteJump.current === jumpToQuote.nonce) return;
    handledQuoteJump.current = jumpToQuote.nonce;
    const range = resolveQuoteRange(root, jumpToQuote.quote);
    if (range) { scrollQuoteIntoView(root, range); flashQuoteRange(root, range); }
    reportQuoteJump({ materialId: material.id, quote: jumpToQuote.quote, found: range !== undefined });
  }, [jumpToQuote, bodyGeneration, material.id]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    let idle: number | undefined;
    const onScroll = () => {
      const max = viewport.scrollHeight - viewport.clientHeight;
      const fraction = max > 0 ? Math.min(1, viewport.scrollTop / max) : 1;
      fractionRef.current = fraction;
      setProgress(Math.round(fraction * 100));
      onProgressRef.current?.(fraction);
      setActiveHeading(currentHeading(viewport, bodyRef.current));
      if (idle !== undefined) window.clearTimeout(idle);
    };
    viewport.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => viewport.removeEventListener("scroll", onScroll);
  }, [material.id]);

  // Manual wheel or touch scrolling during playback pauses auto-follow cleanly instead of fighting the scroll wheel.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !isCurrentMedia || !playback.playing || !playback.following) return;
    const onManualInput = () => setDrifted(true);
    viewport.addEventListener("wheel", onManualInput, { passive: true });
    viewport.addEventListener("touchmove", onManualInput, { passive: true });
    return () => {
      viewport.removeEventListener("wheel", onManualInput);
      viewport.removeEventListener("touchmove", onManualInput);
    };
  }, [isCurrentMedia, playback.playing, playback.following]);

  // Smart Follow: keep the currently spoken paragraph inside the comfortable reading band unless the reader scrolled away.
  useEffect(() => {
    if (!isCurrentMedia || !playback.playing || !playback.following || drifted || activeParagraphIndex === undefined) return;
    const viewport = viewportRef.current;
    const root = bodyRef.current;
    if (!viewport || !root) return;
    const target = root.querySelectorAll<HTMLParagraphElement>(".reader-document > p")[activeParagraphIndex];
    if (!target) return;
    const vpRect = viewport.getBoundingClientRect();
    const pRect = target.getBoundingClientRect();
    if (pRect.top < vpRect.top + 80 || pRect.bottom > vpRect.bottom - 160) {
      target.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [activeParagraphIndex, drifted, isCurrentMedia, playback.following, playback.playing]);

  // On `document`, not `window`: the shell's own ⌘J listens on the window and yields when a reader already handled it.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // A sheet (Settings, the feedback report) has its own keys; the reader's single letters stay out of it.
      if (event.target instanceof Element && event.target.closest("[role=dialog]")) return;
      // ⌥⌘R reports from anywhere in the reader, a note being typed included; a selected passage goes along.
      if (isReportShortcut(event)) { event.preventDefault(); report(takeLiveSelection(bodyRef.current, captureSelection)); return; }
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      if (event.key === "Escape") { event.preventDefault(); if (panel) setPanel(null); else onBack?.(); }
      if (event.key === "t" && !event.metaKey && !event.ctrlKey && !event.altKey) { event.preventDefault(); setTocPinned((pinned) => !pinned); }
      if (event.key === "n" && !event.metaKey && !event.ctrlKey && !event.altKey) { event.preventDefault(); setPanel((open) => (open === "notes" ? null : "notes")); }
      if (event.key === "i" && !event.metaKey && !event.ctrlKey && !event.altKey) { event.preventDefault(); setPanel((open) => (open === "info" ? null : "info")); }
      if (event.key === "v" && !event.metaKey && !event.ctrlKey && !event.altKey && views.views.length > 1) {
        event.preventDefault();
        const idx = views.views.findIndex((entry) => entry.id === view);
        const next = views.views[(idx + 1) % views.views.length];
        if (next) views.select(next.id);
        return;
      }
      if (hasMedia && !event.metaKey && !event.ctrlKey && !event.altKey) {
        if (event.key === "k") { event.preventDefault(); void mediaStore.togglePlay(material); return; }
        if (event.key === "j") { event.preventDefault(); mediaStore.skip(material.media?.kind === "video" ? -10 : -15, material); return; }
        if (event.key === "l") { event.preventDefault(); mediaStore.skip(material.media?.kind === "video" ? 10 : 30, material); return; }
        if (event.key === "[") { event.preventDefault(); mediaStore.stepPlaybackSpeed(-0.25); return; }
        if (event.key === "]") { event.preventDefault(); mediaStore.stepPlaybackSpeed(0.25); return; }
        if (event.key === "m" && material.media?.kind === "video") {
          event.preventDefault();
          void mediaStore.hydrateMaterial(material).then(() => mediaStore.toggleVideoOpen());
          return;
        }
      }
      if ((event.metaKey || event.ctrlKey) && event.key === "j") { event.preventDefault(); setPanel((open) => (open === "agent" ? null : "agent")); }
      if ((event.metaKey || event.ctrlKey) && event.key === "f") { event.preventDefault(); setFindOpen(true); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [panel, onBack, report, captureSelection, hasMedia, material, view, views]);

  // A stable resolver: the surface keys its image cache by resolver identity, so a new function per render
  // would re-request every image on each scroll tick (flicker and layout jumps).
  const resolveImage = useCallback((url: string) => read.resolveImage(url), []);
  const host = hostLabel(material);
  const mediaDur = durationLabel(material.media?.durationSec);
  const subtitle = [material.origin === "agent" ? "Agent" : host, `${progress}%`, mediaDur ?? `${content.readingMinutes} min`].join(" · ");
  const viewSwitch = { view, views: views.views, fetching: views.fetching, onSelect: views.select };
  const panelOpen = panel !== null && !prefs.focus;
  const mediaPosition = isCurrentMedia ? playback.positionSec : 0;
  const mediaDuration = (isCurrentMedia && playback.durationSec > 0 ? playback.durationSec : material.media?.durationSec) ?? 0;
  const mediaChapter = activeChapterOf(material.media?.chapters, mediaPosition)?.title;
  const cacheState: MediaCacheBadgeState | undefined = hasMedia
    ? playback.cacheProgress?.materialId === material.id && playback.cacheProgress.phase === "downloading"
      ? {
          status: "downloading",
          ...(playback.cacheProgress.totalBytes
            ? { percent: Math.round((playback.cacheProgress.downloadedBytes / playback.cacheProgress.totalBytes) * 100) }
            : {}),
        }
      : (material.media?.cachedBytes ?? 0) > 0
        ? { status: "cached" }
        : { status: "none" }
    : undefined;
  const toggleMediaCache = useCallback(() => {
    if (!material.media) return;
    const op = (material.media.cachedBytes ?? 0) > 0
      ? read.removeMediaCache(material.id)
      : read.downloadMediaCache(material.id);
    void op.then(onMaterialSaved).catch(() => undefined);
  }, [material.id, material.media, onMaterialSaved]);

  const isVideo = material.media?.kind === "video";
  const videoOpen = isVideo && isCurrentMedia && playback.videoOpen;
  const openVideoAt = useCallback((seconds: number) => {
    setDrifted(false);
    void mediaStore.seekTo(seconds, material, true).then(() => {
      mediaStore.setVideoOpen(true);
    });
  }, [material]);

  return (
    <div className="grid h-full grid-cols-[minmax(0,1fr)] grid-rows-[52px_minmax(0,1fr)]">
      <ReaderToolbar title={material.title} subtitle={subtitle} badge={quality} onReport={reportFromChrome} onRebuild={onRebuild} tocPinned={tocPinned} onTocChange={setTocPinned} panel={panel} onPanelChange={setPanel} prefs={prefs} onPrefsChange={setPrefs} trailing={trailing} views={viewSwitch} />

      <SplitGroup id="reader" aria-label="Reader and panel" className="h-full">
      <SplitPanel id="page" minSize={PAGE_MIN}>
      <main key={material.id} className="reader-enter relative grid h-full min-h-0 grid-rows-[2px_auto_minmax(0,1fr)] overflow-hidden bg-content">
        <div className="bg-separator-soft">{prefs.focus ? null : <i className="block h-full bg-accent opacity-80" style={{ width: `${progress}%` }} />}</div>
        <Presence show={videoOpen}>
          {videoOpen ? (
            <VideoDockFrame
              title={mediaChapter ?? material.title}
              onClose={() => mediaStore.setVideoOpen(false)}
            >
              <div id={VIDEO_DOCK_SLOT_ID} className="h-full w-full" />
            </VideoDockFrame>
          ) : null}
        </Presence>
        <Presence show={findOpen}>{findOpen ? <FindBar root={bodyRef.current} generation={bodyGeneration} onClose={() => setFindOpen(false)} /> : null}</Presence>
        <SelectionToolbar root={bodyRef.current} viewport={viewportRef.current} capture={captureSelection} onHighlight={onHighlight} onNote={(capture) => void onNote(capture)} onCopy={onCopyCapture} onAsk={(capture) => { setAsked(capture); setPanel("agent"); }} onReport={(capture, rect) => report(reportSelectionOf(capture, rect))} onListen={onListenCapture} />
        {outline.length > 1 ? (
          <div className="pointer-events-none absolute inset-y-6 right-1.5 z-10 flex items-center">
            <TocRail aria-label="Contents" entries={outline.map((entry) => ({ id: entry.id, label: entry.label, level: entry.level - 1 }))} activeId={activeHeading} pinned={tocPinned} resting="hidden" onSelect={(id) => document.getElementById(id)?.scrollIntoView({ block: "start", behavior: "smooth" })} />
          </div>
        ) : null}
        <ReaderArticle material={material} content={artifactVersions.content} prefs={prefs} resolveImage={resolveImage} onOpenLink={onOpenLink} onOpenMaterial={onOpenMaterial} viewportRef={viewportRef} bodyRef={bodyRef} onShowSources={() => setPanel("info")} onFixArtifact={material.origin === "agent" ? fixArtifact : undefined}
          activeParagraphIndex={activeParagraphIndex} onSeekTime={hasMedia ? seekAndPlay : undefined} onSelectKeyframeTime={isVideo ? openVideoAt : undefined}
          bylineExtra={material.origin === "agent" ? null : <a href={material.finalUrl} onClick={(event) => { event.preventDefault(); onOpenLink(material.finalUrl); }}>Open original ↗</a>}
          banner={content.view === "text" && content.report
            ? <TextViewBanner report={content.report} onOpenPdf={() => views.select("pdf")} />
            : <>
                <ArtifactVersionBar versions={artifactVersions} />
                {transcription.job ? (
                  <div role="status" className="mb-6 flex flex-wrap items-center justify-between gap-2 rounded-card bg-fill px-3.5 py-2.5 text-[12.5px] text-label-2">
                    <ShimmerText>
                      {transcription.job.phase === "transcribing" && transcription.job.totalChunks > 0
                        ? `Transcribing segment ${transcription.job.completedChunks} of ${transcription.job.totalChunks}…`
                        : "Preparing audio for transcription…"}
                    </ShimmerText>
                    <Button size="sm" variant="quiet" onPress={() => void transcribeStore.cancel(material.id)}>Cancel</Button>
                  </div>
                ) : material.media?.transcriptOrigin === "absent" ? (
                  <div role="status" className="mb-6 grid gap-2 rounded-card bg-fill px-3.5 py-2.5 text-[12.5px] text-label-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span>No publisher transcript came with this episode. Listen below while reading the show notes.</span>
                      <Button size="sm" onPress={() => void transcribeStore.start(material.id)}>Transcribe</Button>
                    </div>
                    {transcription.error ? (
                      <div role="alert" className="flex flex-wrap items-center gap-2 text-red-text">
                        <span>{transcription.error}</span>
                        {onOpenSettings ? <Button size="sm" variant="quiet" onPress={onOpenSettings}>Settings…</Button> : null}
                      </div>
                    ) : null}
                  </div>
                ) : material.media?.transcriptOrigin === "auto_captions" || material.media?.transcriptOrigin === "local_asr" || material.media?.transcriptOrigin === "cloud_asr" ? (
                  <div role="status" className="mb-6 grid gap-2 rounded-card bg-fill px-3.5 py-2.5 text-[12.5px] text-label-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span>Machine-generated transcript — punctuation and speaker turns can be refined without changing timestamps.</span>
                      <Button size="sm" isDisabled={rebuild === "running"} onPress={() => void startCleanupTranscript()}>Clean up with the agent</Button>
                    </div>
                    {cleanupError ? <p role="alert" className="m-0 text-red-text">{cleanupError}</p> : null}
                  </div>
                ) : null}
                <QualityBanner material={material} low={quality.low} onOpenLink={onOpenLink} onOpenMaterial={onOpenMaterial} onReport={reportFromChrome} onRebuild={onRebuild} rebuild={rebuild} rebuildError={rebuildError} />
              </>} />
        {hasMedia ? (
          <div className="pointer-events-none absolute inset-x-4 bottom-3 z-20 flex justify-center">
            <CompanionPlayer
              className="pointer-events-auto w-full max-w-[680px]"
              playing={isCurrentMedia && playback.playing}
              positionSec={mediaPosition}
              durationSec={mediaDuration}
              playbackSpeed={isCurrentMedia ? playback.playbackSpeed : 1}
              skipBackSec={material.media?.kind === "video" ? 10 : 15}
              skipForwardSec={material.media?.kind === "video" ? 10 : 30}
              chapterTitle={mediaChapter}
              following={isCurrentMedia ? playback.following : true}
              drifted={drifted}
              hasVideo={isVideo}
              videoOpen={videoOpen}
              cacheState={cacheState}
              onTogglePlay={() => void mediaStore.togglePlay(material)}
              onSeek={(sec) => { setDrifted(false); void mediaStore.seekTo(sec, material, false); }}
              onSkip={(delta) => mediaStore.skip(delta, material)}
              onSpeedChange={(speed) => mediaStore.setPlaybackSpeed(speed)}
              onToggleFollow={transcriptContent?.timeAnchors?.length ? () => {
                if (drifted) {
                  jumpToCurrentMedia();
                } else {
                  mediaStore.setFollowing(!playback.following);
                }
              } : undefined}
              onJumpToCurrent={transcriptContent?.timeAnchors?.length ? jumpToCurrentMedia : undefined}
              onToggleVideo={isVideo ? () => {
                void mediaStore.hydrateMaterial(material).then(() => mediaStore.toggleVideoOpen());
              } : undefined}
              onToggleCache={toggleMediaCache}
            />
          </div>
        ) : null}
      </main>
      </SplitPanel>
      {panelOpen ? (
        <>
          <ColumnSeparator label="Resize panel" />
          <SplitPanel id="inspector" defaultSize={sizes.sizeOf("inspector", PANEL_DEFAULT)} minSize={PANEL_MIN} maxSize={PANEL_MAX} onResize={sizes.onResize("inspector")}>
            <ReaderInspector material={material} views={views} panel={panel} onClose={() => setPanel(null)} subject={material.title} agentContext={agentContext} onClearSelection={() => setAsked(null)}
              agentSessionId={rebuildSession} onAgentSessionChange={setPanelSession} onReport={reportFromChrome} onRebuild={onRebuild} rebuild={rebuild} rebuildError={rebuildError}
              annotations={annotations} annotationsError={annotationsError} mirroredViews={mirroredViews(view, textContent)} activeAnnotation={activeAnnotation} noteDraft={noteDraft} onNoteDraftChange={setNoteDraft}
              onJump={(annotation) => { const shown = shownAnnotation(annotation); if (shown) jumpTo(shown); else onJumpAcross(annotation); }} onUpdateNote={(id, note) => void update(id, { note })} onDeleteAnnotation={(id) => void remove(id)}
              sectionFor={(annotation) => sectionOf(placedRange(annotation))} placementOf={(annotation) => placements.get(annotation.id)?.status}
              onPlayTime={hasMedia ? seekAndPlay : undefined}
              onMaterialSaved={onMaterialSaved} onOpenLink={onOpenLink} onOpenMaterial={onOpenMaterial} onOpenSettings={onOpenSettings} />
          </SplitPanel>
        </>
      ) : null}
      </SplitGroup>
    </div>
  );
}
