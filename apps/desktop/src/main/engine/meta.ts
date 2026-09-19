import { MATERIAL_KIND_FIELDS, type Creator, type MaterialMeta, type TagCount } from "../../shared/contracts";
import type { Database } from "./db";

// What the reader typed over a material: one MaterialMeta document of overrides per material,
// stored apart from the JSON record so a re-fetch never overwrites it. MaterialStore lays it
// over the extracted layer on read (applyOverrides in metadata.ts).

export const MAX_TAGS = 20;
export const MAX_TAG_LENGTH = 40;
export const MAX_META_TEXT = 2000;
export const MAX_META_LONG_TEXT = 20_000;
export const MAX_CREATORS = 50;
export const MAX_RELATED = 50;

export const MATERIAL_KINDS = Object.keys(MATERIAL_KIND_FIELDS) as NonNullable<MaterialMeta["kind"]>[];
export const CREATOR_ROLES: readonly Creator["role"][] = ["author", "editor", "translator", "contributor"];

const SHORT_TEXT: readonly (keyof MaterialMeta)[] = ["title", "shortTitle", "publication", "volume", "issue", "pages", "publisher", "place", "edition", "series", "language", "url"];
const LONG_TEXT: readonly (keyof MaterialMeta)[] = ["abstract", "note", "extra"];
const KNOWN_KEYS: readonly string[] = ["kind", ...SHORT_TEXT, ...LONG_TEXT, "creators", "date", "accessed", "doi", "arxivId", "isbn", "issn", "tags", "related"];
const ISO_DATE = /^\d{4}(?:-\d{2}(?:-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?)?)?$/;
const MATERIAL_ID = /^[a-f0-9]{16}$/;
const PATTERNS: Partial<Record<keyof MaterialMeta, RegExp>> = {
  doi: /^10\.\d{4,9}\/\S+$/i,
  arxivId: /^(?:\d{4}\.\d{4,5}|[a-z-]+\/\d{7})(?:v\d+)?$/i,
  isbn: /^[\dXx][\dXx -]{8,15}[\dXx]$/,
  issn: /^\d{4}-?\d{3}[\dXx]$/,
};

interface Row { material_id: string; overrides: string }

export interface MetaStoreOptions {
  now?: () => Date;
  /** Related ids must name materials in the library; without a checker, `related` is refused. */
  materialExists?: (id: string) => Promise<boolean>;
}

export class MetaValidationError extends Error {}

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

function invalid(message: string): never {
  throw new MetaValidationError(`Invalid metadata: ${message}`);
}

function textOf(key: string, value: unknown, max: number): string {
  if (typeof value !== "string") invalid(`${key} must be a string.`);
  if (value.length > max) invalid(`${key} is longer than ${max} characters.`);
  return value.trim();
}

function creatorOf(value: unknown, index: number): Creator {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid(`creators[${index}] must be an object.`);
  const creator = value as Record<string, unknown>;
  const extra = Object.keys(creator).filter((key) => !["role", "name", "given", "family"].includes(key));
  if (extra.length > 0) invalid(`creators[${index}] has unknown field(s): ${extra.join(", ")}.`);
  if (!CREATOR_ROLES.includes(creator.role as Creator["role"])) invalid(`creators[${index}].role must be one of ${CREATOR_ROLES.join(", ")}.`);
  const name = textOf(`creators[${index}].name`, creator.name, MAX_META_TEXT);
  if (!name) invalid(`creators[${index}].name must not be empty.`);
  const given = creator.given === undefined ? undefined : textOf(`creators[${index}].given`, creator.given, MAX_META_TEXT);
  const family = creator.family === undefined ? undefined : textOf(`creators[${index}].family`, creator.family, MAX_META_TEXT);
  return { role: creator.role as Creator["role"], name, ...(given ? { given } : {}), ...(family ? { family } : {}) };
}

function arrayOf(key: string, value: unknown, max: number): unknown[] {
  if (!Array.isArray(value)) invalid(`${key} must be an array.`);
  if (value.length > max) invalid(`${key} has more than ${max} entries.`);
  return value;
}

/** A patch as the bridge delivers it, checked field by field. Empty strings and arrays are kept: they mean "clear". */
export function validateMetaPatch(value: unknown): MaterialMeta {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid("the patch must be an object.");
  const patch = value as Record<string, unknown>;
  const unknown = Object.keys(patch).filter((key) => !KNOWN_KEYS.includes(key));
  if (unknown.length > 0) invalid(`unknown field(s): ${unknown.join(", ")}.`);
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(patch)) {
    if (raw === undefined) continue;
    if (key === "kind") {
      if (raw !== "" && !MATERIAL_KINDS.includes(raw as NonNullable<MaterialMeta["kind"]>)) invalid(`kind must be one of ${MATERIAL_KINDS.join(", ")}.`);
      out.kind = raw;
    } else if (key === "tags") {
      out.tags = normalizeTags(arrayOf("tags", raw, MAX_TAGS * 2).map((tag, index) => textOf(`tags[${index}]`, tag, MAX_TAG_LENGTH * 2)));
    } else if (key === "creators") {
      out.creators = arrayOf("creators", raw, MAX_CREATORS).map(creatorOf);
    } else if (key === "related") {
      const ids = arrayOf("related", raw, MAX_RELATED).map((id, index) => textOf(`related[${index}]`, id, 16));
      const bad = ids.find((id) => !MATERIAL_ID.test(id));
      if (bad !== undefined) invalid(`related contains "${bad}", which is not a material id.`);
      out.related = [...new Set(ids)];
    } else if (key === "date" || key === "accessed") {
      const text = textOf(key, raw, 40);
      if (text && !ISO_DATE.test(text)) invalid(`${key} must be YYYY, YYYY-MM, YYYY-MM-DD or an ISO timestamp.`);
      out[key] = text;
    } else if (key in PATTERNS) {
      const text = textOf(key, raw, MAX_META_TEXT);
      if (text && !PATTERNS[key as keyof MaterialMeta]!.test(text)) invalid(`${key} does not look like a ${key}.`);
      out[key] = key === "doi" ? text.toLowerCase() : text;
    } else {
      out[key] = textOf(key, raw, LONG_TEXT.includes(key as keyof MaterialMeta) ? MAX_META_LONG_TEXT : MAX_META_TEXT);
    }
  }
  return out as MaterialMeta;
}

function isClear(value: unknown): boolean {
  return value === "" || (Array.isArray(value) && value.length === 0);
}

/** The stored overrides with the patch merged: "" or [] removes a field, anything else replaces it. */
export function mergeOverrides(current: MaterialMeta, patch: MaterialMeta): MaterialMeta {
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (isClear(value)) delete next[key];
    else next[key] = value;
  }
  return next as MaterialMeta;
}

export class MetaStore {
  private readonly now: () => Date;
  private readonly materialExists: MetaStoreOptions["materialExists"];

  constructor(private readonly db: Database, options: MetaStoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.materialExists = options.materialExists;
  }

  get(materialId: string): MaterialMeta | undefined {
    const row = this.db.prepare("SELECT material_id, overrides FROM material_meta WHERE material_id = ?").get(materialId) as unknown as Row | undefined;
    return row ? (JSON.parse(row.overrides) as MaterialMeta) : undefined;
  }

  /** Every override at once, for list views. */
  all(): Map<string, MaterialMeta> {
    const rows = this.db.prepare("SELECT material_id, overrides FROM material_meta").all() as unknown as Row[];
    return new Map(rows.map((row) => [row.material_id, JSON.parse(row.overrides) as MaterialMeta]));
  }

  /** Validates and merges the patch into what is stored; a row with nothing left is removed. Returns the effective overrides. */
  async update(materialId: string, patch: MaterialMeta): Promise<MaterialMeta> {
    const valid = validateMetaPatch(patch);
    if (valid.related && valid.related.length > 0) await this.assertRelated(materialId, valid.related);
    const next = mergeOverrides(this.get(materialId) ?? {}, valid);
    if (Object.keys(next).length === 0) { this.remove(materialId); return next; }
    this.db.prepare(`INSERT INTO material_meta (material_id, overrides, updated_at) VALUES (?, ?, ?)
      ON CONFLICT (material_id) DO UPDATE SET overrides = excluded.overrides, updated_at = excluded.updated_at`)
      .run(materialId, JSON.stringify(next), this.now().toISOString());
    return next;
  }

  private async assertRelated(materialId: string, ids: readonly string[]): Promise<void> {
    const exists = this.materialExists;
    if (!exists) invalid("related materials cannot be checked in this store.");
    if (ids.includes(materialId)) invalid("a material cannot relate to itself.");
    const present = await Promise.all(ids.map((id) => exists(id)));
    const missing = ids.filter((_, index) => !present[index]);
    if (missing.length > 0) invalid(`related names material(s) not in the library: ${missing.join(", ")}.`);
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
