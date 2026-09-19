import { useEffect, useState, type ReactNode } from "react";
import { ArrowDownWideNarrow, BookOpen, ChevronDown, Copy, Tag, Trash2 } from "lucide-react";
import { Button, ConfirmSheet, ItemList, ItemRow, Kbd, Menu, MenuItem, MenuSelect, MenuTrigger, Search, Segment, Segmented, SplitGroup, SplitPanel, SplitSeparator, useSplitSizes, type Selection } from "@read/ui";
import type { MaterialSummary } from "../../shared/contracts";
import { read } from "./api";
import { ErrorBoundary } from "./ErrorBoundary";
import { MaterialReader } from "./MaterialReader";
import { hostLabel } from "./ArtifactLineage";
import { EmptyState, InlineError, panelClass } from "./ItemPreview";
import { isTypingTarget, timeOf } from "./format";
import { KIND_LABELS, isMaterialKind, publicationOf } from "./materialMeta";
import type { Library, LibraryKind, LibrarySort } from "./useLibrary";

const kindLabels: Record<LibraryKind, string> = { all: "All", articles: "Articles", pdf: "PDFs", artifact: "Artifacts", feed: "Feeds" };
const sortLabels: Record<LibrarySort, string> = { fetched: "Newest kept", published: "Newest published", title: "Title" };

/** "Preprint · arxiv.org": the bibliographic kind, then the publication when there is one, else where it came from. */
function rowSource(item: MaterialSummary): string {
  const where = publicationOf(item) ?? (item.origin === "agent" ? "Agent" : item.origin === "file" ? "Local file" : hostLabel({ ...item, finalUrl: item.url }));
  return `${KIND_LABELS[item.kind]} · ${where}`;
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

const ANY_TYPE = "__any";

/** Kind · type · tag · sort, under the toolbar at the top of the list. The query lives in the toolbar's search field. */
function FilterBar({ library }: { library: Library }) {
  const { state, tags, kinds, setKind, setMaterialKind, setTag, setSort } = library;
  const typeOptions = [{ id: ANY_TYPE, label: "Any type" }, ...kinds.map((entry) => ({ id: entry.kind, label: KIND_LABELS[entry.kind], count: entry.count }))];
  return (
    <div className="grid gap-1.5 border-b border-separator-soft px-2.5 pb-2 pt-2.5">
      <Search aria-label="Filter the library" placeholder="Filter titles, authors, publications, tags…" value={state.query} onChange={library.setQuery} className="h-8 text-[13px]" />
      <Segmented aria-label="Kind" className="flex [&_button]:px-2 [&_button]:text-[12px]" selectedKeys={[state.kind]} onSelectionChange={(keys) => { const key = [...keys][0]; if (key) setKind(key as LibraryKind); }}>
        {(Object.keys(kindLabels) as LibraryKind[]).map((kind) => <Segment key={kind} id={kind} className="flex-1 px-1.5 text-[12px]">{kindLabels[kind]}</Segment>)}
      </Segmented>
      <div className="flex flex-wrap items-center gap-1">
        <MenuSelect aria-label="Type" icon={<BookOpen className="size-3.5 shrink-0" />} variant={state.materialKind ? "plain" : "quiet"} className="max-w-[45%]" value={state.materialKind ?? ANY_TYPE} options={typeOptions}
          onChange={(id) => setMaterialKind(isMaterialKind(id) ? id : undefined)} />
        <MenuTrigger>
          <Button size="sm" variant={state.tag ? "plain" : "quiet"} className="min-w-0 max-w-[40%] gap-1" aria-label={state.tag ? `Tag: ${state.tag}` : "Filter by tag"}><Tag className="size-3.5 shrink-0" /><span className="truncate">{state.tag ?? "Any tag"}</span><ChevronDown className="size-3 shrink-0 opacity-60" /></Button>
          <Menu aria-label="Tag" selectionMode="single" disallowEmptySelection selectedKeys={[state.tag ?? "__any"]} onSelectionChange={(keys) => { const key = keys === "all" ? undefined : [...keys][0]; setTag(key === undefined || key === "__any" ? undefined : String(key)); }}>
            <MenuItem id="__any">Any tag</MenuItem>
            {tags.map((entry) => <MenuItem key={entry.tag} id={entry.tag} textValue={entry.tag}><span className="min-w-0 flex-1 truncate">{entry.tag}</span><span className="text-[11.5px] tabular-nums opacity-60">{entry.count}</span></MenuItem>)}
            {tags.length === 0 ? <MenuItem id="__none" isDisabled textValue="No tags yet"><span className="text-label-3">No tags yet · add them in Info (i)</span></MenuItem> : null}
          </Menu>
        </MenuTrigger>
        <MenuTrigger>
          <Button size="sm" variant="quiet" className="ml-auto gap-1" aria-label={`Sort: ${sortLabels[state.sort]}`}><ArrowDownWideNarrow className="size-3.5" />{sortLabels[state.sort]}<ChevronDown className="size-3 opacity-60" /></Button>
          <Menu aria-label="Sort" selectionMode="single" disallowEmptySelection selectedKeys={[state.sort]} onSelectionChange={(keys) => { const key = keys === "all" ? undefined : [...keys][0]; if (key) setSort(key as LibrarySort); }}>
            {(Object.keys(sortLabels) as LibrarySort[]).map((sort) => <MenuItem key={sort} id={sort}>{sortLabels[sort]}</MenuItem>)}
          </Menu>
        </MenuTrigger>
      </div>
    </div>
  );
}

/**
 * The Library: the filtered list on the left (multi-select with ⇧ / ⌘, ⌫ deletes after asking),
 * the reader of the one selected material on the right.
 */
export function LibraryView({ library, toolbar, selected, onSelectionChange, onOpenLink, onOpenMaterial, onOpenSettings }: { library: Library; /** The shell toolbar, shown above the list so the reader's own title bar takes the top row. */ toolbar: ReactNode; selected: Selection; onSelectionChange: (selection: Selection) => void; onOpenLink: (url: string) => void; onOpenMaterial: (id: string) => void; onOpenSettings: () => void }) {
  const { materials, state, error, loading } = library;
  const sizes = useSplitSizes("library");
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | undefined>(undefined);
  const [bibtex, setBibtex] = useState<{ tone: "ok" | "error"; text: string } | undefined>(undefined);
  const ids = selectedIds(selected, materials);
  const chosen = ids.length === 1 ? materials.find((item) => item.id === ids[0]) : undefined;
  const filtered = state.kind !== "all" || state.materialKind !== undefined || state.tag !== undefined || state.query.trim() !== "";
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

  return (
    <>
    <SplitGroup id="library" aria-label="Library" className="h-full min-h-0 flex-1">
      <SplitPanel id="list" defaultSize={sizes.sizeOf("list", 340)} minSize={280} maxSize={560} onResize={sizes.onResize("list")}>
        <div className="grid h-full grid-rows-[56px_minmax(0,1fr)] gap-3">
        {toolbar}
        <section className={`flex h-full min-h-0 flex-col overflow-hidden ${panelClass}`}>
          <FilterBar library={library} />
          {error ? <div className="p-3"><InlineError title="The library could not be loaded." message={error} /></div> : null}
          {materials.length ? (
            <ItemList aria-label="Library" items={materials} selectionMode="multiple" selectionBehavior="replace" selectedKeys={selected} onSelectionChange={onSelectionChange} className="flex-1">
              {(item) => <ItemRow id={item.id} title={item.title} source={rowSource(item)} time={timeOf(item.fetchedAt)} minutes={item.readingMinutes} state="read" signals={item.mediaType === "application/pdf" ? ["pdf"] : []} chips={item.tags}
                {...rowTag(item)} {...(item.origin === "agent" && item.lineage?.length ? { detail: <span className="text-label-3">from {item.lineage.length} {item.lineage.length === 1 ? "material" : "materials"}</span> } : {})} />}
            </ItemList>
          ) : loading && !error ? (
            <div className="grid flex-1 place-items-center text-[13px] text-label-3">Loading…</div>
          ) : !error ? (
            filtered ? <EmptyState title="Nothing matches." hint="Loosen the kind, tag or search above." /> : <EmptyState title="Nothing kept yet." hint="Press ⌘N and paste a page URL to read it here." />
          ) : null}
          {ids.length > 0 ? (
            <div className="flex items-center gap-2 border-t border-separator-soft px-3 py-2 text-[12.5px] text-label-2">
              <span className="min-w-0 truncate">{bibtex ? <span role={bibtex.tone === "error" ? "alert" : "status"} className={bibtex.tone === "error" ? "text-red-text" : ""}>{bibtex.text}</span> : `${ids.length} selected`}</span>
              <Button size="sm" variant="quiet" className="ml-auto" onPress={() => void copyBibtex()}><Copy className="size-3.5" />Copy BibTeX</Button>
              <Button size="sm" variant="quiet" className="text-red-text" onPress={() => { setDeleteError(undefined); setConfirming(true); }}><Trash2 className="size-3.5" />Delete {ids.length} <Kbd>⌫</Kbd></Button>
            </div>
          ) : null}
        </section>
        </div>
      </SplitPanel>
      <SplitSeparator aria-label="Resize list" hit={12} footprint={12} line="hover" />
      <SplitPanel id="reader" minSize={420}>
        <section className="flex h-full min-h-0 flex-col">
          {chosen ? (
            <ErrorBoundary key={chosen.id} label="The reader"><MaterialReader id={chosen.id} onOpenLink={onOpenLink} onOpenMaterial={onOpenMaterial} onOpenSettings={onOpenSettings} /></ErrorBoundary>
          ) : ids.length > 1 ? (
            <div className={`grid flex-1 place-items-center text-center text-label-2 ${panelClass}`}><div><strong className="mb-1.5 block text-[18px] font-semibold text-label">{ids.length} materials selected</strong><span className="text-[13px]">Delete them with ⌫, or select one to read it.</span></div></div>
          ) : (
            <div className={`grid flex-1 place-items-center text-center text-label-2 ${panelClass}`}><div><strong className="mb-1.5 block text-[18px] font-semibold text-label">Nothing selected</strong><span className="text-[13px]">Select something you kept.</span></div></div>
          )}
        </section>
      </SplitPanel>
    </SplitGroup>
    <ConfirmSheet isOpen={confirming} title={`Delete ${ids.length} ${ids.length === 1 ? "material" : "materials"}?`} message="Highlights and notes go with them. Inbox history keeps the titles."
      confirmLabel={`Delete ${ids.length}`} busyLabel="Deleting…" busy={deleting} error={deleteError} onConfirm={() => void remove()} onCancel={() => setConfirming(false)} />
    </>
  );
}
