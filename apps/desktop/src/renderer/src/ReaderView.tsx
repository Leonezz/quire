import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, Highlighter, List, Sparkles } from "lucide-react";
import { AskButton, Inspector, InspectorPanel, InspectorTab, InspectorTabs, Kbd, TocRail, Toolbar, ToolbarButton, ToolbarGroup, ToolbarTitle, type Key } from "@read/ui";
import { ReaderDocumentSurface, installTextAnnotationHighlights, renderedTextQuoteSelection, resolveTextQuoteRange, textAnnotationHighlightStyles, useDocumentReadingPosition } from "@read/reader";
import { ANNOTATION_COLORS, citationFor, useAnnotations } from "./annotations";
import { NotesPanel, type NoteDraft } from "./NotesPanel";
import { AgentPanel } from "./AgentPanel";
import { ArtifactLineage, hostLabel } from "./ArtifactLineage";
import { SelectionToolbar, type SelectionCapture } from "./SelectionToolbar";
import type { AgentContext, Annotation } from "../../shared/contracts";
import { FindBar } from "./FindBar";
import { ReadingSettings } from "./ReadingSettings";
import { applyTheme, loadPrefs, prefsStyle, savePrefs, type ReadingPrefs } from "./readingPrefs";
import { read } from "./api";
import type { MaterialRecord } from "../../shared/contracts";

type OutlineEntry = { id: string; label: string; level: number };

function qualityLabel(material: MaterialRecord): { text: string; low: boolean } {
  const q = material.quality;
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

/**
 * `embedded`: rendered inside a pane (no back button, no title-bar drag region); Escape closes the inspector, then calls `onBack`.
 * `onProgress` reports the scrolled fraction (0–1) so the owner can record a finished reading.
 * `onOpenMaterial` opens another library material (a citation in an agent answer, an artifact's source).
 */
export function ReaderView({ material, onBack, onOpenLink, onOpenMaterial, onProgress, embedded = false }: { material: MaterialRecord; onBack?: (() => void) | undefined; onOpenLink: (url: string) => void; onOpenMaterial: (id: string) => void; onProgress?: ((fraction: number) => void) | undefined; embedded?: boolean }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const onProgressRef = useRef(onProgress);
  onProgressRef.current = onProgress;
  const bodyRef = useRef<HTMLDivElement>(null);
  const [inspectorTab, setInspectorTab] = useState<Key | null>(null);
  const [outline, setOutline] = useState<OutlineEntry[]>([]);
  const [activeHeading, setActiveHeading] = useState<string | undefined>(undefined);
  const [tocPinned, setTocPinned] = useState(false);
  const [progress, setProgress] = useState(0);
  const [reading, setReading] = useState(false);
  const [prefs, setPrefs] = useState<ReadingPrefs>(loadPrefs);
  const [findOpen, setFindOpen] = useState(false);
  const [bodyGeneration, setBodyGeneration] = useState(0);
  const { annotations, error: annotationsError, add, update, remove } = useAnnotations(material.id);
  const [noteDraft, setNoteDraft] = useState<NoteDraft | null>(null);
  const [activeAnnotation, setActiveAnnotation] = useState<string | undefined>(undefined);
  // "Ask about this" narrows the agent's context to the selected passage until it is dropped.
  const [asked, setAsked] = useState<SelectionCapture | null>(null);
  const agentContext: AgentContext = asked ? { kind: "selection", materialId: material.id, quote: asked.quote, locator: asked.locator } : { kind: "material", materialId: material.id };
  useEffect(() => { savePrefs(prefs); applyTheme(prefs.theme); }, [prefs]);
  useEffect(() => { if (prefs.focus) setInspectorTab(null); }, [prefs.focus]);
  const quality = qualityLabel(material);
  const identity = material.reader ? `${material.id}:${material.reader.schema}` : material.id;

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
    if (!root || annotations.length === 0) return;
    const installed = installTextAnnotationHighlights({
      annotations: annotations.map((annotation) => ({ id: annotation.id, locator: annotation.locator, quote: annotation.quote, kind: annotation.kind, color: annotation.color, ...(annotation.note ? { note: annotation.note } : {}) })),
      namePrefix: "read-note",
      onActivate: (id) => { setActiveAnnotation(id); setInspectorTab("notes"); },
      root,
    });
    return installed.dispose;
  }, [annotations, bodyGeneration]);

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
  const onHighlight = (capture: SelectionCapture, color: Annotation["color"]) => { void add({ ...capture, kind: "highlight", color }); };
  const onNote = async (capture: SelectionCapture) => {
    const saved = await add({ ...capture, kind: "comment", color: ANNOTATION_COLORS[0]!.color });
    setInspectorTab("notes");
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

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    let idle: number | undefined;
    const onScroll = () => {
      const max = viewport.scrollHeight - viewport.clientHeight;
      const fraction = max > 0 ? Math.min(1, viewport.scrollTop / max) : 1;
      setProgress(Math.round(fraction * 100));
      onProgressRef.current?.(fraction);
      setReading(viewport.scrollTop > 40);
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
      if (event.key === "Escape") { event.preventDefault(); if (inspectorTab) setInspectorTab(null); else onBack?.(); }
      if (event.key === "t") { event.preventDefault(); setTocPinned((pinned) => !pinned); }
      if (event.key === "n" && !event.metaKey && !event.ctrlKey) { event.preventDefault(); setInspectorTab((tab) => (tab === "notes" ? null : "notes")); }
      if ((event.metaKey || event.ctrlKey) && event.key === "j") { event.preventDefault(); setInspectorTab((tab) => (tab === "agent" ? null : "agent")); }
      if ((event.metaKey || event.ctrlKey) && event.key === "f") { event.preventDefault(); setFindOpen(true); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [inspectorTab, onBack]);

  // A stable resolver: the surface keys its image cache by resolver identity, so a new function per render
  // would re-request every image on each scroll tick (flicker and layout jumps).
  const resolveImage = useCallback((url: string) => read.resolveImage(url), []);
  const fallback = useMemo(() => (material.markdown ? { content: material.markdown, format: "gfm" as const } : { content: material.plain ?? "", format: "plain" as const }), [material]);
  const host = hostLabel(material);
  const subtitle = [material.origin === "agent" ? "Agent" : host, `${progress}%`, `${material.readingMinutes} min`].join(" · ");
  const inspectorOpen = inspectorTab !== null && !prefs.focus;

  return (
    <div className={`grid h-full ${inspectorOpen ? "grid-cols-[minmax(0,1fr)_360px]" : "grid-cols-[minmax(0,1fr)]"} grid-rows-[56px_minmax(0,1fr)] gap-3 ${embedded ? "p-0" : "p-3"}`}>
      <Toolbar aria-label="Reader toolbar" className={`${embedded ? "" : "titlebar-drag pl-[92px]"} col-span-full transition-opacity ${reading ? "opacity-70 hover:opacity-100" : ""}`}>
        {embedded ? <span /> : <ToolbarGroup><ToolbarButton aria-label="Back" isSelected={false} onChange={() => onBack?.()}><ChevronLeft /></ToolbarButton></ToolbarGroup>}
        <ToolbarTitle title={material.title} subtitle={subtitle} />
        <ToolbarGroup>
          <span className={`mr-1.5 inline-flex h-[22px] items-center gap-1 rounded-pill px-2.5 text-[11.5px] font-medium ${quality.low ? "bg-orange-soft text-orange-text" : "bg-fill text-label-2"}`}>{quality.text}</span>
          <ToolbarButton aria-label="Contents (t)" isSelected={tocPinned} onChange={setTocPinned}><List /></ToolbarButton>
          <ToolbarButton aria-label="Notes (n)" isSelected={inspectorTab === "notes"} onChange={(on) => setInspectorTab(on ? "notes" : null)}><Highlighter /></ToolbarButton>
          <ReadingSettings prefs={prefs} onChange={setPrefs} />
          <AskButton aria-label="Ask" isSelected={inspectorTab === "agent"} onChange={(on) => setInspectorTab(on ? "agent" : null)}><Sparkles />Ask<Kbd>⌘J</Kbd></AskButton>
        </ToolbarGroup>
      </Toolbar>

      <main key={material.id} className="reader-enter relative grid min-h-0 grid-rows-[2px_minmax(0,1fr)] overflow-hidden rounded-panel bg-content shadow-[0_0_0_1px_var(--separator-soft),0_6px_20px_rgba(15,17,21,.04)]">
        <div className="bg-separator-soft">{prefs.focus ? null : <i className="block h-full bg-accent opacity-80" style={{ width: `${progress}%` }} />}</div>
        {findOpen ? <FindBar root={bodyRef.current} generation={bodyGeneration} onClose={() => setFindOpen(false)} /> : null}
        <SelectionToolbar root={bodyRef.current} viewport={viewportRef.current} capture={captureSelection} onHighlight={onHighlight} onNote={(capture) => void onNote(capture)} onCopy={onCopyCapture} onAsk={(capture) => { setAsked(capture); setInspectorTab("agent"); }} />
        {outline.length > 1 ? (
          <div className="pointer-events-none absolute inset-y-6 right-5 z-10 flex items-center">
            <TocRail aria-label="Contents" entries={outline.map((entry) => ({ id: entry.id, label: entry.label, level: entry.level - 1 }))} activeId={activeHeading} pinned={tocPinned} onSelect={(id) => document.getElementById(id)?.scrollIntoView({ block: "start", behavior: "smooth" })} />
          </div>
        ) : null}
        <div ref={viewportRef} className="reader-viewport overflow-auto px-14 pb-[120px] pt-12" style={prefsStyle(prefs)}>
          <article ref={bodyRef} className="reader-body" style={{ textAlign: prefs.justify ? "justify" : "start" }}>
            <p className="mb-3 text-[13px] font-medium text-accent-text">{host}</p>
            <h1>{material.title}</h1>
            <div className="mb-8 flex flex-wrap gap-x-3 text-[12.5px] text-label-2">
              {material.byline ? <span>{material.byline}</span> : null}
              {material.publishedAt ? <span>{new Date(material.publishedAt).toLocaleDateString()}</span> : null}
              <span>{material.readingMinutes} min</span>
              {material.origin === "agent" ? null : <a href={material.finalUrl} onClick={(event) => { event.preventDefault(); onOpenLink(material.finalUrl); }}>Open original ↗</a>}
            </div>
            {material.origin === "agent" && material.lineage ? <ArtifactLineage lineage={material.lineage} onOpenMaterial={onOpenMaterial} /> : null}
            {material.quality.safety === "degraded_plaintext" ? (
              <div className="mb-6 grid gap-2 rounded-card bg-content-2 p-4 text-[13px] text-label-2"><strong className="text-[16px] text-label">Could not extract an article from this page.</strong><span>What the page returned is shown below as plain text. <a href={material.finalUrl} onClick={(event) => { event.preventDefault(); onOpenLink(material.finalUrl); }}>Open the original</a> for the full page.</span></div>
            ) : quality.low ? (
              <div className="mb-6 grid gap-1.5 rounded-card bg-orange-soft p-4 text-[13px] text-label-2"><strong className="text-[14px] text-label">{material.quality.completeness === "summary" ? "Only a summary was available." : "The extraction may be incomplete."}</strong><span>{material.quality.completeness === "summary" ? "The full text is fetched when the source allows it. " : `The extractors disagreed about this page (${material.problems.length} notes). `}<a href={material.finalUrl} onClick={(event) => { event.preventDefault(); onOpenLink(material.finalUrl); }}>Open the original ↗</a></span></div>
            ) : null}
            <ReaderDocumentSurface
              schema={material.reader?.schema ?? "none"}
              payload={material.reader?.payload ?? ""}
              fallback={fallback}
              onOpenLink={onOpenLink}
              resolveImageSource={resolveImage}
              resolveRemoteImageSource={resolveImage}
              showFallbackNotice={false}
            />
          </article>
        </div>
      </main>

      {inspectorOpen ? (
        <Inspector aria-label="Inspector" selectedKey={inspectorTab} onSelectionChange={setInspectorTab}>
          <InspectorTabs>
            <InspectorTab id="notes"><Highlighter />Notes</InspectorTab>
            <InspectorTab id="agent"><Sparkles />Agent</InspectorTab>
          </InspectorTabs>
          <InspectorPanel id="notes">
            <NotesPanel material={material} annotations={annotations} error={annotationsError} activeId={activeAnnotation} draft={noteDraft} onDraftChange={setNoteDraft}
              onJump={jumpTo} onUpdateNote={(id, note) => void update(id, { note })} onDelete={(id) => void remove(id)}
              sectionFor={(annotation) => sectionOf(bodyRef.current ? resolveTextQuoteRange(bodyRef.current, annotation.locator, annotation.quote) : undefined)} />
          </InspectorPanel>
          <InspectorPanel id="agent"><AgentPanel context={agentContext} subject="this article" onOpenMaterial={onOpenMaterial} onOpenLink={onOpenLink} onClearSelection={() => setAsked(null)} /></InspectorPanel>
        </Inspector>
      ) : null}
    </div>
  );
}
