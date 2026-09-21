import type { LibraryFilter, MaterialMeta, MaterialRecord, MaterialSummary, ReadApiM3, Settings, SettingsPatch, TagCount } from "../../shared/contracts";
import { publicationOf } from "./materialMeta";
import { bibtexOf } from "../../shared/bibtex";
import { keepPreviewItem } from "./previewM1";
import { extractedOfSummary, knownFieldsOf, mergeOverrides, overlayRecord, overlaySummary } from "./previewMeta";
import { recordRebuild } from "./previewRebuild";
import { deleteSession, getSession, listSessions, onPreviewSessionsChanged } from "./previewSessions";

// The M3 half of the browser preview: metadata overrides (previewMeta.ts holds the model), tags,
// the Library query, BibTeX, deletion, keep and settings — all in localStorage, mirroring what
// the engine does with its stores.
// Agent sessions come from previewSessions.ts (the demo agent writes them); a rebuild's artifact
// and the `rebuiltAs` mark come from previewRebuild.ts.

const META_KEY = "read:preview-meta";
const DELETED_KEY = "read:preview-deleted";
const SETTINGS_KEY = "read:preview-settings";
const PREVIEW_DATA_DIRECTORY = "~/Library/Application Support/Quire (preview: nothing is written here)";
const MIN_SYNC_MINUTES = 5;
const MAX_SYNC_MINUTES = 1440;
const MAX_MODEL_LENGTH = 64;
const EFFORTS: readonly Settings["agentReasoningEffort"][] = ["", "low", "medium", "high"];
const JUDGES: readonly Settings["reflowJudge"][] = ["rules", "jev"];
/** What the preview keeps: the editable settings plus whether a key was entered (never the key itself). */
type PreviewStored = Omit<Settings, "dataDirectory">;
const SETTINGS_DEFAULTS: PreviewStored = { syncIntervalMinutes: 30, keepCapture: true, codexPath: "", agentModel: "", agentReasoningEffort: "", checkUpdatesAutomatically: true, reflowJudge: "rules", typesafeApiKeySet: false };

function readJson<T>(key: string, fallback: T): T {
  const raw = localStorage.getItem(key);
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; }
  catch (error) { throw new Error(`Preview state unreadable (${(error as Error).message}); clear localStorage key ${key}.`); }
}
function writeJson(key: string, value: unknown) { localStorage.setItem(key, JSON.stringify(value)); }

/** Stored overrides, minus any field from the pre-model shape (byline / publishedAt) an old preview may have written. */
const overridesAll = (): Record<string, MaterialMeta> => Object.fromEntries(Object.entries(readJson<Record<string, Record<string, unknown>>>(META_KEY, {})).map(([id, meta]) => [id, knownFieldsOf(meta)]));
const deletedIds = () => new Set(readJson<string[]>(DELETED_KEY, []));

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
    .filter((material) => !filter.materialKind || material.kind === filter.materialKind)
    .filter((material) => !tag || material.tags.some((candidate) => candidate.toLowerCase() === tag))
    .filter((material) => words.length === 0 || words.every((word) => `${material.title} ${material.byline ?? ""} ${publicationOf(material) ?? ""} ${material.tags.join(" ")}`.toLowerCase().includes(word)))
    .sort(compare);
}

/** The engine's validation, mirrored; the key is stored as a boolean only (the preview has no keychain). */
function validateSettings(patch: SettingsPatch, current: PreviewStored): Partial<PreviewStored> {
  const { syncIntervalMinutes, keepCapture, codexPath, agentModel, agentReasoningEffort, checkUpdatesAutomatically, reflowJudge, typesafeApiKey } = patch;
  const unknown = Object.keys(patch).filter((key) => !(key in SETTINGS_DEFAULTS && key !== "typesafeApiKeySet") && key !== "typesafeApiKey");
  if (unknown.length) throw new Error(`Unknown or read-only setting(s): ${unknown.join(", ")}.`);
  if (syncIntervalMinutes !== undefined && (!Number.isInteger(syncIntervalMinutes) || syncIntervalMinutes < MIN_SYNC_MINUTES || syncIntervalMinutes > MAX_SYNC_MINUTES)) throw new Error(`syncIntervalMinutes must be a whole number of minutes between ${MIN_SYNC_MINUTES} and ${MAX_SYNC_MINUTES}.`);
  if (keepCapture !== undefined && typeof keepCapture !== "boolean") throw new Error("keepCapture must be true or false.");
  if (checkUpdatesAutomatically !== undefined && typeof checkUpdatesAutomatically !== "boolean") throw new Error("checkUpdatesAutomatically must be true or false.");
  if (agentModel !== undefined && agentModel.trim().length > MAX_MODEL_LENGTH) throw new Error(`agentModel must be at most ${MAX_MODEL_LENGTH} characters, or empty for Codex's default.`);
  if (agentReasoningEffort !== undefined && !EFFORTS.includes(agentReasoningEffort)) throw new Error('agentReasoningEffort must be "", "low", "medium" or "high".');
  if (reflowJudge !== undefined && !JUDGES.includes(reflowJudge)) throw new Error('reflowJudge must be "rules" or "jev".');
  const keySet = typesafeApiKey !== undefined ? typesafeApiKey.trim().length > 0 : current.typesafeApiKeySet;
  if (reflowJudge === "jev" && !keySet) throw new Error('reflowJudge "jev" needs a TypeSafe API key: store the key first (Settings › Agent), then choose Jev.');
  return {
    ...(syncIntervalMinutes !== undefined ? { syncIntervalMinutes } : {}),
    ...(keepCapture !== undefined ? { keepCapture } : {}),
    ...(codexPath !== undefined ? { codexPath: codexPath.trim() } : {}),
    ...(agentModel !== undefined ? { agentModel: agentModel.trim() } : {}),
    ...(agentReasoningEffort !== undefined ? { agentReasoningEffort } : {}),
    ...(checkUpdatesAutomatically !== undefined ? { checkUpdatesAutomatically } : {}),
    ...(reflowJudge !== undefined ? { reflowJudge } : {}),
    ...(typesafeApiKey !== undefined ? { typesafeApiKeySet: keySet, ...(!keySet && current.reflowJudge === "jev" ? { reflowJudge: "rules" as const } : {}) } : {}),
  };
}

export interface PreviewM3 extends ReadApiM3 {
  /** The base list and record with overrides applied and deleted materials removed; api.ts serves these. */
  getMaterial: (id: string) => Promise<MaterialRecord | undefined>;
  listMaterials: () => Promise<MaterialSummary[]>;
  onLibraryChanged: (listener: () => void) => () => void;
  /** The demo agent rebuilt a material: the artifact is stored, the material marked, and library:changed fires. */
  markRebuilt: (materialId: string, artifact: MaterialRecord) => void;
  /** Another preview store changed what the library lists (a view was fetched or made primary): library:changed fires. */
  notifyLibraryChanged: () => void;
}

export function createPreviewM3(deps: { getMaterial: (id: string) => Promise<MaterialRecord | undefined>; listMaterials: () => Promise<MaterialSummary[]> }): PreviewM3 {
  const listeners = new Set<() => void>();
  const notify = () => { for (const listener of listeners) listener(); };

  const getMaterial = async (id: string) => {
    if (deletedIds().has(id)) return undefined;
    const record = await deps.getMaterial(id);
    return record ? overlayRecord(record, overridesAll()[id]) : undefined;
  };
  const listMaterials = async () => {
    const deleted = deletedIds();
    const overrides = overridesAll();
    return (await deps.listMaterials()).filter((material) => !deleted.has(material.id)).map((material) => overlaySummary(material, extractedOfSummary(material), overrides[material.id]));
  };
  const requireMaterial = async (id: string) => {
    const record = await getMaterial(id);
    if (!record) throw new Error("This material is no longer in the library.");
    return record;
  };
  const settings = (): Settings => ({ ...SETTINGS_DEFAULTS, ...readJson<Partial<Settings>>(SETTINGS_KEY, {}), dataDirectory: PREVIEW_DATA_DIRECTORY });

  return {
    getMaterial,
    listMaterials,
    onLibraryChanged: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    markRebuilt: (materialId, artifact) => { recordRebuild(materialId, artifact); notify(); },
    notifyLibraryChanged: notify,

    queryLibrary: async (filter) => queryLibrary(await listMaterials(), filter),
    updateMaterialMeta: async (id, patch) => {
      const base = await deps.getMaterial(id);
      if (!base || deletedIds().has(id)) throw new Error("This material is no longer in the library.");
      const all = overridesAll();
      const next = mergeOverrides(all[id] ?? {}, patch);
      const { [id]: _dropped, ...rest } = all;
      writeJson(META_KEY, Object.keys(next).length ? { ...rest, [id]: next } : rest);
      notify();
      return overlayRecord(base, Object.keys(next).length ? next : undefined);
    },
    // Nothing to re-extract from in a browser: what the record declares is what it stays.
    refreshMetadata: async (id) => requireMaterial(id),
    exportBibtex: async (ids) => {
      if (ids.length === 0) throw new Error("Nothing selected to export.");
      const records = await Promise.all(ids.map(requireMaterial));
      return records.map((record) => bibtexOf(record.meta, record.id)).join("\n\n");
    },
    listTags: async (): Promise<TagCount[]> => {
      const deleted = deletedIds();
      const counts = new Map<string, number>();
      for (const [id, meta] of Object.entries(overridesAll())) {
        if (deleted.has(id)) continue;
        for (const tag of meta.tags ?? []) counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
      return [...counts.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, undefined, { sensitivity: "base" }));
    },
    deleteMaterials: async (ids) => {
      if (ids.length === 0) throw new Error("Nothing selected to delete.");
      writeJson(DELETED_KEY, [...new Set([...deletedIds(), ...ids])]);
      writeJson(META_KEY, Object.fromEntries(Object.entries(overridesAll()).filter(([id]) => !ids.includes(id))));
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
      const current = readJson<Partial<PreviewStored>>(SETTINGS_KEY, {});
      writeJson(SETTINGS_KEY, { ...current, ...validateSettings(patch, { ...SETTINGS_DEFAULTS, ...current }) });
      return settings();
    },

    // Sessions the demo agent wrote (previewSessions.ts); none until it has answered once.
    listAgentSessions: async () => listSessions(),
    getAgentSession: async (id) => getSession(id),
    deleteAgentSession: async (id) => { deleteSession(id); },
    onAgentSessionsChanged: onPreviewSessionsChanged,
  };
}
