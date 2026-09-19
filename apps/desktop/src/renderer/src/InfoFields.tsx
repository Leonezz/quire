import { useEffect, useState, type ReactNode } from "react";
import { Button, TextField } from "@read/ui";
import { MATERIAL_KIND_FIELDS, type MaterialKind } from "../../shared/contracts";
import { dateFieldValue, fieldLabel } from "./materialMeta";
import type { MaterialMetaEditor, MetaField } from "./useMaterialMeta";

/** A text-valued field of the model (everything but the lists and the kind). */
export type TextMetaField = Exclude<MetaField, "kind" | "creators" | "tags" | "related">;
const IDENTIFIERS: readonly MetaField[] = ["doi", "arxivId", "isbn", "issn", "url"];

const PLACEHOLDERS: Partial<Record<TextMetaField, string>> = { date: "YYYY, YYYY-MM or YYYY-MM-DD", accessed: "YYYY-MM-DD", language: "en", pages: "1–12", abstract: "What the source says it is about…", note: "About this material (not a highlight)…", extra: "Anything that fits no field…" };

/** "extracted: <value> · Reset" under a field whose override differs from what was extracted. */
export function ExtractedLine({ editor, field }: { editor: MaterialMetaEditor; field: MetaField }) {
  if (!editor.overridden(field)) return null;
  const value = editor.extractedOf(field);
  return (
    <span className="-mt-1.5 flex min-w-0 items-center gap-1 text-[11.5px] text-label-3">
      <span className="min-w-0 truncate">extracted: {value ?? "nothing"}</span>
      <Button variant="plain" size="sm" className="h-5 shrink-0 px-1.5 text-[11.5px]" onPress={() => void editor.reset(field)} isDisabled={editor.saving === field}>Reset</Button>
    </span>
  );
}

/**
 * One text field of the metadata: saves on blur or Enter (Shift+Enter breaks a line in the
 * multiline ones), Escape puts the saved value back, the error stays under the field.
 */
export function MetaTextField({ editor, field, multiline = false, label, trailing }: { editor: MaterialMetaEditor; field: TextMetaField; multiline?: boolean; label?: string | undefined; trailing?: ReactNode }) {
  const current = field === "date" || field === "accessed" ? dateFieldValue(editor.meta[field]) : (editor.meta[field] ?? "");
  const [draft, setDraft] = useState(current);
  useEffect(() => { setDraft(current); }, [current]);
  const commit = () => {
    const value = draft.trim();
    if (value === current) return;
    void editor.save({ [field]: value });
  };
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Enter" && !(multiline && event.shiftKey)) { event.preventDefault(); (event.target as HTMLElement).blur(); }
    if (event.key === "Escape") { event.stopPropagation(); setDraft(current); }
  };
  const field_ = (
    <TextField label={label ?? fieldLabel(field, editor.meta.kind)} value={draft} onChange={setDraft} onBlur={commit} onKeyDown={onKeyDown}
      multiline={multiline} maxRows={8} placeholder={PLACEHOLDERS[field] ?? ""} isDisabled={editor.saving === field} isInvalid={editor.errors[field] !== undefined}
      errorMessage={editor.errors[field] ?? ""} className="min-w-0 flex-1" />
  );
  return (
    <div className="grid gap-1.5">
      {trailing ? <div className="flex items-end gap-1.5">{field_}{trailing}</div> : field_}
      <ExtractedLine editor={editor} field={field} />
    </div>
  );
}

/** The kind's own fields in MATERIAL_KIND_FIELDS order (identifiers go to their own group), then Date and Language. */
export function InfoFields({ editor, kind }: { editor: MaterialMetaEditor; kind: MaterialKind }) {
  const own = MATERIAL_KIND_FIELDS[kind].filter((field): field is TextMetaField => !IDENTIFIERS.includes(field) && field !== "creators" && field !== "tags" && field !== "related" && field !== "kind");
  return (
    <>
      {own.map((field) => <MetaTextField key={field} editor={editor} field={field} />)}
      <MetaTextField editor={editor} field="date" />
      <MetaTextField editor={editor} field="language" />
    </>
  );
}
