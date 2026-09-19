import { useCallback, useEffect, useState } from "react";
import type { Annotation, AnnotationColor, AnnotationKind, MaterialRecord } from "../../shared/contracts";
import { read } from "./api";
import { creatorsText, displayDate } from "./materialMeta";

export const ANNOTATION_COLORS: { color: AnnotationColor; label: string }[] = [
  { color: "#ffd400", label: "Yellow" },
  { color: "#5fb236", label: "Green" },
  { color: "#2ea8e5", label: "Blue" },
  { color: "#e56eee", label: "Pink" },
];

function newId() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The material's annotations, loaded once and kept in sync with every save and delete. */
export function useAnnotations(materialId: string) {
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    read.listAnnotations(materialId)
      .then((list) => { if (!cancelled) setAnnotations(list); })
      .catch((cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : "Could not load notes."); });
    return () => { cancelled = true; };
  }, [materialId]);

  const add = useCallback(async (input: { locator: string; quote: string; kind: AnnotationKind; color: AnnotationColor; note?: string }) => {
    const draft: Annotation = { id: newId(), materialId, locator: input.locator, quote: input.quote, kind: input.kind, color: input.color, ...(input.note ? { note: input.note } : {}), createdAt: "", updatedAt: "" };
    const saved = await read.saveAnnotation(draft);
    setAnnotations((current) => [...current, saved]);
    return saved;
  }, [materialId]);

  const update = useCallback(async (id: string, patch: Partial<Pick<Annotation, "note" | "color" | "kind">>) => {
    const current = annotations.find((item) => item.id === id);
    if (!current) throw new Error(`Annotation ${id} is not loaded.`);
    const saved = await read.saveAnnotation({ ...current, ...patch });
    setAnnotations((list) => list.map((item) => (item.id === id ? saved : item)));
    return saved;
  }, [annotations]);

  const remove = useCallback(async (id: string) => {
    await read.deleteAnnotation(materialId, id);
    setAnnotations((list) => list.filter((item) => item.id !== id));
  }, [materialId]);

  return { annotations, error, add, update, remove };
}

/** "Title, Creators, Publication, Date (url)": the source line under a quote and at the top of an export. */
function sourceLine(material: MaterialRecord): string {
  const meta = material.meta;
  const parts = [material.title, creatorsText(meta.creators), meta.publication ?? "", displayDate(meta.date)].filter(Boolean);
  return `${parts.join(", ")} (${meta.url ?? material.finalUrl})`;
}

/** `quote — Title, Creators, Publication, Date (link)`: pasteable into any note. */
export function citationFor(material: MaterialRecord, annotation: Pick<Annotation, "quote" | "note">, section?: string) {
  const where = section ? ` · ${section}` : "";
  const note = annotation.note ? `\n\n${annotation.note}` : "";
  return `> ${annotation.quote.replace(/\s+/g, " ").trim()}\n\n— ${sourceLine(material)}${where}${note}`;
}

/** Every highlight and note of a material as Markdown, in reading order. */
export function annotationsMarkdown(material: MaterialRecord, annotations: readonly Annotation[]) {
  const header = `# ${material.title}\n\n${sourceLine(material)}\n`;
  const body = annotations.map((annotation) => `\n> ${annotation.quote.replace(/\s+/g, " ").trim()}\n${annotation.note ? `\n${annotation.note}\n` : ""}`).join("");
  return `${header}${body}`;
}
