import type { MaterialMeta, MaterialRecord, MaterialSummary } from "../../shared/contracts";
import { applyOverrides, bylineOf, extractMetadata, publishedAtOf } from "./metadata";

// The three layers of a material's metadata as MaterialStore keeps and serves them:
//   stored   – the JSON on disk: what the extractor found (title, byline, publishedAt, lang) plus
//              `extracted` (the declared metadata) and `itemMeta` (what the item it came from carried);
//   overrides – the reader's edits, in MetaStore;
//   effective – extracted with overrides applied, mirrored into the top-level fields the UI lists.

/** The record as written to disk. Records from before the metadata model have no `extracted`; it is derived on read. */
export type StoredRecord = Omit<MaterialRecord, "tags" | "overrides" | "meta" | "kind" | "extracted"> & {
  extracted?: MaterialMeta;
  /** What the item the material was read from declared (arXiv authors and abstract, the feed's title), kept so a refresh can merge it again. */
  itemMeta?: MaterialMeta;
};

/** The stored layer, derived from the extractor's fields for records written before it was stored. */
export function extractedOf(record: StoredRecord): MaterialMeta {
  if (record.extracted) return record.extracted;
  return extractMetadata({
    url: record.finalUrl, mediaType: record.mediaType, origin: record.origin, fetchedAt: record.fetchedAt,
    fallback: { title: record.title, ...(record.byline ? { byline: record.byline } : {}), ...(record.publishedAt ? { publishedAt: record.publishedAt } : {}), ...(record.lang ? { lang: record.lang } : {}) },
    ...(record.itemMeta ? { item: record.itemMeta } : {}),
  });
}

/** The effective record: the overrides laid over the extracted layer, and the derived top-level fields. */
export function effectiveOf(record: StoredRecord, overrides: MaterialMeta | undefined): MaterialRecord {
  const { title: storedTitle, byline: _byline, publishedAt: _publishedAt, extracted: _extracted, itemMeta: _item, ...rest } = record;
  const extracted = extractedOf(record);
  const meta = applyOverrides(extracted, overrides);
  const byline = bylineOf(meta.creators);
  const publishedAt = publishedAtOf(meta.date);
  return {
    ...rest,
    title: meta.title ?? storedTitle,
    kind: meta.kind ?? "webpage",
    tags: meta.tags ?? [],
    extracted, meta,
    ...(byline ? { byline } : {}),
    ...(publishedAt ? { publishedAt } : {}),
    ...(overrides && Object.keys(overrides).length > 0 ? { overrides } : {}),
  };
}

export function summaryOf(record: MaterialRecord): MaterialSummary {
  const { id, url, title, byline, publishedAt, fetchedAt, readingMinutes, origin, mediaType, quality, lineage, tags, kind, rebuiltAs } = record;
  const publication = record.meta.publication;
  return { id, url, title, fetchedAt, readingMinutes, origin, mediaType, quality, tags, kind, ...(byline ? { byline } : {}), ...(publishedAt ? { publishedAt } : {}), ...(publication ? { publication } : {}), ...(lineage ? { lineage } : {}), ...(rebuiltAs ? { rebuiltAs } : {}) };
}

/** What a material search matches on besides its text: the effective title, creators, publication, abstract, identifiers and tags. */
export function searchFieldsOf(record: MaterialRecord): string {
  const { meta } = record;
  return [record.title, (meta.creators ?? []).map((c) => c.name).join(" "), meta.publication, meta.abstract, meta.doi, meta.arxivId, record.tags.join(" ")]
    .filter((part): part is string => Boolean(part)).join("\n");
}
