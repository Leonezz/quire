import { useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import type { MaterialRecord, MaterialSummary } from "../../shared/contracts";
import { read } from "./api";

/** "Written by the agent from 3 materials" for an artifact, otherwise the host (or the file path) the material came from. */
export function hostLabel(material: Pick<MaterialRecord, "origin" | "url" | "finalUrl" | "lineage">): string {
  if (material.origin === "agent") {
    const count = material.lineage?.length ?? 0;
    return count ? `Written by the agent from ${count} ${count === 1 ? "material" : "materials"}` : "Written by the agent";
  }
  if (material.origin === "file") return decodeURIComponent(material.url.replace("file:///", ""));
  try { return new URL(material.finalUrl || material.url).hostname; } catch { return material.url; }
}

/**
 * The materials an agent artifact was written from; each opens the source. In the reader header
 * it is a collapsed line under the title; in the Info panel (`defaultOpen`) the list is shown at once.
 */
export function ArtifactLineage({ lineage, onOpenMaterial, defaultOpen = false }: { lineage: readonly string[]; onOpenMaterial: (id: string) => void; defaultOpen?: boolean }) {
  const [titles, setTitles] = useState<Map<string, string> | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    read.listMaterials()
      .then((list: MaterialSummary[]) => { if (!cancelled) setTitles(new Map(list.map((material) => [material.id, material.title]))); })
      .catch((cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : "Could not load the sources."); });
    return () => { cancelled = true; };
  }, []);
  if (lineage.length === 0) return null;
  return (
    <details open={defaultOpen} className={`group text-[12.5px] text-label-2 ${defaultOpen ? "" : "mb-8 -mt-5"}`}>
      <summary className="inline-flex cursor-default list-none items-center gap-1 rounded-pill py-0.5 pr-2 pl-1 text-accent-text outline-none hover:bg-accent-soft focus-visible:ring-[3px] focus-visible:ring-accent-ring [&::-webkit-details-marker]:hidden"><ChevronRight className="size-3.5 transition-transform group-open:rotate-90" />Sources</summary>
      {error ? <p role="alert" className="mt-1.5 text-red-text">{error}</p> : null}
      <ol className="mt-1.5 grid list-decimal gap-1 pl-6">
        {lineage.map((id) => (
          <li key={id}>
            <button type="button" className="cursor-default border-0 bg-transparent p-0 text-left text-[12.5px] text-label hover:text-accent-text" onClick={() => onOpenMaterial(id)}>
              {titles?.get(id) ?? (titles ? `Material ${id.slice(0, 8)} (no longer in the library)` : "…")}
            </button>
          </li>
        ))}
      </ol>
    </details>
  );
}
