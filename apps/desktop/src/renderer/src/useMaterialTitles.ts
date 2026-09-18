import { useEffect, useState } from "react";
import type { MaterialSummary } from "../../shared/contracts";
import { read } from "./api";

/**
 * Material id → title, for citation pills, lineage lists and session rows. Loaded once and again
 * whenever the library changes (an artifact the agent just wrote gets its title at once).
 * `titles` is undefined until the first load, so a caller can tell "unknown" from "not loaded yet".
 */
export function useMaterialTitles(): { titles: Map<string, string> | undefined; error: string | undefined; titleOf: (id: string) => string | undefined } {
  const [titles, setTitles] = useState<Map<string, string> | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      read.listMaterials()
        .then((list: MaterialSummary[]) => { if (!cancelled) { setTitles(new Map(list.map((material) => [material.id, material.title]))); setError(undefined); } })
        .catch((cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : "Could not load material titles."); });
    };
    load();
    const unsubscribe = read.onLibraryChanged(load);
    return () => { cancelled = true; unsubscribe(); };
  }, []);
  return { titles, error, titleOf: (id) => titles?.get(id) };
}
