// Reader-owned types. The host maps its records onto these; the reader never
// sees storage identifiers beyond `id`.
export type TextAnnotationKind = "highlight" | "underline" | "comment" | "area";
// Hex values, shared with the host so highlight names stay stable.
export type TextAnnotationColor = "#2ea8e5" | "#5fb236" | "#a28ae5" | "#aaaaaa" | "#e56eee" | "#f19837" | "#ff6666" | "#ffd400";

export interface TextAnnotation {
  id: string;
  /** text-quote locator (see text-quote-selection.ts). */
  locator: string;
  quote: string;
  note?: string;
  kind?: TextAnnotationKind;
  color?: TextAnnotationColor;
  status?: "current" | "stale";
  /** Carried for hosts that key annotations by interpretation; unused by the reader. */
  interpretationKey?: string;
  materializationIdentity?: string;
  tags?: string[];
  createdAt?: string;
  updatedAt?: string;
}
