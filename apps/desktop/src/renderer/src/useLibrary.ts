import { useCallback, useEffect, useRef, useState } from "react";
import type { LibraryFilter, MaterialSummary, TagCount } from "../../shared/contracts";
import { read } from "./api";

export type LibraryKind = NonNullable<LibraryFilter["kind"]>;
export type LibrarySort = NonNullable<LibraryFilter["sort"]>;
/** What the Library shows: every field has a value so the controls never read an absent one. */
export interface LibraryState { kind: LibraryKind; tag: string | undefined; sort: LibrarySort; query: string }

const FILTER_KEY = "read:library-filter";
const QUERY_DEBOUNCE_MS = 120;
const DEFAULT_STATE: LibraryState = { kind: "all", tag: undefined, sort: "fetched", query: "" };
const KINDS: readonly LibraryKind[] = ["all", "articles", "pdf", "artifact", "feed"];
const SORTS: readonly LibrarySort[] = ["fetched", "published", "title"];

function loadState(): LibraryState {
  try {
    const raw = localStorage.getItem(FILTER_KEY);
    if (!raw) return DEFAULT_STATE;
    const parsed = JSON.parse(raw) as Partial<LibraryState>;
    return {
      kind: KINDS.includes(parsed.kind as LibraryKind) ? (parsed.kind as LibraryKind) : DEFAULT_STATE.kind,
      tag: typeof parsed.tag === "string" && parsed.tag ? parsed.tag : undefined,
      sort: SORTS.includes(parsed.sort as LibrarySort) ? (parsed.sort as LibrarySort) : DEFAULT_STATE.sort,
      query: "",
    };
  } catch {
    // Storage may be unavailable; the default filter is a legitimate mode.
    return DEFAULT_STATE;
  }
}
function saveState(state: LibraryState) {
  try { localStorage.setItem(FILTER_KEY, JSON.stringify({ kind: state.kind, tag: state.tag, sort: state.sort })); } catch { /* same as above */ }
}

export function filterOf(state: LibraryState): LibraryFilter {
  const query = state.query.trim();
  return { kind: state.kind, sort: state.sort, ...(state.tag ? { tag: state.tag } : {}), ...(query ? { query } : {}) };
}

export interface Library {
  materials: MaterialSummary[];
  tags: TagCount[];
  state: LibraryState;
  /** The last load failure, if any: shown in the pane, never swallowed. */
  error: string | undefined;
  loading: boolean;
  setKind: (kind: LibraryKind) => void;
  setTag: (tag: string | undefined) => void;
  setSort: (sort: LibrarySort) => void;
  setQuery: (query: string) => void;
  /** Drops the kind, tag and query (the sort stays) so a material opened from elsewhere is in the list. */
  clearFilter: () => void;
  refresh: () => Promise<void>;
}

/**
 * The Library list and its filter: kind, tag, sort (remembered) and the query (debounced 120 ms,
 * not remembered). Reloads on mount, on every filter change, and when the engine reports a change.
 */
export function useLibrary(): Library {
  const [state, setState] = useState<LibraryState>(loadState);
  const [materials, setMaterials] = useState<MaterialSummary[]>([]);
  const [tags, setTags] = useState<TagCount[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const generation = useRef(0);
  const stateRef = useRef(state);
  stateRef.current = state;

  const refresh = useCallback(async () => {
    const mine = ++generation.current;
    setLoading(true);
    try {
      const [list, tagList] = await Promise.all([read.queryLibrary(filterOf(stateRef.current)), read.listTags()]);
      if (generation.current !== mine) return;
      setMaterials(list); setTags(tagList); setError(undefined);
    } catch (cause: unknown) {
      if (generation.current === mine) setError(cause instanceof Error ? cause.message : "Could not load the library.");
    } finally { if (generation.current === mine) setLoading(false); }
  }, []);

  // Kind, tag and sort reload at once; the query waits for the typing to pause.
  useEffect(() => { saveState(state); void refresh(); }, [state.kind, state.tag, state.sort, refresh]);
  useEffect(() => {
    const timer = window.setTimeout(() => { void refresh(); }, QUERY_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [state.query, refresh]);
  useEffect(() => read.onLibraryChanged(() => { void refresh(); }), [refresh]);

  return {
    materials, tags, state, error, loading,
    setKind: useCallback((kind) => setState((current) => ({ ...current, kind })), []),
    setTag: useCallback((tag) => setState((current) => ({ ...current, tag })), []),
    setSort: useCallback((sort) => setState((current) => ({ ...current, sort })), []),
    setQuery: useCallback((query) => setState((current) => ({ ...current, query })), []),
    clearFilter: useCallback(() => setState((current) => ({ ...current, kind: "all", tag: undefined, query: "" })), []),
    refresh,
  };
}
