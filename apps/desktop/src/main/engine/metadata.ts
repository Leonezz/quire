import type { Creator, MaterialKind, MaterialMeta, MaterialRecord } from "../../shared/contracts";
import { arxivIdOf } from "./arxiv";
import { HEAD_BYTES, creatorOf, readPageSources, type PageSignals, type PageSources } from "./metadata-sources";

// The extracted layer of a material's metadata: what the page declares, then what the item
// (an arXiv entry, a feed) carried, then what the article extractor found. Pure; the store
// keeps the result on the record and lays the reader's overrides over it (applyOverrides).

export interface ExtractInput {
  /** The captured page; only its head and the first 256 KB are read. */
  html?: Uint8Array | string;
  url: string;
  mediaType: string;
  origin: MaterialRecord["origin"];
  /** What the article extractor (or the PDF's Info dictionary) already found. */
  fallback: { title?: string; byline?: string; publishedAt?: string; lang?: string };
  /** What the item the material was read from carried (arXiv authors and abstract, the feed's title). */
  item?: MaterialMeta;
  /** Becomes `accessed`; defaults to now. */
  fetchedAt?: string;
}

const WEB_KINDS: ReadonlySet<MaterialKind> = new Set(["webpage", "blogPost", "newsletter", "newsArticle"]);
/** Fields the item knows better than the extractor's byline heuristics; page tags still win. */
const ITEM_FIRST: readonly (keyof MaterialMeta)[] = ["creators", "abstract", "arxivId", "publication", "extra"];
const MERGED_FIELDS: readonly (keyof MaterialMeta)[] = ["title", "shortTitle", "creators", "abstract", "publication", "volume", "issue", "pages", "publisher", "place", "edition", "series", "date", "language", "doi", "arxivId", "isbn", "issn", "extra"];
const MAX_CREATORS = 50;
const DOI = /^10\.\d{4,9}\/\S+$/;

function isEmpty(value: unknown): boolean {
  return value === undefined || value === "" || (Array.isArray(value) && value.length === 0);
}

/** "2024/05/12", "May 12, 2024", "2024-05-12T10:00:00+02:00" or a partial "2024-05" to the ISO form the model keeps. */
export function normalizeDate(raw: string | undefined): string | undefined {
  const text = raw?.trim();
  if (!text) return undefined;
  const partial = /^(\d{4})(?:[-/.](\d{1,2})(?:[-/.](\d{1,2}))?)?$/.exec(text);
  if (partial) {
    const [, year, month, day] = partial;
    return [year, month?.padStart(2, "0"), day?.padStart(2, "0")].filter(Boolean).join("-");
  }
  const parsed = Date.parse(text);
  if (Number.isNaN(parsed)) return undefined;
  const at = new Date(parsed);
  if (/\d{1,2}:\d{2}/.test(text)) return at.toISOString();
  // A date with no time of day is a day, not an instant; Date.parse read it in local time.
  return [at.getFullYear(), at.getMonth() + 1, at.getDate()].map((part, index) => String(part).padStart(index === 0 ? 4 : 2, "0")).join("-");
}

/** DOIs are case-insensitive; "https://doi.org/10.X/Y" and "doi:10.X/Y" name the same one. */
export function normalizeDoi(raw: string | undefined): string | undefined {
  const text = raw?.trim().replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/i, "").toLowerCase();
  return text && DOI.test(text) ? text : undefined;
}

/** "arXiv:2409.12345v2" or a bare id to the version-free id the app uses everywhere. */
export function normalizeArxivId(raw: string | undefined): string | undefined {
  const text = raw?.trim().replace(/^arxiv:\s*/i, "");
  if (!text) return undefined;
  return arxivIdOf(`arxiv.org/abs/${text}`) ?? text;
}

/** "By Ada Lovelace, Charles Babbage and Alan Turing" → three authors. */
export function creatorsFromByline(byline: string | undefined): Creator[] {
  if (!byline) return [];
  return byline.replace(/^\s*by\s+/i, "").split(/,|\band\b|&|·/)
    .map((part) => creatorOf(part)).filter((c): c is Creator => c !== undefined)
    .map((creator) => ({ role: creator.role, name: creator.name })).slice(0, MAX_CREATORS);
}

/** The one-line author credit: authors joined, or the editors marked as such when there are no authors. */
export function bylineOf(creators: readonly Creator[] | undefined): string | undefined {
  if (!creators || creators.length === 0) return undefined;
  const of = (role: Creator["role"]) => creators.filter((c) => c.role === role).map((c) => c.name);
  const authors = of("author");
  if (authors.length > 0) return authors.join(", ");
  const editors = of("editor");
  if (editors.length > 0) return editors.map((name) => `${name} (ed.)`).join(", ");
  return creators.map((c) => c.name).join(", ");
}

/** A complete date (a day or an instant) as an ISO timestamp; a partial one has no publishedAt. */
export function publishedAtOf(date: string | undefined): string | undefined {
  if (!date) return undefined;
  if (/^\d{4}-\d{2}-\d{2}T/.test(date)) return date;
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) return `${date}T00:00:00.000Z`;
  return undefined;
}

/** Extracted with the overrides on top: a present, non-empty override replaces; anything else falls through. */
export function applyOverrides(extracted: MaterialMeta, overrides: MaterialMeta | undefined): MaterialMeta {
  if (!overrides) return { ...extracted };
  const applied = Object.entries(overrides).filter(([, value]) => !isEmpty(value));
  return { ...extracted, ...Object.fromEntries(applied) } as MaterialMeta;
}

function pick(meta: MaterialMeta | undefined, keys: readonly (keyof MaterialMeta)[]): MaterialMeta {
  if (!meta) return {};
  return Object.fromEntries(keys.filter((key) => !isEmpty(meta[key])).map((key) => [key, meta[key]])) as MaterialMeta;
}

/** Per field, the first layer that has a value. */
function mergeLayers(layers: readonly MaterialMeta[]): MaterialMeta {
  const merged: Record<string, unknown> = {};
  for (const key of MERGED_FIELDS) {
    const layer = layers.find((candidate) => !isEmpty(candidate[key]));
    if (layer) merged[key] = layer[key];
  }
  return merged as MaterialMeta;
}

interface KindInput { origin: MaterialRecord["origin"]; mediaType: string; signals: PageSignals; arxivId?: string; doi?: string; publication?: string; itemKind?: MaterialKind }

function inferKind(input: KindInput): MaterialKind {
  const { signals } = input;
  if (input.origin === "agent") return "note";
  if (input.arxivId) return "preprint";
  if (signals.conference) return "conferencePaper";
  if (signals.journal || (input.doi && input.publication) || (signals.scholarly && input.publication)) return "journalArticle";
  if (signals.thesis) return "thesis";
  if (signals.report) return "report";
  if (signals.book) return "book";
  if (signals.news) return "newsArticle";
  if (signals.blog) return "blogPost";
  if (input.itemKind) return input.itemKind;
  if (input.origin === "feed") return "blogPost";
  if (input.mediaType === "application/pdf") return "document";
  return "webpage";
}

function decode(html: Uint8Array | string): string {
  return typeof html === "string" ? html.slice(0, HEAD_BYTES) : new TextDecoder("utf-8", { fatal: false }).decode(html.subarray(0, HEAD_BYTES));
}

const NO_SOURCES: PageSources = { layers: [], signals: {} };

/**
 * The extracted metadata of a material. Precedence per field: Highwire, Dublin Core, JSON-LD,
 * Open Graph, plain <meta>, the URL (arXiv id), the item's creators / abstract / arXiv id /
 * publication, the extractor's fallback, then the rest of the item.
 */
export function extractMetadata(input: ExtractInput): MaterialMeta {
  const page = input.html === undefined ? NO_SOURCES : readPageSources(decode(input.html));
  const { fallback, item } = input;
  const fromUrl = arxivIdOf(input.url);
  const fallbackLayer: MaterialMeta = {
    ...(fallback.title ? { title: fallback.title } : {}),
    creators: creatorsFromByline(fallback.byline),
    ...(fallback.publishedAt ? { date: fallback.publishedAt } : {}),
    ...(fallback.lang ? { language: fallback.lang } : {}),
  };
  const { date: rawDate, doi: rawDoi, arxivId: rawArxivId, publication: declaredPublication, creators: rawCreators, ...rest } =
    mergeLayers([...page.layers, fromUrl ? { arxivId: fromUrl } : {}, pick(item, ITEM_FIRST), fallbackLayer, item ?? {}]);
  const date = normalizeDate(rawDate);
  const doi = normalizeDoi(rawDoi);
  const arxivId = normalizeArxivId(rawArxivId);
  const kind = inferKind({ origin: input.origin, mediaType: input.mediaType, signals: page.signals, ...(arxivId ? { arxivId } : {}), ...(doi ? { doi } : {}), ...(declaredPublication ? { publication: declaredPublication } : {}), ...(item?.kind ? { itemKind: item.kind } : {}) });
  const publication = declaredPublication ?? (WEB_KINDS.has(kind) ? page.siteName : undefined);
  const creators = (rawCreators ?? []).slice(0, MAX_CREATORS);
  return {
    ...rest,
    kind,
    ...(date ? { date } : {}), ...(doi ? { doi } : {}), ...(arxivId ? { arxivId } : {}),
    ...(publication ? { publication } : {}),
    ...(creators.length > 0 ? { creators } : {}),
    url: input.url,
    accessed: input.fetchedAt ?? new Date().toISOString(),
  };
}
