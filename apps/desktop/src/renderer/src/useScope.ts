import { useCallback, useState } from "react";

/** The four cuts of the Library the sidebar offers. */
export type LibraryCut = "all" | "articles" | "papers" | "artifacts";
export const LIBRARY_CUTS: readonly LibraryCut[] = ["all", "articles", "papers", "artifacts"];
export const CUT_LABELS: Record<LibraryCut, string> = { all: "Library", articles: "Articles", papers: "Papers", artifacts: "Artifacts" };

/**
 * What the window shows: an action list (Inbox, Queue, Agent), a cut of the Library, one tag,
 * one source's undecided items, or source management. Chosen in the sidebar, remembered across launches.
 */
export type Scope =
  | { kind: "inbox" } | { kind: "queue" } | { kind: "agent" } | { kind: "sources" }
  | { kind: "library"; id: LibraryCut }
  | { kind: "tag"; id: string }
  | { kind: "source"; id: string };

export const DEFAULT_SCOPE: Scope = { kind: "inbox" };
const SCOPE_KEY = "read:scope";

/** The sidebar's option key for a scope: "inbox", "library:papers", "tag:react", "source:<id>". */
export function scopeKey(scope: Scope): string {
  return "id" in scope ? `${scope.kind}:${scope.id}` : scope.kind;
}

/** The inverse of `scopeKey`; undefined for a key that names no scope. */
export function scopeOfKey(key: string): Scope | undefined {
  if (key === "inbox" || key === "queue" || key === "agent" || key === "sources") return { kind: key };
  const colon = key.indexOf(":");
  if (colon < 0) return undefined;
  const kind = key.slice(0, colon);
  const id = key.slice(colon + 1);
  if (!id) return undefined;
  if (kind === "library") return (LIBRARY_CUTS as readonly string[]).includes(id) ? { kind, id: id as LibraryCut } : undefined;
  if (kind === "tag" || kind === "source") return { kind, id };
  return undefined;
}

/** Which family of list widths a scope uses: every scope in a family shares one remembered width. */
export function scopeFamily(scope: Scope): "library" | "items" | "agent" | "sources" {
  switch (scope.kind) {
    case "library": case "tag": return "library";
    case "inbox": case "queue": case "source": return "items";
    case "agent": return "agent";
    case "sources": return "sources";
  }
}

function loadScope(): Scope {
  try {
    const raw = localStorage.getItem(SCOPE_KEY);
    return (raw && scopeOfKey(raw)) || DEFAULT_SCOPE;
  } catch {
    // Storage may be unavailable; the Inbox is where a session starts anyway.
    return DEFAULT_SCOPE;
  }
}
function saveScope(scope: Scope) {
  try { localStorage.setItem(SCOPE_KEY, scopeKey(scope)); } catch { /* same as above */ }
}

/** The current scope and its setter; the choice is remembered under `read:scope`. */
export function useScope(): [Scope, (scope: Scope) => void] {
  const [scope, setScope] = useState<Scope>(loadScope);
  const change = useCallback((next: Scope) => { saveScope(next); setScope(next); }, []);
  return [scope, change];
}
