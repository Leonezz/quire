import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, Highlighter, List, Sparkles } from "lucide-react";
import { AskButton, Inspector, InspectorPanel, InspectorSection, InspectorTab, InspectorTabs, Kbd, TocRail, Toolbar, ToolbarButton, ToolbarGroup, ToolbarTitle, type Key } from "@read/ui";
import { ReaderDocumentSurface, useDocumentReadingPosition } from "@read/reader";
import { FindBar } from "./FindBar";
import { ReadingSettings } from "./ReadingSettings";
import { applyTheme, loadPrefs, prefsStyle, savePrefs, type ReadingPrefs } from "./readingPrefs";
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
  useEffect(() => { savePrefs(prefs); applyTheme(prefs.theme); }, [prefs]);
  useEffect(() => { if (prefs.focus) setInspectorTab(null); }, [prefs.focus]);
  const quality = qualityLabel(material);
  const identity = material.reader ? `${material.id}:${material.reader.schema}` : material.id;

  useDocumentReadingPosition(viewportRef, identity);

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
      if (event.key === "n") { event.preventDefault(); setInspectorTab((tab) => (tab === "notes" ? null : "notes")); }
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
              <div className="mb-6 grid gap-2 rounded-card bg-content-2 p-4 text-[13px] text-label-2"><strong className="text-[16px] text-label">Could not extract an article from this page.</strong><span>What the page returned is shown below as plain text. Open the original for the full page.</span></div>
            ) : null}
            <ReaderDocumentSurface
              schema={material.reader?.schema ?? "none"}
              payload={material.reader?.payload ?? ""}
              fallback={fallback}
              onOpenLink={onOpenLink}
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
          <InspectorPanel id="notes"><InspectorSection title="Notes"><p className="text-[13px] text-label-2">Highlights arrive in M1.</p></InspectorSection></InspectorPanel>
          <InspectorPanel id="agent"><InspectorSection title="Context"><span className="inline-flex h-[26px] items-center rounded-pill bg-content px-2.5 text-[12.5px] font-medium shadow-[0_0_0_1px_var(--separator)]">this article</span></InspectorSection><p className="text-[11.5px] text-label-3">Connect Codex in Settings to use Ask.</p></InspectorPanel>
        </Inspector>
      ) : null}
    </div>
  );
}
