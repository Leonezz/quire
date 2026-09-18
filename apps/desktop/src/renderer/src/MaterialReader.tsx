import { useCallback, useEffect, useState } from "react";
import type { MaterialRecord } from "../../shared/contracts";
import { read } from "./api";
import { PdfReaderView } from "./PdfReaderView";
import { ReaderView } from "./ReaderView";

const FINISHED_AT = 0.95;
/** Materials whose "finished" event was recorded in this session: once per material, whatever pane shows it. */
const finished = new Set<string>();

/** Loads a material by id and renders the matching reader inside a pane; records "finished" when reading passes 95%. */
export function MaterialReader({ id, onOpenLink, onOpenMaterial, onBack }: { id: string; onOpenLink: (url: string) => void; onOpenMaterial: (id: string) => void; onBack?: (() => void) | undefined }) {
  const [material, setMaterial] = useState<MaterialRecord | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [eventError, setEventError] = useState<string | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    setMaterial(undefined); setError(undefined); setEventError(undefined);
    read.getMaterial(id)
      .then((record) => { if (cancelled) return; if (record) setMaterial(record); else setError("This material is no longer in the library."); })
      .catch((cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : "Could not load the material."); });
    return () => { cancelled = true; };
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
      {material.pdf ? <PdfReaderView material={material} onBack={onBack} onOpenLink={onOpenLink} onOpenMaterial={onOpenMaterial} onProgress={onProgress} embedded /> : <ReaderView material={material} onBack={onBack} onOpenLink={onOpenLink} onOpenMaterial={onOpenMaterial} onProgress={onProgress} embedded />}
      {eventError ? <div role="alert" className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-pill bg-red-soft px-3.5 py-1.5 text-[12.5px] text-red-text shadow-float">{eventError}</div> : null}
    </div>
  );
}
