import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, List, Sparkles } from "lucide-react";
import { AskButton, Kbd, TocRail, Toolbar, ToolbarButton, ToolbarGroup, ToolbarTitle } from "@read/ui";
import { PdfCanvasViewer, pdfReadingProgress, usePdfReaderStateMemory, type PdfCanvasViewerHandle, type PdfOutlineEntry, type PdfReaderState } from "@read/reader-pdf";
import type { MaterialRecord } from "../../shared/contracts";
import { read } from "./api";
import { ReadingSettings } from "./ReadingSettings";
import { applyTheme, loadPrefs, savePrefs, type ReadingPrefs } from "./readingPrefs";

type Loaded = { status: "loading" } | { status: "ready"; url: string } | { status: "error"; message: string };

/** PDF reading: the same toolbar contract as the article reader, the pages rendered by pdf.js. */
export function PdfReaderView({ material, onBack }: { material: MaterialRecord; onBack: () => void }) {
  const pdf = material.pdf;
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  const [prefs, setPrefs] = useState<ReadingPrefs>(loadPrefs);
  const [progress, setProgress] = useState(0);
  const [askOpen, setAskOpen] = useState(false);
  const [outline, setOutline] = useState<readonly PdfOutlineEntry[]>([]);
  const [page, setPage] = useState(1);
  const [tocPinned, setTocPinned] = useState(false);
  const viewerRef = useRef<PdfCanvasViewerHandle>(null);
  const identity = `${material.id}:pdf`;
  const { initialState, remember } = usePdfReaderStateMemory(identity, pdf?.pages ?? 0);
  const urlRef = useRef<string | undefined>(undefined);

  useEffect(() => { savePrefs(prefs); applyTheme(prefs.theme); }, [prefs]);

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

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target?.tagName === "INPUT" || target?.tagName === "TEXTAREA";
      if (event.key === "Escape" && !typing) { event.preventDefault(); if (askOpen) setAskOpen(false); else onBack(); }
      if ((event.metaKey || event.ctrlKey) && event.key === "j") { event.preventDefault(); setAskOpen((open) => !open); }
      if (event.key === "t" && !typing && !event.metaKey && !event.ctrlKey) { event.preventDefault(); setTocPinned((pinned) => !pinned); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [askOpen, onBack]);

  // The current section is the last outline entry that starts on or before the visible page.
  const activeEntry = useMemo(() => outline.filter((entry) => entry.page <= page).at(-1)?.id, [outline, page]);
  const tocEntries = useMemo(() => outline.map((entry) => ({ id: entry.id, label: entry.title, level: entry.level })), [outline]);

  const onReaderStateChange = (state: PdfReaderState) => {
    remember(state);
    setPage(state.page);
    const fraction = pdfReadingProgress(state, pdf?.pages);
    if (fraction !== undefined) setProgress(Math.round(fraction * 100));
  };

  const subtitle = [material.origin === "file" ? decodeURIComponent(material.url.replace("file:///", "")) : new URL(material.finalUrl).hostname, pdf ? `${pdf.pages} pages` : "", `${progress}%`].filter(Boolean).join(" · ");

  return (
    <div className="grid h-full grid-cols-[minmax(0,1fr)] grid-rows-[56px_minmax(0,1fr)] gap-3 p-3">
      <Toolbar aria-label="Reader toolbar" className="titlebar-drag col-span-full pl-[92px]">
        <ToolbarGroup><ToolbarButton aria-label="Back" isSelected={false} onChange={onBack}><ChevronLeft /></ToolbarButton></ToolbarGroup>
        <ToolbarTitle title={material.title} subtitle={subtitle} />
        <ToolbarGroup>
          <span className={`mr-1.5 inline-flex h-[22px] items-center gap-1 rounded-pill px-2.5 text-[11.5px] font-medium ${pdf?.textLayer === "absent" ? "bg-orange-soft text-orange-text" : "bg-fill text-label-2"}`}>{pdf?.textLayer === "absent" ? "scanned PDF" : "PDF"}</span>
          <ToolbarButton aria-label="Contents (t)" isSelected={tocPinned} isDisabled={outline.length === 0} onChange={setTocPinned}><List /></ToolbarButton>
          <ReadingSettings prefs={prefs} onChange={setPrefs} />
          <AskButton aria-label="Ask" isSelected={askOpen} onChange={setAskOpen}><Sparkles />Ask<Kbd>⌘J</Kbd></AskButton>
        </ToolbarGroup>
      </Toolbar>

      <main className="relative grid min-h-0 grid-rows-[2px_minmax(0,1fr)] overflow-hidden rounded-panel bg-content shadow-[0_0_0_1px_var(--separator-soft),0_6px_20px_rgba(15,17,21,.04)]">
        <div className="bg-separator-soft"><i className="block h-full bg-accent opacity-80" style={{ width: `${progress}%` }} /></div>
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
          />
        ) : loaded.status === "error" ? (
          <div className="grid place-items-center p-10 text-center"><div className="grid max-w-[420px] gap-2"><strong className="text-[16px] text-label">Could not open this PDF.</strong><span className="text-[13px] text-label-2">{loaded.message}</span></div></div>
        ) : (
          <div className="grid place-items-center text-[13px] text-label-3">Opening…</div>
        )}
      </main>
    </div>
  );
}
