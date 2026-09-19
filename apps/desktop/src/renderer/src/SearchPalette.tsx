import { useEffect, useRef, useState } from "react";
import { CommandPalette, type CommandPaletteItem } from "@read/ui";
import type { SearchHit } from "../../shared/contracts";
import { read } from "./api";

const DEBOUNCE_MS = 120;
const keyOf = (hit: SearchHit) => `${hit.kind}:${hit.id}`;

/** ⌘K: titles across the library and the inbox, debounced; a hit opens where it lives. */
export function SearchPalette({ open, onOpenChange, onOpenMaterial, onOpenItem }: { open: boolean; onOpenChange: (open: boolean) => void; onOpenMaterial: (id: string) => void; onOpenItem: (id: string) => void }) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const generation = useRef(0);

  useEffect(() => { if (!open) { setQuery(""); setHits([]); setError(undefined); } }, [open]);

  useEffect(() => {
    const trimmed = query.trim();
    const mine = ++generation.current;
    if (!trimmed) { setHits([]); setSearching(false); return; }
    setSearching(true);
    const timer = window.setTimeout(() => {
      read.search(trimmed)
        .then((results) => { if (generation.current === mine) { setHits(results); setError(undefined); } })
        .catch((cause: unknown) => { if (generation.current === mine) setError(cause instanceof Error ? cause.message : "Search failed."); })
        .finally(() => { if (generation.current === mine) setSearching(false); });
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  const items: CommandPaletteItem[] = hits.map((hit) => ({ id: keyOf(hit), title: hit.title, subtitle: hit.subtitle, kind: hit.kind === "material" ? "library" : "inbox" }));
  const status = error ?? (searching ? "Searching…" : query.trim() ? `${hits.length} ${hits.length === 1 ? "hit" : "hits"}` : "Titles, authors and sources across your library and inbox.");

  return (
    <CommandPalette aria-label="Search" isOpen={open} onOpenChange={onOpenChange} placeholder="Search…" query={query} onQueryChange={setQuery} items={items}
      status={status} statusIsError={error !== undefined} emptyText={searching ? "Searching…" : "Nothing matches."}
      onSelect={(key) => {
        const hit = hits.find((candidate) => keyOf(candidate) === key);
        if (!hit) return;
        onOpenChange(false);
        if (hit.kind === "material") onOpenMaterial(hit.id); else onOpenItem(hit.id);
      }} />
  );
}
