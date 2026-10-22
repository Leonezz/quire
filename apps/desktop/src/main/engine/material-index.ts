import type { MaterialMeta } from "../../shared/contracts";
import type { FetchedPage } from "./fetch";
import { isHtml, isPdf } from "./material-content";
import { arxivIdOfUrl, canonicalLinkOf, canonicalUrlOf } from "./material-identity";
import { extractedOf, type StoredRecord } from "./material-record";
import { extractPage } from "./metadata";

// The other names of a material (#28): every URL it was opened by, the canonical link its page
// declares, its DOI and its arXiv id. A link whose id is not in the library is looked up here
// before anything is fetched, and a fetched page by what it declares before anything is written.
//
// Keys are namespaced so a declared canonical link only matches a URL a material was read from,
// never another declaration: two articles a misconfigured site gives one canonical stay apart.
//   url:<canonical URL>    the material's url, finalUrl and aliases
//   canonical:<URL>        the canonical link its page declares
//   doi:<doi>, arxiv:<id>  from the stored extracted layer, never the reader's overrides

type Origin = StoredRecord["origin"];

function urlOf(raw: string): URL | undefined {
  if (!URL.canParse(raw)) return undefined;
  const url = new URL(raw);
  return url.protocol === "https:" || url.protocol === "http:" ? url : undefined;
}

/** The URLs a record was read from or opened by, each without tracking parameters, once. */
function urlNamesOf(record: Pick<StoredRecord, "url" | "finalUrl" | "aliases">): string[] {
  const urls = [record.url, record.finalUrl, ...(record.aliases ?? [])].map(urlOf).filter((url): url is URL => url !== undefined);
  return [...new Set(urls.map(canonicalUrlOf))];
}

function identifierKeysOf(meta: Pick<MaterialMeta, "doi" | "arxivId">): string[] {
  return [...(meta.doi ? [`doi:${meta.doi}`] : []), ...(meta.arxivId ? [`arxiv:${meta.arxivId}`] : [])];
}

/** Every key a stored record answers to. */
export function identityKeysOf(record: StoredRecord): string[] {
  return [
    ...urlNamesOf(record).map((url) => `url:${url}`),
    ...(record.canonicalUrl ? [`canonical:${record.canonicalUrl}`] : []),
    ...identifierKeysOf(extractedOf(record)),
  ];
}

/** What a link names before it is fetched: a URL a material was read from or declared as its canonical one, or an arXiv paper. */
export function requestKeysOf(url: URL): string[] {
  const named = canonicalUrlOf(url);
  const arxivId = arxivIdOfUrl(url);
  return [`url:${named}`, `canonical:${named}`, ...(arxivId ? [`arxiv:${arxivId}`] : [])];
}

/** What a fetched page names, read the way its record's extracted layer will be: where the fetch ended, the canonical link it declares, its DOI and arXiv id. */
export function pageKeysOf(page: FetchedPage, origin: Origin, item: MaterialMeta | undefined): string[] {
  const html = !isPdf(page.bytes, page.mediaType) && isHtml(page.mediaType) ? page.bytes : undefined;
  const { meta, canonical } = extractPage({ ...(html ? { html } : {}), url: page.finalUrl, mediaType: page.mediaType, origin, fallback: {}, ...(item ? { item } : {}) });
  const declared = canonicalLinkOf(canonical, page.finalUrl);
  return [...requestKeysOf(new URL(page.finalUrl)), ...(declared ? [`url:${declared}`] : []), ...identifierKeysOf(meta)];
}

/** The record also named by these URLs: each one it is not already named by joins its aliases, without tracking parameters. */
export function withAliases(record: StoredRecord, urls: readonly string[]): StoredRecord {
  const names = new Set([...urlNamesOf(record), ...(record.canonicalUrl ? [record.canonicalUrl] : [])]);
  const added = [...new Set(urls.map(urlOf).filter((url): url is URL => url !== undefined).map(canonicalUrlOf))].filter((url) => !names.has(url));
  return added.length === 0 ? record : { ...record, aliases: [...(record.aliases ?? []), ...added] };
}

/** The names a record materialized over another one keeps from it: the URLs the old one was read from and opened by. */
export function withNamesOf(previous: StoredRecord, record: StoredRecord): StoredRecord {
  return withAliases(record, [previous.url, previous.finalUrl, ...(previous.aliases ?? [])]);
}

/**
 * Key to material ids, in memory: filled from every record once, on the first lookup, and kept up
 * as records are saved and deleted. A hit is only a candidate; the store reads the record and checks
 * it still answers to the key, so an entry left behind by a re-extraction never misleads.
 */
export class IdentityIndex {
  private readonly ids = new Map<string, readonly string[]>();

  add(record: StoredRecord): void {
    for (const key of identityKeysOf(record)) {
      const ids = this.ids.get(key) ?? [];
      if (!ids.includes(record.id)) this.ids.set(key, [...ids, record.id]);
    }
  }

  remove(id: string): void {
    for (const [key, ids] of this.ids) {
      if (!ids.includes(id)) continue;
      const rest = ids.filter((candidate) => candidate !== id);
      if (rest.length > 0) this.ids.set(key, rest); else this.ids.delete(key);
    }
  }

  candidates(key: string): readonly string[] {
    return this.ids.get(key) ?? [];
  }
}
