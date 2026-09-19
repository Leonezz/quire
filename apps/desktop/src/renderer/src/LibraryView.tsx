import { useEffect, useState } from "react";
import { Copy, Trash2 } from "lucide-react";
import { Button, ConfirmSheet, ItemList, ItemRow, Kbd, type Selection } from "@read/ui";
import type { MaterialSummary } from "../../shared/contracts";
import { read } from "./api";
import { ContentToolbar } from "./AppToolbar";
import { ContentColumn, ContentPane, EmptySentence, ListColumn, type ShellSlots } from "./ContentPane";
import { ErrorBoundary } from "./ErrorBoundary";
import { MaterialReader } from "./MaterialReader";
import { hostLabel } from "./ArtifactLineage";
import { InlineError } from "./ItemPreview";
import { isTypingTarget, timeOf } from "./format";
import { KIND_LABELS, publicationOf } from "./materialMeta";
import { viewLabel } from "./materialViews";
import type { Library } from "./useLibrary";

/** "Preprint · arxiv.org · Web + PDF": the bibliographic kind, then the publication when there is one, else where it came from, then the stored views when there are several. */
export function rowSource(item: MaterialSummary): string {
  const where = publicationOf(item) ?? (item.origin === "agent" ? "Agent" : item.origin === "file" ? "Local file" : hostLabel({ ...item, finalUrl: item.url }));
  const views = item.readyViews.length > 1 ? ` · ${item.readyViews.map(viewLabel).join(" + ")}` : "";
  return `${KIND_LABELS[item.kind]} · ${where}${views}`;
}
function rowTag(item: MaterialSummary): { tag: "artifact" | "rebuilt" | "summary" } | Record<string, never> {
  if (item.origin === "agent") return { tag: "artifact" };
  if (item.rebuiltAs) return { tag: "rebuilt" };
  if (item.quality.safety === "degraded_plaintext") return { tag: "summary" };
  return {};
}
export function selectedIds(selection: Selection, materials: readonly MaterialSummary[]): string[] {
  return selection === "all" ? materials.map((item) => item.id) : materials.filter((item) => selection.has(item.id)).map((item) => item.id);
}

export interface LibraryViewProps {
  library: Library;
  selected: Selection;
  onSelectionChange: (selection: Selection) => void;
  onOpenLink: (url: string) => void;
  onOpenMaterial: (id: string) => void;
  onOpenSettings: () => void;
  shell: ShellSlots;
  /** The scope is narrower than the whole library (a cut or a tag): an empty list says so. */
  narrowed: boolean;
}

/**
 * The Library (one cut, or one tag): the list on the left (multi-select with ⇧ / ⌘, ⌫ deletes
 * after asking, an action bar at the bottom while something is selected), the reader of the one
 * selected material on the right.
 */
export function LibraryView({ library, selected, onSelectionChange, onOpenLink, onOpenMaterial, onOpenSettings, shell, narrowed }: LibraryViewProps) {
  const { materials, error, loading } = library;
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | undefined>(undefined);
  const [bibtex, setBibtex] = useState<{ tone: "ok" | "error"; text: string } | undefined>(undefined);
  const ids = selectedIds(selected, materials);
  const chosen = ids.length === 1 ? materials.find((item) => item.id === ids[0]) : undefined;
  const searching = library.query.trim() !== "";
  const idsKey = ids.join(",");
  useEffect(() => { setBibtex(undefined); }, [idsKey]);

  // ⌫ / Delete with a selection asks to delete it, unless the focus is in a text field.
  useEffect(() => {
    if (ids.length === 0) return;
    const onKey = (event: KeyboardEvent) => {
      if ((event.key !== "Backspace" && event.key !== "Delete") || isTypingTarget(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
      event.preventDefault();
      setDeleteError(undefined); setConfirming(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ids.length]);

  const copyBibtex = async () => {
    try {
      await navigator.clipboard.writeText(await read.exportBibtex(ids));
      setBibtex({ tone: "ok", text: `Copied ${ids.length} ${ids.length === 1 ? "entry" : "entries"}` });
    } catch (cause: unknown) {
      setBibtex({ tone: "error", text: cause instanceof Error ? cause.message : "Could not export BibTeX." });
    }
  };
  const remove = async () => {
    setDeleting(true); setDeleteError(undefined);
    try {
      await read.deleteMaterials(ids);
      setConfirming(false);
      onSelectionChange(new Set());
      await library.refresh();
    } catch (cause: unknown) {
      setDeleteError(cause instanceof Error ? cause.message : "Could not delete the selected materials.");
    } finally { setDeleting(false); }
  };

  const actionBar = ids.length > 0 ? (
    <div className="flex items-center gap-2 border-t border-separator px-3 py-1.5 text-[12.5px] text-label-2">
      <span className="min-w-0 truncate">{bibtex ? <span role={bibtex.tone === "error" ? "alert" : "status"} className={bibtex.tone === "error" ? "text-red-text" : ""}>{bibtex.text}</span> : `${ids.length} selected`}</span>
      <Button size="sm" variant="quiet" className="ml-auto" onPress={() => void copyBibtex()}><Copy />Copy BibTeX</Button>
      <Button size="sm" variant="quiet" className="text-red-text" onPress={() => { setDeleteError(undefined); setConfirming(true); }}><Trash2 />Delete {ids.length} <Kbd>⌫</Kbd></Button>
    </div>
  ) : undefined;
  const empty = searching ? "Nothing matches your search." : narrowed ? "Nothing here yet." : "Nothing kept yet — press ⌘N and paste a page URL to read it here.";

  return (
    <>
      <ListColumn family="library" toolbar={shell.listToolbar} footer={actionBar}>
        {error ? <div className="p-3"><InlineError title="The library could not be loaded." message={error} /></div> : null}
        {materials.length ? (
          <ItemList aria-label="Library" items={materials} selectionMode="multiple" selectionBehavior="replace" selectedKeys={selected} onSelectionChange={onSelectionChange} className="flex-1">
            {(item) => <ItemRow id={item.id} title={item.title} source={rowSource(item)} time={timeOf(item.fetchedAt)} minutes={item.readingMinutes} state="read" signals={item.mediaType === "application/pdf" ? ["pdf"] : []} chips={item.tags}
              {...rowTag(item)} {...(item.origin === "agent" && item.lineage?.length ? { detail: <span className="text-label-3">from {item.lineage.length} {item.lineage.length === 1 ? "material" : "materials"}</span> } : {})} />}
          </ItemList>
        ) : loading && !error ? (
          <EmptySentence>Loading…</EmptySentence>
        ) : !error ? (
          <EmptySentence>{empty}</EmptySentence>
        ) : null}
      </ListColumn>
      <ContentColumn>
        {chosen ? (
          <ErrorBoundary key={chosen.id} label="The reader"><MaterialReader id={chosen.id} onOpenLink={onOpenLink} onOpenMaterial={onOpenMaterial} onOpenSettings={onOpenSettings} trailing={shell.trailing} /></ErrorBoundary>
        ) : (
          <ContentPane toolbar={<ContentToolbar trailing={shell.trailing} />} panel={shell.agentPanel}>
            <EmptySentence>{ids.length > 1 ? `${ids.length} materials selected — ⌫ deletes them, or select one to read it.` : "Select something to read."}</EmptySentence>
          </ContentPane>
        )}
      </ContentColumn>
      <ConfirmSheet isOpen={confirming} title={`Delete ${ids.length} ${ids.length === 1 ? "material" : "materials"}?`} message="Highlights and notes go with them. Inbox history keeps the titles."
        confirmLabel={`Delete ${ids.length}`} busyLabel="Deleting…" busy={deleting} error={deleteError} onConfirm={() => void remove()} onCancel={() => setConfirming(false)} />
    </>
  );
}
