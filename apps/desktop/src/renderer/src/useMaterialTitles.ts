import { useEffect, useMemo, useState } from "react";
import type { MaterialSummary } from "../../shared/contracts";
import { read } from "./api";

/**
 * Material id → title (and the whole summary), for citation pills, source lists, lineage lists and
 * session rows. Loaded once and again whenever the library changes (an artifact the agent just wrote
 * gets its title at once). `titles` is undefined until the first load, so a caller can tell "unknown"
 * from "not loaded yet".
 */
export function useMaterialTitles(): { titles: Map<string, string> | undefined; summaries: Map<string, MaterialSummary> | undefined; error: string | undefined; titleOf: (id: string) => string | undefined } {
  const [summaries, setSummaries] = useState<Map<string, MaterialSummary> | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      read.listMaterials()
        .then((list: MaterialSummary[]) => { if (!cancelled) { setSummaries(new Map(list.map((material) => [material.id, material]))); setError(undefined); } })
        .catch((cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : "Could not load material titles."); });
    };
    load();
    const unsubscribe = read.onLibraryChanged(load);
    return () => { cancelled = true; unsubscribe(); };
  }, []);
  const titles = useMemo(() => (summaries ? new Map([...summaries].map(([id, material]) => [id, material.title])) : undefined), [summaries]);
  return { titles, summaries, error, titleOf: (id) => titles?.get(id) };
}
