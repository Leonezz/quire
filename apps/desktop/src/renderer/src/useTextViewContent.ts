import { useEffect, useState } from "react";
import type { MaterialRecord, MaterialViewContent } from "../../shared/contracts";
import { read } from "./api";
import { viewOf } from "./materialViews";

export type TextViewState =
  | { status: "absent" }
  | { status: "loading" }
  | { status: "ready"; content: MaterialViewContent }
  | { status: "error"; message: string };

const ABSENT: TextViewState = { status: "absent" };
const LOADING: TextViewState = { status: "loading" };

/** One load per built text view (keyed by material and build): every reader and panel of the material shares it. */
const loads = new Map<string, Promise<MaterialViewContent | undefined>>();

function loadKey(material: Pick<MaterialRecord, "id" | "views">): string | undefined {
  const entry = viewOf(material.views, "text");
  return entry?.status === "ready" ? `${material.id}:${entry.fetchedAt ?? ""}:${entry.byteLength ?? ""}` : undefined;
}

/**
 * The content of the material's text view (its `plain` and `anchors`) while the material stores one, for the
 * PDF reader's mirrored notes and the Info panel's report. Absent when the view is not built; a failed load
 * is reported, not hidden, and is retried by the next mount.
 */
export function useTextViewContent(material: Pick<MaterialRecord, "id" | "views">): TextViewState {
  const key = loadKey(material);
  const id = material.id;
  const [state, setState] = useState<{ key: string; state: TextViewState } | undefined>(undefined);

  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    setState({ key, state: LOADING });
    const load = loads.get(key) ?? read.getMaterialView(id, "text");
    loads.set(key, load);
    load
      .then((content) => {
        if (cancelled) return;
        setState({ key, state: content ? { status: "ready", content } : { status: "error", message: "The text view is not stored for this material." } });
      })
      .catch((cause: unknown) => {
        loads.delete(key);
        if (!cancelled) setState({ key, state: { status: "error", message: cause instanceof Error ? cause.message : "Could not load the text view." } });
      });
    return () => { cancelled = true; };
  }, [id, key]);

  if (!key) return ABSENT;
  return state?.key === key ? state.state : LOADING;
}
