import type { ItemRecord, MaterialSummary, SearchHit } from "../../shared/contracts";

export const SEARCH_CAP = 50;
const MAX_WORDS = 8;

function dateOf(iso: string | undefined): string {
  return iso ? iso.slice(0, 10) : "";
}

function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}

function joinSubtitle(...parts: (string | undefined)[]): string {
  return parts.filter((part): part is string => Boolean(part)).join(" · ");
}

export function searchWords(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean).slice(0, MAX_WORDS);
}

/** Every word must appear in the material's title or byline. */
export function materialHits(query: string, materials: readonly MaterialSummary[]): SearchHit[] {
  const words = searchWords(query);
  if (words.length === 0) return [];
  return materials
    .filter((material) => { const haystack = `${material.title} ${material.byline ?? ""}`.toLowerCase(); return words.every((word) => haystack.includes(word)); })
    .map((material) => ({ kind: "material" as const, id: material.id, title: material.title, subtitle: joinSubtitle(material.byline ?? hostOf(material.url), dateOf(material.publishedAt ?? material.fetchedAt)) }));
}

export function itemHits(items: readonly ItemRecord[]): SearchHit[] {
  return items.map((item) => ({ kind: "item" as const, id: item.id, title: item.title, subtitle: joinSubtitle(item.sourceTitle, dateOf(item.publishedAt)) }));
}

/** Materials first (they are already in the library), then items; at most 50 in total. */
export function mergeHits(materials: readonly SearchHit[], items: readonly SearchHit[]): SearchHit[] {
  return [...materials, ...items].slice(0, SEARCH_CAP);
}
