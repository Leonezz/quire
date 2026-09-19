import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { Button } from "@read/ui";
import type { Annotation, MaterialRecord } from "../../shared/contracts";
import { read } from "./api";
import { annotationView, isPdfContent, viewOf } from "./materialViews";
import { PdfReaderView } from "./PdfReaderView";
import type { ReaderPanel } from "./ReaderInspector";
import { ReaderView } from "./ReaderView";
import { useMaterialView } from "./useMaterialView";

const FINISHED_AT = 0.95;
/** Materials whose "finished" event was recorded in this session: once per material, whatever pane shows it. */
const finished = new Set<string>();

export interface MaterialReaderProps {
  id: string;
  onOpenLink: (url: string) => void;
  onOpenMaterial: (id: string) => void;
  onBack?: (() => void) | undefined;
  onOpenSettings?: (() => void) | undefined;
  /** The shell's Add · Search icons for the toolbar segment. */
  trailing?: ReactNode;
}

/**
 * Loads a material by id and renders the reader for its chosen view inside a pane; records "finished" when reading passes 95%.
 * A metadata save from the Info panel replaces the record here, so the header, body and inspector show the new values at once.
 */
export function MaterialReader({ id, onOpenLink, onOpenMaterial, onBack, onOpenSettings, trailing }: MaterialReaderProps) {
  const [material, setMaterial] = useState<MaterialRecord | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [eventError, setEventError] = useState<string | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    setMaterial(undefined); setError(undefined); setEventError(undefined);
    const load = () => read.getMaterial(id)
      .then((record) => { if (cancelled) return; if (record) setMaterial(record); else setError("This material is no longer in the library."); })
      .catch((cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : "Could not load the material."); });
    void load();
    // The record is reloaded in place when the library changes (a rebuild set `rebuiltAs`, a view was fetched or made primary): no "Opening…" flash.
    const unsubscribe = read.onLibraryChanged(() => { void load(); });
    return () => { cancelled = true; unsubscribe(); };
  }, [id]);

  const onProgress = useCallback((fraction: number) => {
    if (fraction < FINISHED_AT || finished.has(id)) return;
    finished.add(id);
    read.recordReadingEvent("finished", id).catch((cause: unknown) => {
      finished.delete(id);
      setEventError(cause instanceof Error ? cause.message : "Could not record that you finished reading.");
    });
  }, [id]);

  if (error) return <div role="alert" className="grid flex-1 place-items-center p-10 text-center text-[13px] text-red-text">{error}</div>;
  if (!material) return <div className="grid flex-1 place-items-center text-[13px] text-label-3">Opening…</div>;
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <LoadedMaterialReader material={material} onMaterialChanged={setMaterial} onBack={onBack} onOpenLink={onOpenLink} onOpenMaterial={onOpenMaterial} onProgress={onProgress} onOpenSettings={onOpenSettings} trailing={trailing} />
      {eventError ? <div role="alert" className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-pill bg-red-soft px-3.5 py-1.5 text-[12.5px] text-red-text shadow-float">{eventError}</div> : null}
    </div>
  );
}

interface LoadedProps extends Omit<MaterialReaderProps, "id"> {
  material: MaterialRecord;
  onMaterialChanged: (record: MaterialRecord) => void;
  onProgress: (fraction: number) => void;
}

/** The chosen view of a loaded material: the PDF reader or the document reader for its content, remounted per view so position and progress are the view's own. */
function LoadedMaterialReader({ material, onMaterialChanged, onBack, onOpenLink, onOpenMaterial, onProgress, onOpenSettings, trailing }: LoadedProps) {
  const views = useMaterialView(material, onMaterialChanged);
  // A note on another view: the reader switches first, then the next reader jumps to it once its body is up.
  const [pendingJump, setPendingJump] = useState<Annotation | undefined>(undefined);
  const onJumpDone = useCallback(() => setPendingJump(undefined), []);
  const { fetchError, select } = views;
  useEffect(() => { if (fetchError) setPendingJump(undefined); }, [fetchError]);
  const jumpAcross = useCallback((annotation: Annotation) => {
    setPendingJump(annotation);
    select(annotationView(annotation, material.primaryView));
  }, [material.primaryView, select]);
  // The open panel survives a view switch (the readers own their panel state, so it is carried across the remount).
  const panelRef = useRef<ReaderPanel | null>(null);
  const onPanelChange = useCallback((panel: ReaderPanel | null) => { panelRef.current = panel; }, []);

  const { content } = views;
  if (content.status === "error") {
    const primary = viewOf(material.views, material.primaryView);
    return (
      <div role="alert" className="grid flex-1 place-content-center gap-3 p-10 text-center text-[13px]">
        <span className="text-red-text">{content.message}</span>
        {views.view !== material.primaryView && primary ? <Button size="sm" className="justify-self-center" onPress={() => views.select(material.primaryView)}>Read the {primary.label} view</Button> : null}
      </div>
    );
  }
  if (content.status === "loading") return <div className="grid flex-1 place-items-center text-[13px] text-label-3">Opening…</div>;
  const Reader = isPdfContent(content.content) ? PdfReaderView : ReaderView;
  const failedView = fetchError ? viewOf(material.views, fetchError.view) : undefined;
  return (
    <>
      <Reader key={`${material.id}:${views.view}`} material={material} content={content.content} views={views} onBack={onBack} onOpenLink={onOpenLink} onOpenMaterial={onOpenMaterial} onProgress={onProgress}
        onMaterialSaved={onMaterialChanged} onOpenSettings={onOpenSettings} trailing={trailing} pendingJump={pendingJump} onJumpDone={onJumpDone} onJumpAcross={jumpAcross} initialPanel={panelRef.current} onPanelChange={onPanelChange} />
      {fetchError ? (
        <div role="alert" className="absolute bottom-3 left-1/2 flex max-w-[min(640px,90%)] -translate-x-1/2 items-center gap-2 rounded-pill bg-red-soft py-1 pl-3.5 pr-1 text-[12.5px] text-red-text shadow-float">
          <span className="min-w-0 truncate">Could not fetch the {failedView?.label ?? fetchError.view} view — {fetchError.message}</span>
          <Button size="sm" variant="plain" className="h-6 shrink-0 px-2 text-red-text" onPress={() => views.select(fetchError.view)}>Retry</Button>
          <Button size="sm" variant="quiet" aria-label="Dismiss" className="shrink-0 text-red-text" onPress={views.dismissFetchError}><X /></Button>
        </div>
      ) : null}
    </>
  );
}
