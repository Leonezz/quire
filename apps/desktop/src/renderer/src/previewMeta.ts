import type { Creator, MaterialKind, MaterialMeta, MaterialRecord, MaterialSummary } from "../../shared/contracts";
import { DATE_RULE, creatorsText, isCreatorRole, isMaterialKind, isValidDate, parseCreatorName } from "./materialMeta";
import { rebuiltAsOf } from "./previewRebuild";
import type { SummaryWithPublication } from "./materialMeta";

// The preview's metadata layer, mirroring the engine: `extracted` comes from the stored record
// (or is derived from its legacy title / byline / publishedAt when the sample predates the model),
// `overrides` are what the user saved (localStorage), `meta` is one laid over the other.

const MAX_TAGS = 20;
const MAX_TAG_LENGTH = 40;
const MAX_CREATORS = 50;
const MAX_TEXT = 4000;
const META_FIELDS: readonly (keyof MaterialMeta)[] = ["kind", "title", "shortTitle", "creators", "abstract", "publication", "volume", "issue", "pages", "publisher", "place", "edition", "series", "date", "accessed", "language", "doi", "arxivId", "isbn", "issn", "url", "tags", "note", "extra", "related"];
const TEXT_FIELDS = ["title", "shortTitle", "abstract", "publication", "volume", "issue", "pages", "publisher", "place", "edition", "series", "accessed", "language", "doi", "arxivId", "isbn", "issn", "url", "note", "extra"] as const satisfies readonly (keyof MaterialMeta)[];

/** Only the model's fields, so stale keys in stored overrides never reach `meta`. */
export function knownFieldsOf(raw: Record<string, unknown>): MaterialMeta {
  return Object.fromEntries(Object.entries(raw).filter(([key]) => (META_FIELDS as readonly string[]).includes(key))) as MaterialMeta;
}

/** Bibliographic kind from where a legacy record came from, when it carries none. */
export function kindOfRecord(material: Pick<MaterialSummary, "origin" | "mediaType" | "url">): MaterialKind {
  if (material.origin === "agent") return "note";
  if (/^https?:\/\/(www\.)?arxiv\.org\//i.test(material.url)) return "preprint";
  if (material.origin === "feed") return "blogPost";
  if (material.mediaType === "application/pdf") return "document";
  return "webpage";
}

/** "A; B and C" → creators; a plain byline is one creator as displayed. */
function creatorsOfByline(byline: string | undefined): Creator[] {
  if (!byline) return [];
  return byline.split(/\s*(?:;|\band\b|&)\s*/).map((part) => part.trim()).filter(Boolean).map((name) => ({ role: "author", name }));
}

/** What the source declared: the record's `extracted` when it has one, else the legacy fields it does carry. */
export function extractedOf(material: MaterialRecord): MaterialMeta {
  const stored = (material as Partial<MaterialRecord>).extracted;
  if (stored) return stored;
  const creators = creatorsOfByline(material.byline);
  const date = material.publishedAt ? material.publishedAt.slice(0, 10) : undefined;
  return {
    kind: kindOfRecord(material),
    title: material.title,
    ...(creators.length ? { creators } : {}),
    ...(date ? { date } : {}),
    accessed: material.fetchedAt.slice(0, 10),
    ...(material.lang ? { language: material.lang } : {}),
    ...(material.origin === "agent" ? {} : { url: material.finalUrl || material.url }),
  };
}

/** Trimmed, at most 40 characters each, deduplicated case-insensitively (first spelling wins), at most 20 — as the engine does. */
function normalizeTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  return tags.reduce<string[]>((kept, raw) => {
    const tag = raw.trim().slice(0, MAX_TAG_LENGTH).trim();
    const key = tag.toLowerCase();
    if (!tag || seen.has(key) || kept.length >= MAX_TAGS) return kept;
    seen.add(key);
    return [...kept, tag];
  }, []);
}

function normalizeCreators(creators: readonly Creator[]): Creator[] {
  if (creators.length > MAX_CREATORS) throw new Error(`At most ${MAX_CREATORS} creators.`);
  return creators.map((creator) => {
    if (!isCreatorRole(creator.role)) throw new Error(`Unknown creator role "${String(creator.role)}".`);
    const name = creator.name.replace(/\s+/g, " ").trim();
    if (!name) throw new Error("A creator needs a name.");
    if (creator.given && creator.family) return { role: creator.role, name, given: creator.given.trim(), family: creator.family.trim() };
    return parseCreatorName(name, creator.role);
  });
}

function withText(next: MaterialMeta, field: (typeof TEXT_FIELDS)[number], value: string | undefined): MaterialMeta {
  if (value === undefined) return next;
  const trimmed = value.trim();
  if (trimmed.length > MAX_TEXT) throw new Error(`${field} is longer than ${MAX_TEXT} characters.`);
  const { [field]: _dropped, ...rest } = next;
  return trimmed ? { ...rest, [field]: trimmed } : rest;
}

/**
 * The engine's merge: `undefined` keeps the stored override, "" (or an empty array) drops it so the
 * extracted value shows again, anything else replaces it. Validation errors are thrown as messages.
 */
export function mergeOverrides(current: MaterialMeta, patch: MaterialMeta): MaterialMeta {
  let next: MaterialMeta = { ...current };
  for (const field of TEXT_FIELDS) next = withText(next, field, patch[field]);
  if (patch.kind !== undefined) {
    const { kind: _dropped, ...rest } = next;
    if ((patch.kind as string) === "") next = rest;
    else if (!isMaterialKind(patch.kind)) throw new Error(`Unknown material type "${String(patch.kind)}".`);
    else next = { ...rest, kind: patch.kind };
  }
  if (patch.date !== undefined) {
    const date = patch.date.trim();
    const { date: _dropped, ...rest } = next;
    if (date && !isValidDate(date)) throw new Error(`"${date}" is not a date. ${DATE_RULE}`);
    next = date ? { ...rest, date } : rest;
  }
  if (patch.creators !== undefined) {
    const creators = normalizeCreators(patch.creators);
    const { creators: _dropped, ...rest } = next;
    next = creators.length ? { ...rest, creators } : rest;
  }
  if (patch.tags !== undefined) {
    const tags = normalizeTags(patch.tags);
    const { tags: _dropped, ...rest } = next;
    next = tags.length ? { ...rest, tags } : rest;
  }
  if (patch.related !== undefined) {
    const related = [...new Set(patch.related.map((id) => id.trim()).filter(Boolean))];
    const { related: _dropped, ...rest } = next;
    next = related.length ? { ...rest, related } : rest;
  }
  return next;
}

/** extracted with the overrides laid over: an override always wins when present. */
export function applyOverrides(extracted: MaterialMeta, overrides: MaterialMeta | undefined): MaterialMeta {
  return { ...extracted, ...(overrides ?? {}) };
}

/** The effective summary: the mirrors (title, byline, publishedAt, tags, kind, publication) and the rebuilt mark. */
export function overlaySummary<T extends MaterialSummary>(material: T, extracted: MaterialMeta, overrides: MaterialMeta | undefined): T & SummaryWithPublication {
  const meta = applyOverrides(extracted, overrides);
  const rebuiltAs = rebuiltAsOf(material.id);
  const byline = creatorsText(meta.creators);
  const { byline: _byline, publishedAt: _publishedAt, ...base } = material;
  return {
    ...(base as T),
    title: meta.title ?? material.title,
    ...(byline ? { byline } : {}),
    ...(meta.date ? { publishedAt: meta.date } : {}),
    ...(meta.publication ? { publication: meta.publication } : {}),
    ...(rebuiltAs ? { rebuiltAs } : {}),
    tags: meta.tags ?? [],
    kind: meta.kind ?? kindOfRecord(material),
  };
}

export function overlayRecord(material: MaterialRecord, overrides: MaterialMeta | undefined): MaterialRecord {
  const extracted = extractedOf(material);
  const meta = applyOverrides(extracted, overrides);
  const { overrides: _dropped, ...summary } = overlaySummary(material, extracted, overrides);
  return { ...summary, extracted, meta, ...(overrides && Object.keys(overrides).length ? { overrides } : {}) };
}

/** For legacy summaries (the corpus index): what extraction would say, without loading the record. */
export function extractedOfSummary(summary: MaterialSummary): MaterialMeta {
  const creators = creatorsOfByline(summary.byline);
  return {
    kind: kindOfRecord(summary),
    title: summary.title,
    ...(creators.length ? { creators } : {}),
    ...(summary.publishedAt ? { date: summary.publishedAt.slice(0, 10) } : {}),
    url: summary.url,
  };
}
