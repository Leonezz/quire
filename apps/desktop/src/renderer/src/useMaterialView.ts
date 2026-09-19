import { useCallback, useEffect, useMemo, useState } from "react";
import type { MaterialRecord, MaterialView, MaterialViewContent, MaterialViewId } from "../../shared/contracts";
import { read } from "./api";
import { contentOfRecord, initialViewOf, rememberView, viewOf } from "./materialViews";

export type ViewContentState = { status: "loading" } | { status: "ready"; content: MaterialViewContent } | { status: "error"; message: string };
export interface ViewFetchError { view: MaterialViewId; message: string }

/** What the reader, its toolbar and the Info panel need to switch between a material's views. */
export interface MaterialViewController {
  /** The view being read. */
  view: MaterialViewId;
  views: readonly MaterialView[];
  primaryView: MaterialViewId;
  /** The chosen view's content: the record's own for the primary, loaded through getMaterialView otherwise. */
  content: ViewContentState;
  /** The view fetchMaterialView is storing right now (an `available` or `failed` one that was chosen), if any. */
  fetching: MaterialViewId | undefined;
  /** Why the last fetch did not go through; the view stayed where it was. Cleared by the next attempt or switch. */
  fetchError: ViewFetchError | undefined;
  /** Reads `view`: at once when it is ready, after fetching it when it is not. */
  select: (view: MaterialViewId) => void;
  /** Fetches and stores a view without switching to it (the Info panel's Fetch / Retry). Failures land in `fetchError`. */
  fetch: (view: MaterialViewId) => Promise<void>;
  /** Makes a ready view the one the reader opens first; throws with the engine's message when it cannot. */
  makePrimary: (view: MaterialViewId) => Promise<void>;
  dismissFetchError: () => void;
}

const messageOf = (cause: unknown, fallback: string) => (cause instanceof Error ? cause.message : fallback);

/**
 * The chosen view of a material (remembered per material in localStorage) and its content. A view that is
 * not stored yet is fetched first; the record handed back by the engine goes to `onMaterialChanged` so
 * the statuses (and, after "make primary", the record's own content) update without waiting for library:changed.
 */
export function useMaterialView(material: MaterialRecord, onMaterialChanged?: ((record: MaterialRecord) => void) | undefined): MaterialViewController {
  const [chosen, setChosen] = useState<{ id: string; view: MaterialViewId } | undefined>(undefined);
  const view = chosen?.id === material.id ? chosen.view : initialViewOf(material);
  const [fetching, setFetching] = useState<MaterialViewId | undefined>(undefined);
  const [fetchError, setFetchError] = useState<ViewFetchError | undefined>(undefined);
  const [remote, setRemote] = useState<{ key: string; state: ViewContentState } | undefined>(undefined);

  const primaryContent = useMemo(() => contentOfRecord(material), [material]);
  const isPrimary = view === material.primaryView;
  const remoteKey = `${material.id}:${view}`;
  const label = viewOf(material.views, view)?.label ?? view;

  useEffect(() => {
    if (isPrimary) return;
    let cancelled = false;
    setRemote({ key: remoteKey, state: { status: "loading" } });
    read.getMaterialView(material.id, view)
      .then((content) => {
        if (cancelled) return;
        setRemote({ key: remoteKey, state: content ? { status: "ready", content } : { status: "error", message: `The ${label} view is not stored for this material.` } });
      })
      .catch((cause: unknown) => { if (!cancelled) setRemote({ key: remoteKey, state: { status: "error", message: messageOf(cause, "Could not load this view.") } }); });
    return () => { cancelled = true; };
  }, [isPrimary, label, material.id, remoteKey, view]);

  const content: ViewContentState = isPrimary ? { status: "ready", content: primaryContent } : remote?.key === remoteKey ? remote.state : { status: "loading" };

  const switchTo = useCallback((target: MaterialViewId) => {
    rememberView(material.id, target);
    setChosen({ id: material.id, view: target });
    setFetchError(undefined);
  }, [material.id]);

  /** Runs fetchMaterialView for `target`; true when the engine stored it. */
  const fetchView = useCallback(async (target: MaterialViewId): Promise<boolean> => {
    if (!viewOf(material.views, target)) { setFetchError({ view: target, message: "This material has no such view." }); return false; }
    setFetching(target); setFetchError(undefined);
    try {
      const result = await read.fetchMaterialView(material.id, target);
      if (!result.ok) { setFetchError({ view: target, message: result.message }); return false; }
      onMaterialChanged?.(result.material);
      return true;
    } catch (cause: unknown) {
      setFetchError({ view: target, message: messageOf(cause, "Could not fetch this view.") });
      return false;
    } finally { setFetching(undefined); }
  }, [material.id, material.views, onMaterialChanged]);

  const select = useCallback((target: MaterialViewId) => {
    if (target === view || fetching !== undefined) return;
    const entry = viewOf(material.views, target);
    if (!entry) return;
    if (entry.status === "ready") { switchTo(target); return; }
    void fetchView(target).then((stored) => { if (stored) switchTo(target); });
  }, [fetchView, fetching, material.views, switchTo, view]);

  const fetch = useCallback(async (target: MaterialViewId) => { await fetchView(target); }, [fetchView]);

  const makePrimary = useCallback(async (target: MaterialViewId) => {
    const record = await read.setPrimaryView(material.id, target);
    onMaterialChanged?.(record);
  }, [material.id, onMaterialChanged]);

  const dismissFetchError = useCallback(() => setFetchError(undefined), []);

  return { view, views: material.views, primaryView: material.primaryView, content, fetching, fetchError, select, fetch, makePrimary, dismissFetchError };
}
