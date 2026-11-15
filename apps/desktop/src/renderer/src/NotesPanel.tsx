import { useId } from "react";
import { Copy, Trash2 } from "lucide-react";
import { Button, InspectorSection, TextField } from "@read/ui";
import type { TextAnnotationPlacement } from "@read/reader";
import type { Annotation, MaterialRecord, MaterialViewId } from "../../shared/contracts";
import { annotationsMarkdown, citationFor } from "./annotations";
import { annotationView, viewLabel } from "./materialViews";
import { showsViewTags } from "./mirroredAnnotations";

export type NoteDraft = { id: string; value: string };
/** Where the reader placed a note in the body it shows: "stale" only approximately, "unplaced" nowhere. */
export type NotePlacement = TextAnnotationPlacement["status"];

interface NoteCardProps {
  material: MaterialRecord;
  annotation: Annotation;
  active: boolean;
  draft: NoteDraft | null;
  onDraftChange: (draft: NoteDraft | null) => void;
  onJump: (annotation: Annotation) => void;
  onUpdateNote: (id: string, note: string) => void;
  onDelete: (id: string) => void;
  section: string | undefined;
  /** The view the note was made in, named on the card when the material stores both renderings of its PDF. */
  viewTag: string | undefined;
  placement: NotePlacement | undefined;
}

/** One highlight: its quote (click to jump, unless it is not in this version), the note edited inline, copy and delete. */
function NoteCard({ material, annotation, active, draft, onDraftChange, onJump, onUpdateNote, onDelete, section, viewTag, placement }: NoteCardProps) {
  const copyText = async (text: string) => { await navigator.clipboard.writeText(text); };
  const quote = (
    <>
      <span className="mb-1.5 flex items-center gap-2 text-[11px] text-label-3">
        <i aria-hidden="true" className="size-2.5 rounded-full" style={{ background: annotation.color }} />{new Date(annotation.updatedAt).toLocaleDateString()}
        {viewTag ? <span className="rounded-pill bg-fill px-1.5 text-[10px] font-medium leading-[14px] text-label-2" title={`Made in the ${viewTag} view`}>{viewTag}</span> : null}
      </span>
      <span className="block text-[13px] leading-[18px] text-label" style={{ boxShadow: `inset 3px 0 0 ${annotation.color}`, paddingLeft: 10 }}>{annotation.quote.length > 220 ? `${annotation.quote.slice(0, 220)}…` : annotation.quote}</span>
    </>
  );
  return (
    <li className={`rounded-card bg-content-2 p-3 ${active ? "shadow-[inset_0_0_0_1.5px_var(--accent)]" : "shadow-[inset_0_0_0_1px_var(--separator-soft)]"}`}>
      {placement === "unplaced" ? (
        // The body has no place for it, so the quote is not offered as a jump.
        <div>{quote}<span className="mt-1.5 block text-[11px] text-label-3">Not in this version of the text, so there is nothing to jump to.</span></div>
      ) : (
        <button type="button" className="block w-full cursor-default border-0 bg-transparent p-0 text-left" onClick={() => onJump(annotation)}>
          {quote}
          {placement === "stale" ? <span className="mt-1.5 block text-[11px] text-label-3">Re-placed approximately: the text changed since it was highlighted.</span> : null}
        </button>
      )}
      {draft?.id === annotation.id ? (
        <TextField autoFocus aria-label="Note" placeholder="Why it matters…" value={draft.value} onChange={(value) => onDraftChange({ id: annotation.id, value })} className="mt-2"
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); onUpdateNote(annotation.id, draft.value.trim()); onDraftChange(null); } if (event.key === "Escape") { event.stopPropagation(); onDraftChange(null); } }} />
      ) : annotation.note ? (
        <p className="mt-2 cursor-text text-[13px] text-label-2" onClick={() => onDraftChange({ id: annotation.id, value: annotation.note ?? "" })}>{annotation.note}</p>
      ) : null}
      <div className="mt-2 flex items-center gap-1">
        {draft?.id !== annotation.id && !annotation.note ? <Button variant="plain" size="sm" onPress={() => onDraftChange({ id: annotation.id, value: "" })}>Add note</Button> : null}
        <Button variant="quiet" size="sm" aria-label="Copy citation" onPress={() => void copyText(citationFor(material, annotation, section))}><Copy /></Button>
        <Button variant="quiet" size="sm" aria-label="Delete" onPress={() => onDelete(annotation.id)}><Trash2 /></Button>
      </div>
    </li>
  );
}

/** The notes by the view they are anchored in, in the material's view order (a view without notes is left out). */
export function groupByView(material: Pick<MaterialRecord, "views" | "primaryView">, annotations: readonly Annotation[]): { view: MaterialViewId; annotations: Annotation[] }[] {
  const order = material.views.map((view) => view.id);
  const known = new Set(order);
  const extra = [...new Set(annotations.map((annotation) => annotationView(annotation, material.primaryView)).filter((view) => !known.has(view)))];
  return [...order, ...extra]
    .map((view) => ({ view, annotations: annotations.filter((annotation) => annotationView(annotation, material.primaryView) === view) }))
    .filter((group) => group.annotations.length > 0);
}

/**
 * The Notes inspector: one card per highlight, notes edited inline, citations copied per note or all at once; grouped by view
 * when notes span several. Notes the reader could not place in this version are listed last, under a line that says so.
 */
export function NotesPanel({ material, view, mirroredViews = [], annotations, error, activeId, draft, onDraftChange, onJump, onUpdateNote, onDelete, sectionFor, placementOf }: {
  material: MaterialRecord;
  /** The view being read: its group comes with no explanation, another view's jump switches there first. */
  view: MaterialViewId;
  /** Views whose notes the reader shows in place (a PDF's notes in its text view and back): their jumps stay here. */
  mirroredViews?: readonly MaterialViewId[] | undefined;
  annotations: readonly Annotation[];
  error: string | undefined;
  activeId: string | undefined;
  draft: NoteDraft | null;
  onDraftChange: (draft: NoteDraft | null) => void;
  onJump: (annotation: Annotation) => void;
  onUpdateNote: (id: string, note: string) => void;
  onDelete: (id: string) => void;
  sectionFor: (annotation: Annotation) => string | undefined;
  /** Where the reader placed each note it shows (undefined for the notes it does not show, and in the PDF reader). */
  placementOf?: ((annotation: Annotation) => NotePlacement | undefined) | undefined;
}) {
  const copyText = async (text: string) => { await navigator.clipboard.writeText(text); };
  const unplacedId = useId();
  const unplaced = annotations.filter((annotation) => placementOf?.(annotation) === "unplaced");
  const placed = annotations.filter((annotation) => placementOf?.(annotation) !== "unplaced");
  const groups = groupByView(material, placed);
  // Headers whenever a note is anchored in another view than the one being read (jumping to it switches), or notes span views.
  const grouped = groups.length > 1 || groups.some((group) => group.view !== view);
  const tagged = showsViewTags(material.views);
  const inPlace = (group: MaterialViewId) => group === view || mirroredViews.includes(group);
  const card = (annotation: Annotation) => (
    <NoteCard key={annotation.id} material={material} annotation={annotation} active={activeId === annotation.id} draft={draft} onDraftChange={onDraftChange} onJump={onJump} onUpdateNote={onUpdateNote} onDelete={onDelete} section={sectionFor(annotation)}
      viewTag={tagged ? viewLabel(annotationView(annotation, material.primaryView)) : undefined} placement={placementOf?.(annotation)} />
  );
  return (
    <InspectorSection title={annotations.length ? `${annotations.length} ${annotations.length === 1 ? "note" : "notes"}` : "Notes"}>
      {error ? <p role="alert" className="t-text-in text-[13px] text-red">{error}</p> : null}
      {annotations.length === 0 && !error ? <p className="text-[13px] text-label-2">Select text to highlight it or add a note. Highlights are kept with this material.</p> : null}
      {grouped ? groups.map((group) => (
        <section key={group.view} className="mb-3" aria-label={`${viewLabel(group.view)} notes`}>
          <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-[.07em] text-label-3">{viewLabel(group.view)}{inPlace(group.view) ? "" : " · jumping switches the view"}</h4>
          <ul className="m-0 grid list-none gap-2 p-0">{group.annotations.map(card)}</ul>
        </section>
      )) : (
        <ul className="m-0 grid list-none gap-2 p-0">{placed.map(card)}</ul>
      )}
      {unplaced.length ? (
        <section className="mt-3" aria-labelledby={unplacedId}>
          <h4 id={unplacedId} className="mb-1.5 text-[12px] font-normal text-label-2">{unplaced.length} {unplaced.length === 1 ? "highlight" : "highlights"} could not be placed in this version</h4>
          <ul className="m-0 grid list-none gap-2 p-0">{unplaced.map(card)}</ul>
        </section>
      ) : null}
      {annotations.length ? <Button variant="default" size="sm" className="mt-3" onPress={() => void copyText(annotationsMarkdown(material, annotations))}>Copy all as Markdown</Button> : null}
    </InspectorSection>
  );
}
