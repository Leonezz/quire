import { isDeepStrictEqual } from "node:util";
import type { MaterialMeta, MaterialRecord, MaterialSummary, MaterialView, MaterialViewId } from "../../shared/contracts";
import { artifactInfoOf } from "./artifacts";
import { isHtml } from "./material-content";
import { primaryViewOf, viewsOf } from "./material-views";
import { applyOverrides, bylineOf, extractMetadata, publishedAtOf } from "./metadata";

// The three layers of a material's metadata as MaterialStore keeps and serves them:
//   stored   – the JSON on disk: what the extractor found (title, byline, publishedAt, lang) plus
//              `extracted` (the declared metadata) and `itemMeta` (what the item it came from carried);
//   overrides – the reader's edits, in MetaStore;
//   effective – extracted with overrides applied, mirrored into the top-level fields the UI lists.

/**
 * The record as written to disk. Records from before the metadata model have no `extracted`; records
 * from before views have no `views` / `primaryView`; both are derived on read (material-views.ts).
 */
export type StoredRecord = Omit<MaterialRecord, "tags" | "overrides" | "meta" | "kind" | "extracted" | "views" | "primaryView" | "readyViews"> & {
  extracted?: MaterialMeta;
  /** What the item the material was read from declared (arXiv authors and abstract, the feed's title), kept so a refresh can merge it again. */
  itemMeta?: MaterialMeta;
  views?: MaterialView[];
  primaryView?: MaterialViewId;
};

type Fallback = Parameters<typeof extractMetadata>[0]["fallback"];

function fallbackOf(record: Pick<StoredRecord, "title" | "byline" | "publishedAt" | "lang">): Fallback {
  return { title: record.title, ...(record.byline ? { byline: record.byline } : {}), ...(record.publishedAt ? { publishedAt: record.publishedAt } : {}), ...(record.lang ? { lang: record.lang } : {}) };
}

/** The extracted layer of a record from the extractor's own fields, the page (when HTML) and the item it came from. */
function extractedFor(record: StoredRecord, html?: Uint8Array): MaterialMeta {
  return extractMetadata({
    ...(html && isHtml(record.mediaType) ? { html } : {}),
    url: record.finalUrl, mediaType: record.mediaType, origin: record.origin, fetchedAt: record.fetchedAt, fallback: fallbackOf(record),
    ...(record.itemMeta ? { item: record.itemMeta } : {}),
  });
}

/** A record with its extracted layer computed from its own fields (and the page bytes when it is HTML). */
export function withExtracted(record: StoredRecord, html?: Uint8Array): StoredRecord {
  return { ...record, extracted: extractedFor(record, html) };
}

/**
 * The record with what an item declared. With the page at hand the layer is extracted again. Without it
 * (no capture kept, or another view made primary) a field the record's own fields and its old item do
 * not account for came from the page, so it stays as stored; every other field is extracted again.
 */
export function withItemMeta(record: StoredRecord, itemMeta: MaterialMeta, html?: Uint8Array): StoredRecord {
  const next = { ...record, itemMeta };
  if (html && isHtml(record.mediaType)) return withExtracted(next, html);
  const stored = extractedOf(record);
  const unpaged = extractedFor(record);
  const again = extractedFor(next);
  const keys = [...new Set([...Object.keys(stored), ...Object.keys(again)])] as (keyof MaterialMeta)[];
  const extracted = Object.fromEntries(keys
    .map((key) => [key, isDeepStrictEqual(stored[key], unpaged[key]) ? again[key] : stored[key]] as const)
    .filter(([, value]) => value !== undefined)) as MaterialMeta;
  return { ...next, extracted };
}

/** The stored layer, derived from the extractor's fields for records written before it was stored. */
export function extractedOf(record: StoredRecord): MaterialMeta {
  return record.extracted ?? extractedFor(record);
}

/** The effective record: the overrides laid over the extracted layer, and the derived top-level fields. */
export function effectiveOf(record: StoredRecord, overrides: MaterialMeta | undefined): MaterialRecord {
  const { title: storedTitle, byline: _byline, publishedAt: _publishedAt, extracted: _extracted, itemMeta: _item, views: _views, primaryView: _primary, ...rest } = record;
  const extracted = extractedOf(record);
  const meta = applyOverrides(extracted, overrides);
  const byline = bylineOf(meta.creators);
  const publishedAt = publishedAtOf(meta.date);
  const views = viewsOf(record);
  const artifact = artifactInfoOf(record);
  return {
    ...rest,
    ...(artifact ? { artifact } : {}),
    title: meta.title ?? storedTitle,
    kind: meta.kind ?? "webpage",
    tags: meta.tags ?? [],
    extracted, meta,
    views, primaryView: primaryViewOf(record), readyViews: readyViewsOf(views),
    ...(byline ? { byline } : {}),
    ...(publishedAt ? { publishedAt } : {}),
    ...(overrides && Object.keys(overrides).length > 0 ? { overrides } : {}),
  };
}

/** Ids of the views whose content is stored, in the record's order. */
export function readyViewsOf(views: readonly MaterialView[]): MaterialViewId[] {
  return views.filter((view) => view.status === "ready").map((view) => view.id);
}

export function summaryOf(record: MaterialRecord): MaterialSummary {
  const { id, url, title, byline, publishedAt, fetchedAt, readingMinutes, origin, mediaType, quality, lineage, tags, kind, rebuiltAs, readyViews, artifact } = record;
  const publication = record.meta.publication;
  return { id, url, title, fetchedAt, readingMinutes, origin, mediaType, quality, tags, kind, readyViews, ...(byline ? { byline } : {}), ...(publishedAt ? { publishedAt } : {}), ...(publication ? { publication } : {}), ...(lineage ? { lineage } : {}), ...(rebuiltAs ? { rebuiltAs } : {}), ...(artifact ? { artifact } : {}) };
}

/** What a material search matches on besides its text: the effective title, creators, publication, abstract, identifiers and tags. */
export function searchFieldsOf(record: MaterialRecord): string {
  const { meta } = record;
  return [record.title, (meta.creators ?? []).map((c) => c.name).join(" "), meta.publication, meta.abstract, meta.doi, meta.arxivId, record.tags.join(" ")]
    .filter((part): part is string => Boolean(part)).join("\n");
}
