import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, Copy, Highlighter, List, Sparkles, Trash2 } from "lucide-react";
import { AskButton, Button, Inspector, InspectorPanel, InspectorSection, InspectorTab, InspectorTabs, Kbd, TextField, TocRail, Toolbar, ToolbarButton, ToolbarGroup, ToolbarTitle, type Key } from "@read/ui";
import { ReaderDocumentSurface, installTextAnnotationHighlights, resolveTextQuoteRange, textAnnotationHighlightStyles, useDocumentReadingPosition } from "@read/reader";
import { ANNOTATION_COLORS, annotationsMarkdown, citationFor, useAnnotations } from "./annotations";
import { SelectionToolbar, type SelectionCapture } from "./SelectionToolbar";
import type { Annotation } from "../../shared/contracts";
import { FindBar } from "./FindBar";
import { ReadingSettings } from "./ReadingSettings";
import { applyTheme, loadPrefs, prefsStyle, savePrefs, type ReadingPrefs } from "./readingPrefs";
import { read } from "./api";
import type { MaterialRecord } from "../../shared/contracts";

type OutlineEntry = { id: string; label: string; level: number };

function qualityLabel(material: MaterialRecord): { text: string; low: boolean } {
  const q = material.quality;
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

export function ReaderView({ material, onBack, onOpenLink }: { material: MaterialRecord; onBack: () => void; onOpenLink: (url: string) => void }) {
  const viewportRef = useRef<HTMLDivElement>(null);
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
  const [noteDraft, setNoteDraft] = useState<{ id: string; value: string } | null>(null);
  const [activeAnnotation, setActiveAnnotation] = useState<string | undefined>(undefined);
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
      setProgress(max > 0 ? Math.min(100, Math.round((viewport.scrollTop / max) * 100)) : 100);
      setReading(viewport.scrollTop > 40);
      setActiveHeading(currentHeading(viewport, bodyRef.current));
      if (idle !== undefined) window.clearTimeout(idle);
    };
    viewport.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => viewport.removeEventListener("scroll", onScroll);
  }, [material.id]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      if (event.key === "Escape") { event.preventDefault(); if (inspectorTab) setInspectorTab(null); else onBack(); }
      if (event.key === "t") { event.preventDefault(); setTocPinned((pinned) => !pinned); }
      if (event.key === "n" && !event.metaKey && !event.ctrlKey) { event.preventDefault(); setInspectorTab((tab) => (tab === "notes" ? null : "notes")); }
      if ((event.metaKey || event.ctrlKey) && event.key === "j") { event.preventDefault(); setInspectorTab((tab) => (tab === "agent" ? null : "agent")); }
      if ((event.metaKey || event.ctrlKey) && event.key === "f") { event.preventDefault(); setFindOpen(true); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [inspectorTab, onBack]);

  const fallback = useMemo(() => (material.markdown ? { content: material.markdown, format: "gfm" as const } : { content: material.plain ?? "", format: "plain" as const }), [material]);
  const subtitle = [(material.origin === "file" ? decodeURIComponent(material.url.replace("file:///", "")) : new URL(material.finalUrl).hostname), `${progress}%`, `${material.readingMinutes} min`].join(" · ");
  const inspectorOpen = inspectorTab !== null && !prefs.focus;

  return (
    <div className={inspectorOpen ? "grid h-full grid-cols-[minmax(0,1fr)_360px] grid-rows-[56px_minmax(0,1fr)] gap-3 p-3" : "grid h-full grid-cols-[minmax(0,1fr)] grid-rows-[56px_minmax(0,1fr)] gap-3 p-3"}>
      <Toolbar aria-label="Reader toolbar" className={`titlebar-drag col-span-full pl-[92px] transition-opacity ${reading ? "opacity-70 hover:opacity-100" : ""}`}>
        <ToolbarGroup><ToolbarButton aria-label="Back" isSelected={false} onChange={onBack}><ChevronLeft /></ToolbarButton></ToolbarGroup>
        <ToolbarTitle title={material.title} subtitle={subtitle} />
        <ToolbarGroup>
          <span className={`mr-1.5 inline-flex h-[22px] items-center gap-1 rounded-pill px-2.5 text-[11.5px] font-medium ${quality.low ? "bg-orange-soft text-orange-text" : "bg-fill text-label-2"}`}>{quality.text}</span>
          <ToolbarButton aria-label="Contents (t)" isSelected={tocPinned} onChange={setTocPinned}><List /></ToolbarButton>
          <ToolbarButton aria-label="Notes (n)" isSelected={inspectorTab === "notes"} onChange={(on) => setInspectorTab(on ? "notes" : null)}><Highlighter /></ToolbarButton>
          <ReadingSettings prefs={prefs} onChange={setPrefs} />
          <AskButton aria-label="Ask" isSelected={inspectorTab === "agent"} onChange={(on) => setInspectorTab(on ? "agent" : null)}><Sparkles />Ask<Kbd>⌘J</Kbd></AskButton>
        </ToolbarGroup>
      </Toolbar>

      <main className="relative grid min-h-0 grid-rows-[2px_minmax(0,1fr)] overflow-hidden rounded-panel bg-content shadow-[0_0_0_1px_var(--separator-soft),0_6px_20px_rgba(15,17,21,.04)]">
        <div className="bg-separator-soft">{prefs.focus ? null : <i className="block h-full bg-accent opacity-80" style={{ width: `${progress}%` }} />}</div>
        {findOpen ? <FindBar root={bodyRef.current} generation={bodyGeneration} onClose={() => setFindOpen(false)} /> : null}
        <SelectionToolbar root={bodyRef.current} viewport={viewportRef.current} onHighlight={onHighlight} onNote={(capture) => void onNote(capture)} onCopy={onCopyCapture} />
        {outline.length > 1 ? (
          <div className="pointer-events-none absolute inset-y-6 right-5 z-10 flex items-center">
            <TocRail aria-label="Contents" entries={outline.map((entry) => ({ id: entry.id, label: entry.label, level: entry.level - 1 }))} activeId={activeHeading} pinned={tocPinned} onSelect={(id) => document.getElementById(id)?.scrollIntoView({ block: "start", behavior: "smooth" })} />
          </div>
        ) : null}
        <div ref={viewportRef} className="overflow-auto px-14 pb-[120px] pt-12" style={prefsStyle(prefs)}>
          <article ref={bodyRef} className="reader-body" style={{ textAlign: prefs.justify ? "justify" : "start" }}>
            <p className="mb-3 text-[13px] font-medium text-accent-text">{(material.origin === "file" ? decodeURIComponent(material.url.replace("file:///", "")) : new URL(material.finalUrl).hostname)}</p>
            <h1>{material.title}</h1>
            <div className="mb-8 flex flex-wrap gap-x-3 text-[12.5px] text-label-2">
              {material.byline ? <span>{material.byline}</span> : null}
              {material.publishedAt ? <span>{new Date(material.publishedAt).toLocaleDateString()}</span> : null}
              <span>{material.readingMinutes} min</span>
              <a href={material.finalUrl} onClick={(event) => { event.preventDefault(); onOpenLink(material.finalUrl); }}>Open original ↗</a>
            </div>
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
              resolveImageSource={(url) => read.resolveImage(url)}
              resolveRemoteImageSource={(url) => read.resolveImage(url)}
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
            <InspectorSection title={annotations.length ? `${annotations.length} ${annotations.length === 1 ? "note" : "notes"}` : "Notes"}>
              {annotationsError ? <p role="alert" className="text-[13px] text-red">{annotationsError}</p> : null}
              {annotations.length === 0 && !annotationsError ? <p className="text-[13px] text-label-2">Select text to highlight it or add a note. Highlights are kept with this material.</p> : null}
              <ul className="m-0 grid list-none gap-2 p-0">
                {annotations.map((annotation) => (
                  <li key={annotation.id} className={`rounded-card bg-content-2 p-3 ${activeAnnotation === annotation.id ? "shadow-[inset_0_0_0_1.5px_var(--accent)]" : "shadow-[inset_0_0_0_1px_var(--separator-soft)]"}`}>
                    <button type="button" className="block w-full cursor-default border-0 bg-transparent p-0 text-left" onClick={() => jumpTo(annotation)}>
                      <span className="mb-1.5 flex items-center gap-2 text-[11px] text-label-3"><i aria-hidden="true" className="size-2.5 rounded-full" style={{ background: annotation.color }} />{new Date(annotation.updatedAt).toLocaleDateString()}</span>
                      <span className="block text-[13px] leading-[18px] text-label" style={{ boxShadow: `inset 3px 0 0 ${annotation.color}`, paddingLeft: 10 }}>{annotation.quote.length > 220 ? `${annotation.quote.slice(0, 220)}…` : annotation.quote}</span>
                    </button>
                    {noteDraft?.id === annotation.id ? (
                      <TextField autoFocus aria-label="Note" placeholder="Why it matters…" value={noteDraft.value} onChange={(value) => setNoteDraft({ id: annotation.id, value })} className="mt-2"
                        onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void update(annotation.id, { note: noteDraft.value.trim() }); setNoteDraft(null); } if (event.key === "Escape") { event.stopPropagation(); setNoteDraft(null); } }} />
                    ) : annotation.note ? (
                      <p className="mt-2 cursor-text text-[13px] text-label-2" onClick={() => setNoteDraft({ id: annotation.id, value: annotation.note ?? "" })}>{annotation.note}</p>
                    ) : null}
                    <div className="mt-2 flex items-center gap-1">
                      {noteDraft?.id !== annotation.id && !annotation.note ? <Button variant="plain" size="sm" onPress={() => setNoteDraft({ id: annotation.id, value: "" })}>Add note</Button> : null}
                      <Button variant="quiet" size="sm" aria-label="Copy citation" onPress={() => void copyText(citationFor(material, annotation, sectionOf(bodyRef.current ? resolveTextQuoteRange(bodyRef.current, annotation.locator, annotation.quote) : undefined)))}><Copy className="size-3.5" /></Button>
                      <Button variant="quiet" size="sm" aria-label="Delete" onPress={() => void remove(annotation.id)}><Trash2 className="size-3.5" /></Button>
                    </div>
                  </li>
                ))}
              </ul>
              {annotations.length ? <Button variant="default" size="sm" className="mt-3" onPress={() => void copyText(annotationsMarkdown(material, annotations))}>Copy all as Markdown</Button> : null}
            </InspectorSection>
          </InspectorPanel>
          <InspectorPanel id="agent"><InspectorSection title="Context"><span className="inline-flex h-[26px] items-center rounded-pill bg-content px-2.5 text-[12.5px] font-medium shadow-[0_0_0_1px_var(--separator)]">this article</span></InspectorSection><p className="text-[11.5px] text-label-3">Connect Codex in Settings to use Ask.</p></InspectorPanel>
        </Inspector>
      ) : null}
    </div>
  );
}
