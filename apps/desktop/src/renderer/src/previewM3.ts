import type { LibraryFilter, MaterialMeta, MaterialRecord, MaterialSummary, ReadApiM3, Settings, TagCount } from "../../shared/contracts";
import { keepPreviewItem } from "./previewM1";

// The M3 half of the browser preview: metadata overrides, tags, the Library query, deletion,
// keep and settings — all in localStorage, mirroring what the engine does with its stores.
// Agent sessions need Codex, so they read as empty.

const META_KEY = "read:preview-meta";
const DELETED_KEY = "read:preview-deleted";
const SETTINGS_KEY = "read:preview-settings";
const PREVIEW_DATA_DIRECTORY = "~/Library/Application Support/Quire (preview: nothing is written here)";
const MAX_TAGS = 20;
const MAX_TAG_LENGTH = 40;
const MIN_SYNC_MINUTES = 5;
const MAX_SYNC_MINUTES = 1440;
const MAX_MODEL_LENGTH = 64;
const EFFORTS: readonly Settings["agentReasoningEffort"][] = ["", "low", "medium", "high"];
const SETTINGS_DEFAULTS: Omit<Settings, "dataDirectory"> = { syncIntervalMinutes: 30, keepCapture: true, codexPath: "", agentModel: "", agentReasoningEffort: "" };

function readJson<T>(key: string, fallback: T): T {
  const raw = localStorage.getItem(key);
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; }
  catch (error) { throw new Error(`Preview state unreadable (${(error as Error).message}); clear localStorage key ${key}.`); }
}
function writeJson(key: string, value: unknown) { localStorage.setItem(key, JSON.stringify(value)); }

const metaAll = () => readJson<Record<string, MaterialMeta>>(META_KEY, {});
const deletedIds = () => new Set(readJson<string[]>(DELETED_KEY, []));

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

/** `undefined` keeps the stored value, an empty string (or empty array) clears it, anything else replaces it. */
function mergeField<T extends string | string[]>(current: T | undefined, patch: T | undefined): T | undefined {
  if (patch === undefined) return current;
  return patch.length === 0 ? undefined : patch;
}

function mergeMeta(current: MaterialMeta, patch: MaterialMeta): MaterialMeta {
  if (patch.publishedAt && Number.isNaN(Date.parse(patch.publishedAt))) throw new Error("The published date is not a date.");
  const title = mergeField(current.title, patch.title?.trim());
  const byline = mergeField(current.byline, patch.byline?.trim());
  const publishedAt = mergeField(current.publishedAt, patch.publishedAt?.trim());
  const note = mergeField(current.note, patch.note?.trim());
  const tags = mergeField(current.tags, patch.tags ? normalizeTags(patch.tags) : undefined);
  return { ...(title ? { title } : {}), ...(byline ? { byline } : {}), ...(publishedAt ? { publishedAt } : {}), ...(tags && tags.length ? { tags } : {}), ...(note ? { note } : {}) };
}

/** The effective summary: the extracted values with the overrides laid over, and the tags. */
export function overlaySummary<T extends MaterialSummary>(material: T, meta: MaterialMeta | undefined): T {
  return {
    ...material,
    ...(meta?.title ? { title: meta.title } : {}),
    ...(meta?.byline ? { byline: meta.byline } : {}),
    ...(meta?.publishedAt ? { publishedAt: meta.publishedAt } : {}),
    tags: meta?.tags ?? [],
  };
}
function overlayRecord(material: MaterialRecord, meta: MaterialMeta | undefined): MaterialRecord {
  return { ...overlaySummary(material, meta), ...(meta && Object.keys(meta).length ? { overrides: meta } : {}) };
}

type Kind = NonNullable<LibraryFilter["kind"]>;
const KINDS: Record<Kind, (material: MaterialSummary) => boolean> = {
  all: () => true,
  articles: (material) => material.mediaType !== "application/pdf" && material.origin !== "agent",
  pdf: (material) => material.mediaType === "application/pdf",
  artifact: (material) => material.origin === "agent",
  feed: (material) => material.origin === "feed",
};
const byFetched = (a: MaterialSummary, b: MaterialSummary) => b.fetchedAt.localeCompare(a.fetchedAt);
const byTitle = (a: MaterialSummary, b: MaterialSummary) => a.title.localeCompare(b.title, undefined, { sensitivity: "base", numeric: true }) || byFetched(a, b);
function byPublished(a: MaterialSummary, b: MaterialSummary): number {
  if (a.publishedAt && b.publishedAt) return b.publishedAt.localeCompare(a.publishedAt) || byFetched(a, b);
  if (a.publishedAt) return -1;
  if (b.publishedAt) return 1;
  return byFetched(a, b);
}

/** The engine's Library query, over summaries that already carry their tags. */
export function queryLibrary(summaries: readonly MaterialSummary[], filter: LibraryFilter): MaterialSummary[] {
  const kind = KINDS[filter.kind ?? "all"];
  const tag = filter.tag?.trim().toLowerCase();
  const words = (filter.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const compare = filter.sort === "published" ? byPublished : filter.sort === "title" ? byTitle : byFetched;
  return summaries
    .filter((material) => kind(material))
    .filter((material) => !tag || material.tags.some((candidate) => candidate.toLowerCase() === tag))
    .filter((material) => words.length === 0 || words.every((word) => `${material.title} ${material.byline ?? ""} ${material.tags.join(" ")}`.toLowerCase().includes(word)))
    .sort(compare);
}

function validateSettings(patch: Partial<Omit<Settings, "dataDirectory">>): Partial<Omit<Settings, "dataDirectory">> {
  const { syncIntervalMinutes, keepCapture, codexPath, agentModel, agentReasoningEffort } = patch;
  const unknown = Object.keys(patch).filter((key) => !(key in SETTINGS_DEFAULTS));
  if (unknown.length) throw new Error(`Unknown or read-only setting(s): ${unknown.join(", ")}.`);
  if (syncIntervalMinutes !== undefined && (!Number.isInteger(syncIntervalMinutes) || syncIntervalMinutes < MIN_SYNC_MINUTES || syncIntervalMinutes > MAX_SYNC_MINUTES)) throw new Error(`syncIntervalMinutes must be a whole number of minutes between ${MIN_SYNC_MINUTES} and ${MAX_SYNC_MINUTES}.`);
  if (keepCapture !== undefined && typeof keepCapture !== "boolean") throw new Error("keepCapture must be true or false.");
  if (agentModel !== undefined && agentModel.trim().length > MAX_MODEL_LENGTH) throw new Error(`agentModel must be at most ${MAX_MODEL_LENGTH} characters, or empty for Codex's default.`);
  if (agentReasoningEffort !== undefined && !EFFORTS.includes(agentReasoningEffort)) throw new Error('agentReasoningEffort must be "", "low", "medium" or "high".');
  return {
    ...(syncIntervalMinutes !== undefined ? { syncIntervalMinutes } : {}),
    ...(keepCapture !== undefined ? { keepCapture } : {}),
    ...(codexPath !== undefined ? { codexPath: codexPath.trim() } : {}),
    ...(agentModel !== undefined ? { agentModel: agentModel.trim() } : {}),
    ...(agentReasoningEffort !== undefined ? { agentReasoningEffort } : {}),
  };
}

export interface PreviewM3 extends ReadApiM3 {
  /** The base list and record with overrides applied and deleted materials removed; api.ts serves these. */
  getMaterial: (id: string) => Promise<MaterialRecord | undefined>;
  listMaterials: () => Promise<MaterialSummary[]>;
  onLibraryChanged: (listener: () => void) => () => void;
}

export function createPreviewM3(deps: { getMaterial: (id: string) => Promise<MaterialRecord | undefined>; listMaterials: () => Promise<MaterialSummary[]> }): PreviewM3 {
  const listeners = new Set<() => void>();
  const notify = () => { for (const listener of listeners) listener(); };

  const getMaterial = async (id: string) => {
    if (deletedIds().has(id)) return undefined;
    const record = await deps.getMaterial(id);
    return record ? overlayRecord(record, metaAll()[id]) : undefined;
  };
  const listMaterials = async () => {
    const deleted = deletedIds();
    const meta = metaAll();
    return (await deps.listMaterials()).filter((material) => !deleted.has(material.id)).map((material) => overlaySummary(material, meta[material.id]));
  };
  const settings = (): Settings => ({ ...SETTINGS_DEFAULTS, ...readJson<Partial<Settings>>(SETTINGS_KEY, {}), dataDirectory: PREVIEW_DATA_DIRECTORY });

  return {
    getMaterial,
    listMaterials,
    onLibraryChanged: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },

    queryLibrary: async (filter) => queryLibrary(await listMaterials(), filter),
    updateMaterialMeta: async (id, patch) => {
      const base = await deps.getMaterial(id);
      if (!base || deletedIds().has(id)) throw new Error("This material is no longer in the library.");
      const all = metaAll();
      const next = mergeMeta(all[id] ?? {}, patch);
      const { [id]: _dropped, ...rest } = all;
      writeJson(META_KEY, Object.keys(next).length ? { ...rest, [id]: next } : rest);
      notify();
      return overlayRecord(base, Object.keys(next).length ? next : undefined);
    },
    listTags: async (): Promise<TagCount[]> => {
      const deleted = deletedIds();
      const counts = new Map<string, number>();
      for (const [id, meta] of Object.entries(metaAll())) {
        if (deleted.has(id)) continue;
        for (const tag of meta.tags ?? []) counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
      return [...counts.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, undefined, { sensitivity: "base" }));
    },
    deleteMaterials: async (ids) => {
      if (ids.length === 0) throw new Error("Nothing selected to delete.");
      writeJson(DELETED_KEY, [...new Set([...deletedIds(), ...ids])]);
      writeJson(META_KEY, Object.fromEntries(Object.entries(metaAll()).filter(([id]) => !ids.includes(id))));
      for (const id of ids) localStorage.removeItem(`read:preview-annotations:${id}`);
      notify();
    },
    keepItem: async (id) => {
      const result = await keepPreviewItem(id, getMaterial);
      if (result.ok) notify();
      return result;
    },

    getSettings: async () => settings(),
    updateSettings: async (patch) => {
      const current = readJson<Partial<Settings>>(SETTINGS_KEY, {});
      writeJson(SETTINGS_KEY, { ...current, ...validateSettings(patch) });
      return settings();
    },

    // Sessions are written by the Codex bridge; the browser has none.
    listAgentSessions: async () => [],
    getAgentSession: async () => undefined,
    deleteAgentSession: async (id) => { throw new Error(`No agent session ${id} in the browser preview; sessions need the desktop app.`); },
    onAgentSessionsChanged: () => () => undefined,
  };
}
