import type { Annotation, MaterialRecord, MaterialView, MaterialViewContent, MaterialViewId } from "../../shared/contracts";

// One material, several ways to read it: the pure helpers the reader, the Notes panel, the Info
// panel and the Library rows share. The hook that chooses and loads a view is useMaterialView.ts.

export const VIEW_LABELS: Record<MaterialViewId, string> = { web: "Web", pdf: "PDF", markdown: "Markdown" };
const VIEW_IDS: readonly MaterialViewId[] = ["web", "pdf", "markdown"];

export function isMaterialViewId(value: unknown): value is MaterialViewId {
  return typeof value === "string" && (VIEW_IDS as readonly string[]).includes(value);
}

/** The label of a view id, for rows that only carry ids ("Web + PDF"). */
export function viewLabel(id: MaterialViewId): string {
  return VIEW_LABELS[id];
}

/** The view an annotation belongs to: its own, or the material's primary when it predates views. */
export function annotationView(annotation: Pick<Annotation, "view">, primaryView: MaterialViewId): MaterialViewId {
  return annotation.view ?? primaryView;
}

/** The record's own content as a view: the primary view's content travels on the record itself. */
export function contentOfRecord(material: MaterialRecord): MaterialViewContent {
  const { primaryView, mediaType, pdf, reader, markdown, plain, readingMinutes, quality, problems } = material;
  return {
    view: primaryView, mediaType, readingMinutes, quality, problems,
    ...(pdf ? { pdf } : {}),
    ...(reader ? { reader } : {}),
    ...(markdown ? { markdown } : {}),
    ...(plain ? { plain } : {}),
  };
}

/** Whether the content is read with the PDF reader (the document reader takes everything else). */
export function isPdfContent(content: Pick<MaterialViewContent, "mediaType" | "pdf">): boolean {
  return content.pdf !== undefined || content.mediaType === "application/pdf";
}

export function viewOf(views: readonly MaterialView[], id: MaterialViewId): MaterialView | undefined {
  return views.find((view) => view.id === id);
}

/** The view after `current` in the material's order, wrapping around; `current` itself when there is only one. */
export function nextView(views: readonly MaterialView[], current: MaterialViewId): MaterialViewId | undefined {
  if (views.length === 0) return undefined;
  const index = views.findIndex((view) => view.id === current);
  return views[(index + 1) % views.length]?.id;
}

const VIEW_KEY_PREFIX = "read:view:";

/** The view last chosen for a material, when the browser kept it. */
export function rememberedView(materialId: string): MaterialViewId | undefined {
  try {
    const raw = localStorage.getItem(`${VIEW_KEY_PREFIX}${materialId}`);
    return isMaterialViewId(raw) ? raw : undefined;
  } catch {
    // Storage may be unavailable (a private window, a blocked origin); starting from the primary view is a legitimate mode.
    return undefined;
  }
}

export function rememberView(materialId: string, view: MaterialViewId): void {
  try { localStorage.setItem(`${VIEW_KEY_PREFIX}${materialId}`, view); } catch { /* same as above */ }
}

/** The view to open first: the remembered one while the material still has it ready, else the primary. */
export function initialViewOf(material: Pick<MaterialRecord, "id" | "views" | "primaryView">): MaterialViewId {
  const remembered = rememberedView(material.id);
  return remembered && viewOf(material.views, remembered)?.status === "ready" ? remembered : material.primaryView;
}
