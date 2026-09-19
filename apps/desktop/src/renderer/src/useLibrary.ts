import { useCallback, useEffect, useRef, useState } from "react";
import type { LibraryFilter, MaterialKind, MaterialSummary, TagCount } from "../../shared/contracts";
import { read } from "./api";
import type { LibraryCut } from "./useScope";

export type LibrarySort = "newest" | "oldest" | "title";
export const SORT_LABELS: Record<LibrarySort, string> = { newest: "Newest", oldest: "Oldest", title: "Title" };
const SORTS: readonly LibrarySort[] = ["newest", "oldest", "title"];

/** The part of the scope the Library answers to: which cut, and one tag or none. */
export interface LibraryFocus { cut: LibraryCut; tag: string | undefined }

const SORT_KEY = "read:library-sort";
const QUERY_DEBOUNCE_MS = 120;
const ARTICLE_KINDS: ReadonlySet<MaterialKind> = new Set(["webpage", "blogPost", "newsletter", "newsArticle"]);
const PAPER_KINDS: ReadonlySet<MaterialKind> = new Set(["preprint", "journalArticle", "conferencePaper"]);

function loadSort(): LibrarySort {
  try {
    const raw = localStorage.getItem(SORT_KEY);
    return SORTS.includes(raw as LibrarySort) ? (raw as LibrarySort) : "newest";
  } catch {
    // Storage may be unavailable; newest first is the default order anyway.
    return "newest";
  }
}
function saveSort(sort: LibrarySort) {
  try { localStorage.setItem(SORT_KEY, sort); } catch { /* same as above */ }
}

/** Whether a material belongs to a cut. Articles and Papers are finer than the engine's kinds, so they are cut here. */
export function inCut(material: MaterialSummary, cut: LibraryCut): boolean {
  switch (cut) {
    case "all": return true;
    case "artifacts": return material.origin === "agent";
    case "articles": return material.origin !== "agent" && (ARTICLE_KINDS.has(material.kind) || material.mediaType === "text/markdown");
    case "papers": return PAPER_KINDS.has(material.kind) || material.mediaType === "application/pdf";
  }
}

/** The engine's filter for a focus, sort and query; "oldest" is the engine's newest-first reversed here. */
export function filterOf(focus: LibraryFocus, sort: LibrarySort, query: string): LibraryFilter {
  const words = query.trim();
  return { kind: focus.cut === "artifacts" ? "artifact" : "all", sort: sort === "title" ? "title" : "fetched", ...(focus.tag ? { tag: focus.tag } : {}), ...(words ? { query: words } : {}) };
}

export interface Library {
  materials: MaterialSummary[];
  /** Every tag in the library with its count, most used first. */
  tags: TagCount[];
  sort: LibrarySort;
  /** The search field's text, not remembered. */
  query: string;
  /** The last load failure, if any: shown in the pane, never swallowed. */
  error: string | undefined;
  loading: boolean;
  setSort: (sort: LibrarySort) => void;
  setQuery: (query: string) => void;
  refresh: () => Promise<void>;
}

/**
 * The Library list for a focus (cut + tag, from the sidebar) with its sort (remembered) and query
 * (debounced 120 ms). Reloads on mount, on every change, and when the engine reports a change.
 */
export function useLibrary(focus: LibraryFocus): Library {
  const [sort, setSortState] = useState<LibrarySort>(loadSort);
  const [query, setQuery] = useState("");
  const [materials, setMaterials] = useState<MaterialSummary[]>([]);
  const [tags, setTags] = useState<TagCount[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const generation = useRef(0);
  const inputs = useRef({ focus, sort, query });
  inputs.current = { focus, sort, query };

  const refresh = useCallback(async () => {
    const mine = ++generation.current;
    const current = inputs.current;
    setLoading(true);
    try {
      const [list, tagList] = await Promise.all([read.queryLibrary(filterOf(current.focus, current.sort, current.query)), read.listTags()]);
      if (generation.current !== mine) return;
      const cut = list.filter((material) => inCut(material, current.focus.cut));
      setMaterials(current.sort === "oldest" ? [...cut].reverse() : cut);
      setTags([...tagList].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)));
      setError(undefined);
    } catch (cause: unknown) {
      if (generation.current === mine) setError(cause instanceof Error ? cause.message : "Could not load the library.");
    } finally { if (generation.current === mine) setLoading(false); }
  }, []);

  // The focus and the sort reload at once; the query waits for the typing to pause.
  useEffect(() => { void refresh(); }, [focus.cut, focus.tag, sort, refresh]);
  useEffect(() => {
    const timer = window.setTimeout(() => { void refresh(); }, QUERY_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query, refresh]);
  useEffect(() => read.onLibraryChanged(() => { void refresh(); }), [refresh]);

  return {
    materials, tags, sort, query, error, loading,
    setSort: useCallback((next) => { saveSort(next); setSortState(next); }, []),
    setQuery,
    refresh,
  };
}
