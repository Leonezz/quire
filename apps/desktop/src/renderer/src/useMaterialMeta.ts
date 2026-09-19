import { useCallback, useState } from "react";
import type { MaterialKind, MaterialMeta, MaterialRecord } from "../../shared/contracts";
import { read } from "./api";
import { DATE_RULE, extractedText, isOverridden, isValidDate } from "./materialMeta";

export type MetaField = keyof MaterialMeta;
export type MetaErrors = Partial<Record<MetaField, string>>;

/** What a field's patch must satisfy before it is sent; the engine checks again and its message wins. */
export function validatePatch(patch: MaterialMeta): MetaErrors {
  const errors: MetaErrors = {};
  if (patch.date !== undefined && patch.date.trim() && !isValidDate(patch.date.trim())) errors.date = DATE_RULE;
  if (patch.creators?.some((creator) => !creator.name.trim())) errors.creators = "Every creator needs a name.";
  return errors;
}

/** The patch that clears a field back to what was extracted: "" for text, [] for lists. */
export function resetPatch(field: MetaField): MaterialMeta {
  if (field === "creators" || field === "tags" || field === "related") return { [field]: [] };
  // The contract clears any field with ""; `kind` is typed as MaterialKind, so the empty string is cast once, here.
  if (field === "kind") return { kind: "" as MaterialKind };
  return { [field]: "" };
}

export interface MaterialMetaEditor {
  meta: MaterialMeta;
  extracted: MaterialMeta;
  overrides: MaterialMeta;
  /** The field whose save is in flight, if any. */
  saving: MetaField | undefined;
  errors: MetaErrors;
  /** Sends a patch; resolves true when the engine accepted it. A validation or engine error lands in `errors`. */
  save: (patch: MaterialMeta) => Promise<boolean>;
  /** Clears the field's override so the extracted value shows again. */
  reset: (field: MetaField) => Promise<boolean>;
  /** Whether the effective value comes from an override that differs from the extracted one. */
  overridden: (field: MetaField) => boolean;
  /** "extracted: …" text for a field, when there is one. */
  extractedOf: (field: MetaField) => string | undefined;
}

const firstField = (patch: MaterialMeta): MetaField | undefined => (Object.keys(patch) as MetaField[])[0];

/**
 * Editing a material's metadata: every save goes through updateMaterialMeta and the returned
 * record is handed to `onSaved`, so the header, the body and the Library row follow at once.
 */
export function useMaterialMeta(material: MaterialRecord, onSaved: (record: MaterialRecord) => void): MaterialMetaEditor {
  const [saving, setSaving] = useState<MetaField | undefined>(undefined);
  const [errors, setErrors] = useState<MetaErrors>({});
  const extracted = material.extracted;
  const overrides = material.overrides ?? {};

  const save = useCallback(async (patch: MaterialMeta): Promise<boolean> => {
    const field = firstField(patch);
    const invalid = validatePatch(patch);
    if (Object.keys(invalid).length) { setErrors((current) => ({ ...current, ...invalid })); return false; }
    setSaving(field);
    setErrors((current) => { const { [field ?? "title"]: _dropped, ...rest } = current; return rest; });
    try {
      onSaved(await read.updateMaterialMeta(material.id, patch));
      return true;
    } catch (cause: unknown) {
      setErrors((current) => ({ ...current, [field ?? "title"]: cause instanceof Error ? cause.message : "Could not save the change." }));
      return false;
    } finally { setSaving(undefined); }
  }, [material.id, onSaved]);

  const reset = useCallback((field: MetaField) => save(resetPatch(field)), [save]);

  return {
    meta: material.meta,
    extracted,
    overrides,
    saving,
    errors,
    save,
    reset,
    overridden: (field) => isOverridden(extracted, material.overrides, field),
    extractedOf: (field) => extractedText(extracted, field),
  };
}
