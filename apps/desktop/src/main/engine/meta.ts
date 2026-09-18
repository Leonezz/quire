import type { MaterialMeta, TagCount } from "../../shared/contracts";
import type { Database } from "./db";

// What the reader typed over a material: title, byline, date, tags, a note. Stored apart from the
// JSON record so a re-fetch never overwrites it; MaterialStore lays it over the record on read.

export const MAX_TAGS = 20;
export const MAX_TAG_LENGTH = 40;

interface Row { material_id: string; title: string | null; byline: string | null; published_at: string | null; tags: string; note: string | null }

/** Trimmed, at most 40 characters each, deduplicated case-insensitively (first spelling wins), at most 20. */
export function normalizeTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim().slice(0, MAX_TAG_LENGTH).trim();
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    kept.push(tag);
    if (kept.length === MAX_TAGS) break;
  }
  return kept;
}

function toMeta(row: Row): MaterialMeta {
  const tags = JSON.parse(row.tags) as string[];
  return {
    ...(row.title ? { title: row.title } : {}),
    ...(row.byline ? { byline: row.byline } : {}),
    ...(row.published_at ? { publishedAt: row.published_at } : {}),
    ...(tags.length > 0 ? { tags } : {}),
    ...(row.note ? { note: row.note } : {}),
  };
}

/** `undefined` keeps the stored value, an empty string (or empty array) clears it, anything else replaces it. */
function mergeField<T extends string | string[]>(current: T | undefined, patch: T | undefined): T | undefined {
  if (patch === undefined) return current;
  return patch.length === 0 ? undefined : patch;
}

export class MetaStore {
  constructor(private readonly db: Database, private readonly now: () => Date = () => new Date()) {}

  get(materialId: string): MaterialMeta | undefined {
    const row = this.db.prepare("SELECT material_id, title, byline, published_at, tags, note FROM material_meta WHERE material_id = ?").get(materialId) as unknown as Row | undefined;
    return row ? toMeta(row) : undefined;
  }

  /** Every override at once, for list views. */
  all(): Map<string, MaterialMeta> {
    const rows = this.db.prepare("SELECT material_id, title, byline, published_at, tags, note FROM material_meta").all() as unknown as Row[];
    return new Map(rows.map((row) => [row.material_id, toMeta(row)]));
  }

  /** Merges the patch into what is stored; a row with nothing left is removed. Returns the effective overrides. */
  update(materialId: string, patch: MaterialMeta): MaterialMeta {
    const current = this.get(materialId) ?? {};
    const title = mergeField(current.title, patch.title?.trim());
    const byline = mergeField(current.byline, patch.byline?.trim());
    const publishedAt = mergeField(current.publishedAt, patch.publishedAt?.trim());
    const note = mergeField(current.note, patch.note?.trim());
    const tags = mergeField(current.tags, patch.tags ? normalizeTags(patch.tags) : undefined);
    const next: MaterialMeta = {
      ...(title ? { title } : {}), ...(byline ? { byline } : {}), ...(publishedAt ? { publishedAt } : {}),
      ...(tags && tags.length > 0 ? { tags } : {}), ...(note ? { note } : {}),
    };
    if (Object.keys(next).length === 0) { this.remove(materialId); return next; }
    this.db.prepare(`INSERT INTO material_meta (material_id, title, byline, published_at, tags, note, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (material_id) DO UPDATE SET title = excluded.title, byline = excluded.byline, published_at = excluded.published_at, tags = excluded.tags, note = excluded.note, updated_at = excluded.updated_at`)
      .run(materialId, next.title ?? null, next.byline ?? null, next.publishedAt ?? null, JSON.stringify(next.tags ?? []), next.note ?? null, this.now().toISOString());
    return next;
  }

  /** Every tag in use with how many materials carry it; most used first, then alphabetical. */
  tags(): TagCount[] {
    const counts = new Map<string, number>();
    for (const { tags } of this.all().values()) for (const tag of tags ?? []) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    return [...counts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, undefined, { sensitivity: "base" }));
  }

  remove(materialId: string): void {
    this.db.prepare("DELETE FROM material_meta WHERE material_id = ?").run(materialId);
  }
}
