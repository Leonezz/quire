import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MaterialView, MaterialViewContent, MaterialViewId } from "../../shared/contracts";
import type { StoredRecord } from "./material-record";

// One material, several renderings. The primary view's content is the record itself; every
// other stored view lives beside it as <id>.<view>.json (a MaterialViewContent) and, for PDFs,
// <id>.<view>.pdf. The primary PDF keeps <id>.pdf, as before views existed.

export const MATERIAL_VIEW_IDS: readonly MaterialViewId[] = ["web", "pdf", "markdown"];

export function isMaterialViewId(value: unknown): value is MaterialViewId {
  return typeof value === "string" && (MATERIAL_VIEW_IDS as readonly string[]).includes(value);
}

const LABELS: Record<MaterialViewId, string> = { web: "Web page", pdf: "PDF", markdown: "Markdown" };

export function viewLabel(id: MaterialViewId): string {
  return LABELS[id];
}

/** Which view a media type renders as: PDFs, Markdown (and plain text, which the Markdown pipeline renders), pages. */
export function viewIdForMediaType(mediaType: string): MaterialViewId {
  if (mediaType === "application/pdf") return "pdf";
  if (mediaType === "text/markdown" || mediaType === "text/x-markdown" || mediaType === "text/plain") return "markdown";
  return "web";
}

/** Whether fetched bytes belong in the view that asked for them (a PDF view must yield a PDF, a web view a page). */
export function mediaTypeFitsView(view: MaterialViewId, mediaType: string): boolean {
  return viewIdForMediaType(mediaType) === view;
}

type ContentFields = Pick<StoredRecord, "mediaType" | "pdf" | "reader" | "markdown" | "plain" | "readingMinutes" | "quality" | "problems">;

/** The ready view entry for content stored as the record's own (the primary view). */
function primaryViewEntry(record: Pick<StoredRecord, "finalUrl" | "fetchedAt" | "capture"> & ContentFields, id: MaterialViewId): MaterialView {
  const byteLength = record.pdf?.byteLength ?? record.capture?.byteLength;
  return {
    id, label: viewLabel(id), url: record.finalUrl, mediaType: record.mediaType, status: "ready", fetchedAt: record.fetchedAt,
    ...(byteLength !== undefined ? { byteLength } : {}),
    ...(record.pdf ? { pdf: record.pdf } : {}),
  };
}

/** The record's views; a record written before views existed derives one ready view from its media type. */
export function viewsOf(record: StoredRecord): MaterialView[] {
  if (record.views && record.views.length > 0) return record.views;
  return [primaryViewEntry(record, viewIdForMediaType(record.mediaType))];
}

export function primaryViewOf(record: StoredRecord): MaterialViewId {
  return record.primaryView ?? viewIdForMediaType(record.mediaType);
}

/** A record with its single primary view written explicitly; records that already carry views are returned as they are. */
export function withPrimaryView(record: StoredRecord): StoredRecord {
  if (record.views && record.views.length > 0 && record.primaryView) return record;
  const id = viewIdForMediaType(record.mediaType);
  return { ...record, views: [primaryViewEntry(record, id)], primaryView: id };
}

/** The primary view's content, assembled from the record's own fields. */
export function primaryContentOf(record: StoredRecord): MaterialViewContent {
  return {
    view: primaryViewOf(record), mediaType: record.mediaType, readingMinutes: record.readingMinutes, quality: record.quality, problems: record.problems,
    ...(record.pdf ? { pdf: record.pdf } : {}),
    ...(record.reader ? { reader: record.reader } : {}),
    ...(record.markdown ? { markdown: record.markdown } : {}),
    ...(record.plain ? { plain: record.plain } : {}),
  };
}

/** The record with another view's content as its own: content fields replaced, metadata untouched. */
export function withContent(record: StoredRecord, content: MaterialViewContent): StoredRecord {
  const { pdf: _pdf, reader: _reader, markdown: _markdown, plain: _plain, ...rest } = record;
  return {
    ...rest,
    mediaType: content.mediaType, readingMinutes: content.readingMinutes, quality: content.quality, problems: content.problems,
    primaryView: content.view,
    ...(content.pdf ? { pdf: content.pdf } : {}),
    ...(content.reader ? { reader: content.reader } : {}),
    ...(content.markdown ? { markdown: content.markdown } : {}),
    ...(content.plain ? { plain: content.plain } : {}),
  };
}

/** The view list with one entry replaced (or appended when the id is new). */
export function upsertView(views: readonly MaterialView[], view: MaterialView): MaterialView[] {
  return views.some((entry) => entry.id === view.id) ? views.map((entry) => (entry.id === view.id ? view : entry)) : [...views, view];
}

/** The entry after a successful fetch: ready, with what was stored. */
export function readyView(view: MaterialView, content: MaterialViewContent, byteLength: number): MaterialView {
  const { error: _error, ...rest } = view;
  return { ...rest, mediaType: content.mediaType, status: "ready", fetchedAt: new Date().toISOString(), byteLength, ...(content.pdf ? { pdf: content.pdf } : {}) };
}

/** The entry after a failed fetch: the message stays on the view so the reader can show why. */
export function failedView(view: MaterialView, error: string): MaterialView {
  const { fetchedAt: _fetchedAt, byteLength: _byteLength, pdf: _pdf, ...rest } = view;
  return { ...rest, status: "failed", error };
}

// --- Files beside the record -----------------------------------------------------------------

export function viewContentPath(dir: string, id: string, view: MaterialViewId): string { return join(dir, `${id}.${view}.json`); }
export function viewPdfPath(dir: string, id: string, view: MaterialViewId): string { return join(dir, `${id}.${view}.pdf`); }
export function primaryPdfPath(dir: string, id: string): string { return join(dir, `${id}.pdf`); }

export async function readViewContent(dir: string, id: string, view: MaterialViewId): Promise<MaterialViewContent | undefined> {
  try { return JSON.parse(await readFile(viewContentPath(dir, id, view), "utf8")) as MaterialViewContent; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

export async function writeViewContent(dir: string, id: string, content: MaterialViewContent, pdfBytes?: Uint8Array): Promise<void> {
  if (pdfBytes) await writeFile(viewPdfPath(dir, id, content.view), pdfBytes);
  await writeFile(viewContentPath(dir, id, content.view), JSON.stringify(content), "utf8");
}

/** Every file a view can own; missing ones are fine. */
export function viewFilePaths(dir: string, id: string): string[] {
  return MATERIAL_VIEW_IDS.flatMap((view) => [viewContentPath(dir, id, view), viewPdfPath(dir, id, view)]);
}

/**
 * Makes a stored view the primary one on disk: the old primary's content becomes a view file
 * (its PDF bytes move to <id>.<view>.pdf), the new primary's files are consumed (its PDF bytes
 * move to <id>.pdf). Writes happen before removals so a crash leaves both readable.
 */
export async function swapPrimaryFiles(dir: string, id: string, outgoing: MaterialViewContent, incoming: MaterialViewContent): Promise<void> {
  await writeViewContent(dir, id, outgoing);
  if (outgoing.pdf) await rename(primaryPdfPath(dir, id), viewPdfPath(dir, id, outgoing.view));
  if (incoming.pdf) await rename(viewPdfPath(dir, id, incoming.view), primaryPdfPath(dir, id));
  await rm(viewContentPath(dir, id, incoming.view), { force: true });
}
