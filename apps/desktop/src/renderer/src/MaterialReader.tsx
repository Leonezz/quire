import { useEffect, useState } from "react";
import type { MaterialRecord } from "../../shared/contracts";
import { read } from "./api";
import { PdfReaderView } from "./PdfReaderView";
import { ReaderView } from "./ReaderView";

/** Loads a material by id and renders the matching reader inside the Library pane. */
export function MaterialReader({ id, onOpenLink }: { id: string; onOpenLink: (url: string) => void }) {
  const [material, setMaterial] = useState<MaterialRecord | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    setMaterial(undefined); setError(undefined);
    read.getMaterial(id)
      .then((record) => { if (cancelled) return; if (record) setMaterial(record); else setError("This material is no longer in the library."); })
      .catch((cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : "Could not load the material."); });
    return () => { cancelled = true; };
  }, [id]);
  if (error) return <div role="alert" className="grid flex-1 place-items-center p-10 text-center text-[13px] text-red">{error}</div>;
  if (!material) return <div className="grid flex-1 place-items-center text-[13px] text-label-3">Opening…</div>;
  return material.pdf ? <PdfReaderView material={material} embedded /> : <ReaderView material={material} onOpenLink={onOpenLink} embedded />;
}
