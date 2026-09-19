import { Copy, Trash2 } from "lucide-react";
import { Button, InspectorSection, TextField } from "@read/ui";
import type { Annotation, MaterialRecord } from "../../shared/contracts";
import { annotationsMarkdown, citationFor } from "./annotations";

export type NoteDraft = { id: string; value: string };

/** The Notes inspector: one card per highlight, notes edited inline, citations copied per note or all at once. */
export function NotesPanel({ material, annotations, error, activeId, draft, onDraftChange, onJump, onUpdateNote, onDelete, sectionFor }: {
  material: MaterialRecord;
  annotations: readonly Annotation[];
  error: string | undefined;
  activeId: string | undefined;
  draft: NoteDraft | null;
  onDraftChange: (draft: NoteDraft | null) => void;
  onJump: (annotation: Annotation) => void;
  onUpdateNote: (id: string, note: string) => void;
  onDelete: (id: string) => void;
  sectionFor: (annotation: Annotation) => string | undefined;
}) {
  const copyText = async (text: string) => { await navigator.clipboard.writeText(text); };
  return (
    <InspectorSection title={annotations.length ? `${annotations.length} ${annotations.length === 1 ? "note" : "notes"}` : "Notes"}>
      {error ? <p role="alert" className="text-[13px] text-red">{error}</p> : null}
      {annotations.length === 0 && !error ? <p className="text-[13px] text-label-2">Select text to highlight it or add a note. Highlights are kept with this material.</p> : null}
      <ul className="m-0 grid list-none gap-2 p-0">
        {annotations.map((annotation) => (
          <li key={annotation.id} className={`rounded-card bg-content-2 p-3 ${activeId === annotation.id ? "shadow-[inset_0_0_0_1.5px_var(--accent)]" : "shadow-[inset_0_0_0_1px_var(--separator-soft)]"}`}>
            <button type="button" className="block w-full cursor-default border-0 bg-transparent p-0 text-left" onClick={() => onJump(annotation)}>
              <span className="mb-1.5 flex items-center gap-2 text-[11px] text-label-3"><i aria-hidden="true" className="size-2.5 rounded-full" style={{ background: annotation.color }} />{new Date(annotation.updatedAt).toLocaleDateString()}</span>
              <span className="block text-[13px] leading-[18px] text-label" style={{ boxShadow: `inset 3px 0 0 ${annotation.color}`, paddingLeft: 10 }}>{annotation.quote.length > 220 ? `${annotation.quote.slice(0, 220)}…` : annotation.quote}</span>
            </button>
            {draft?.id === annotation.id ? (
              <TextField autoFocus aria-label="Note" placeholder="Why it matters…" value={draft.value} onChange={(value) => onDraftChange({ id: annotation.id, value })} className="mt-2"
                onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); onUpdateNote(annotation.id, draft.value.trim()); onDraftChange(null); } if (event.key === "Escape") { event.stopPropagation(); onDraftChange(null); } }} />
            ) : annotation.note ? (
              <p className="mt-2 cursor-text text-[13px] text-label-2" onClick={() => onDraftChange({ id: annotation.id, value: annotation.note ?? "" })}>{annotation.note}</p>
            ) : null}
            <div className="mt-2 flex items-center gap-1">
              {draft?.id !== annotation.id && !annotation.note ? <Button variant="plain" size="sm" onPress={() => onDraftChange({ id: annotation.id, value: "" })}>Add note</Button> : null}
              <Button variant="quiet" size="sm" aria-label="Copy citation" onPress={() => void copyText(citationFor(material, annotation, sectionFor(annotation)))}><Copy /></Button>
              <Button variant="quiet" size="sm" aria-label="Delete" onPress={() => onDelete(annotation.id)}><Trash2 /></Button>
            </div>
          </li>
        ))}
      </ul>
      {annotations.length ? <Button variant="default" size="sm" className="mt-3" onPress={() => void copyText(annotationsMarkdown(material, annotations))}>Copy all as Markdown</Button> : null}
    </InspectorSection>
  );
}
