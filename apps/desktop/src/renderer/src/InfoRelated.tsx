import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { Button, Chip, CommandPalette, type CommandPaletteItem } from "@read/ui";
import type { MaterialSummary } from "../../shared/contracts";
import { read } from "./api";
import { hostLabel } from "./ArtifactLineage";
import { ExtractedLine } from "./InfoFields";
import { KIND_LABELS } from "./materialMeta";
import { useMaterialTitles } from "./useMaterialTitles";
import type { MaterialMetaEditor } from "./useMaterialMeta";

const MAX_HITS = 30;

/** Every word of the query must appear in the title, byline or host. */
function matches(summary: MaterialSummary, words: readonly string[]): boolean {
  const haystack = `${summary.title} ${summary.byline ?? ""} ${hostLabel({ ...summary, finalUrl: summary.url })}`.toLowerCase();
  return words.every((word) => haystack.includes(word));
}

/**
 * Related materials as chips (a chip opens the material, × unlinks it) and "+ Add", a palette over
 * the library that excludes this material and the ones already linked.
 */
export function InfoRelated({ editor, selfId, onOpenMaterial }: { editor: MaterialMetaEditor; selfId: string; onOpenMaterial: (id: string) => void }) {
  const related = editor.meta.related ?? [];
  const { titles, error: titlesError } = useMaterialTitles();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [library, setLibrary] = useState<MaterialSummary[]>([]);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!open) { setQuery(""); return; }
    let cancelled = false;
    read.listMaterials()
      .then((list) => { if (!cancelled) { setLibrary(list); setLoadError(undefined); } })
      .catch((cause: unknown) => { if (!cancelled) setLoadError(cause instanceof Error ? cause.message : "Could not list the library."); });
    return () => { cancelled = true; };
  }, [open]);

  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const candidates = library.filter((summary) => summary.id !== selfId && !related.includes(summary.id) && (words.length === 0 || matches(summary, words)));
  const items: CommandPaletteItem[] = candidates.slice(0, MAX_HITS).map((summary) => ({ id: summary.id, title: summary.title, subtitle: [summary.byline, hostLabel({ ...summary, finalUrl: summary.url })].filter(Boolean).join(" · "), kind: KIND_LABELS[summary.kind] }));
  const link = (id: string) => { setOpen(false); void editor.save({ related: [...related, id] }); };
  const unlink = (id: string) => void editor.save({ related: related.filter((candidate) => candidate !== id) });
  const disabled = editor.saving === "related";

  return (
    <div className="grid gap-1.5">
      <span className="text-[12.5px] font-medium text-label-2">Related</span>
      <div className="flex flex-wrap items-center gap-1.5">
        {related.map((id) => {
          const title = titles?.get(id) ?? (titles ? `Material ${id.slice(0, 8)} (no longer in the library)` : "…");
          return (
            <Chip key={id} onRemove={disabled ? undefined : () => unlink(id)} removeLabel={`Unlink ${title}`} className="max-w-full">
              <button type="button" className="cursor-default border-0 bg-transparent p-0 text-current hover:underline" onClick={() => onOpenMaterial(id)}>{title}</button>
            </Chip>
          );
        })}
        <Button size="sm" variant="plain" className="h-[22px] gap-0.5 px-1.5" isDisabled={disabled} onPress={() => setOpen(true)}><Plus className="size-3" />Add</Button>
      </div>
      {titlesError ? <p role="alert" className="m-0 text-[12px] text-red">{titlesError}</p> : null}
      {editor.errors.related ? <p role="alert" className="m-0 text-[12px] text-red">{editor.errors.related}</p> : null}
      <ExtractedLine editor={editor} field="related" />
      <CommandPalette aria-label="Add a related material" isOpen={open} onOpenChange={setOpen} placeholder="Find a material in the library…" query={query} onQueryChange={setQuery} items={items}
        status={loadError ?? (library.length ? `${candidates.length} ${candidates.length === 1 ? "material" : "materials"}` : "Loading…")} statusIsError={loadError !== undefined}
        emptyText="Nothing matches." onSelect={link} />
    </div>
  );
}
