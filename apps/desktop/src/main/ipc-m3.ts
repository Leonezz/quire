import { ipcMain } from "electron";
import type { LibraryFilter, MaterialMeta, OpenUrlResult } from "../shared/contracts";
import type { AnnotationStore } from "./engine/annotations";
import type { EventStore } from "./engine/events";
import type { ItemStore } from "./engine/items";
import { keepItem } from "./engine/inbox";
import { deleteMaterials, queryLibrary } from "./engine/library";
import type { MaterialStore } from "./engine/materials";
import { MAX_TAGS, MAX_TAG_LENGTH, type MetaStore } from "./engine/meta";
import type { SessionStore } from "./engine/agent-sessions";
import type { SettingsPatch, SettingsStore } from "./engine/settings";

// M3 handlers: library management, settings, agent sessions. Same rule as index.ts: validate
// every argument before touching a store, broadcast after every change the renderer must see.

export type M3Channel = "library:changed" | "sources:changed" | "agent:sessions:changed";

export interface M3Deps {
  store: MaterialStore;
  meta: MetaStore;
  annotations: AnnotationStore;
  items: ItemStore;
  events: EventStore;
  settings: SettingsStore;
  sessions: SessionStore;
  broadcast: (channel: M3Channel) => void;
  /** The codexPath changed: the running app-server must be restarted with the new binary. */
  onCodexPathChanged: () => void;
  withPrefetch: (result: Promise<OpenUrlResult>) => Promise<OpenUrlResult>;
  warn: (message: string) => void;
}

const MAX_DELETE_IDS = 5000;
const MAX_META_TEXT = 500;
const MAX_NOTE = 20_000;
const KINDS: readonly NonNullable<LibraryFilter["kind"]>[] = ["all", "articles", "pdf", "artifact", "feed"];
const SORTS: readonly NonNullable<LibraryFilter["sort"]>[] = ["fetched", "published", "title"];
const SETTING_KEYS = ["syncIntervalMinutes", "keepCapture", "codexPath", "agentModel", "agentReasoningEffort"] as const;

function materialId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{16}$/.test(value)) throw new Error("IPC_INVALID_ID");
  return value;
}
function boundedId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) throw new Error("IPC_INVALID_ID");
  return value;
}
function optionalText(value: unknown, max: number, code: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > max) throw new Error(code);
  return value;
}

function libraryFilter(value: unknown): LibraryFilter {
  const filter = (value ?? {}) as { kind?: unknown; tag?: unknown; query?: unknown; sort?: unknown };
  if (typeof filter !== "object") throw new Error("IPC_INVALID_FILTER");
  if (filter.kind !== undefined && !KINDS.includes(filter.kind as NonNullable<LibraryFilter["kind"]>)) throw new Error("IPC_INVALID_FILTER");
  if (filter.sort !== undefined && !SORTS.includes(filter.sort as NonNullable<LibraryFilter["sort"]>)) throw new Error("IPC_INVALID_FILTER");
  const tag = optionalText(filter.tag, MAX_TAG_LENGTH, "IPC_INVALID_FILTER");
  const query = optionalText(filter.query, 200, "IPC_INVALID_FILTER");
  return {
    ...(filter.kind !== undefined ? { kind: filter.kind as LibraryFilter["kind"] } : {}),
    ...(tag !== undefined ? { tag } : {}), ...(query !== undefined ? { query } : {}),
    ...(filter.sort !== undefined ? { sort: filter.sort as LibraryFilter["sort"] } : {}),
  };
}

function metaPatch(value: unknown): MaterialMeta {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("IPC_INVALID_META");
  const patch = value as Record<string, unknown>;
  const unknown = Object.keys(patch).filter((key) => !["title", "byline", "publishedAt", "tags", "note"].includes(key));
  if (unknown.length > 0) throw new Error("IPC_INVALID_META");
  if (patch.tags !== undefined && (!Array.isArray(patch.tags) || patch.tags.length > MAX_TAGS * 2 || !patch.tags.every((tag) => typeof tag === "string" && tag.length <= MAX_TAG_LENGTH * 2))) throw new Error("IPC_INVALID_META");
  const title = optionalText(patch.title, MAX_META_TEXT, "IPC_INVALID_META");
  const byline = optionalText(patch.byline, MAX_META_TEXT, "IPC_INVALID_META");
  const publishedAt = optionalText(patch.publishedAt, 40, "IPC_INVALID_META");
  const note = optionalText(patch.note, MAX_NOTE, "IPC_INVALID_META");
  if (publishedAt && Number.isNaN(Date.parse(publishedAt))) throw new Error("IPC_INVALID_META");
  return {
    ...(title !== undefined ? { title } : {}), ...(byline !== undefined ? { byline } : {}), ...(publishedAt !== undefined ? { publishedAt } : {}),
    ...(patch.tags !== undefined ? { tags: patch.tags as string[] } : {}), ...(note !== undefined ? { note } : {}),
  };
}

function settingsPatch(value: unknown): SettingsPatch {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("IPC_INVALID_SETTINGS");
  const patch = value as Record<string, unknown>;
  if (Object.keys(patch).some((key) => !(SETTING_KEYS as readonly string[]).includes(key))) throw new Error("IPC_INVALID_SETTINGS");
  for (const key of ["codexPath", "agentModel", "agentReasoningEffort"] as const) if (patch[key] !== undefined && (typeof patch[key] !== "string" || (patch[key] as string).length > 1024)) throw new Error("IPC_INVALID_SETTINGS");
  return patch as SettingsPatch;
}

export function registerM3Handlers(deps: M3Deps): void {
  const { store, meta, annotations, items, events, settings, sessions, broadcast } = deps;

  ipcMain.handle("library:query", async (_event, filter: unknown) => queryLibrary(await store.list(), libraryFilter(filter)));
  ipcMain.handle("material:updateMeta", async (_event, id: unknown, patch: unknown) => {
    const materialIdValue = materialId(id);
    if (!(await store.get(materialIdValue))) throw new Error("MATERIAL_NOT_FOUND");
    meta.update(materialIdValue, metaPatch(patch));
    const updated = await store.get(materialIdValue);
    if (!updated) throw new Error("MATERIAL_NOT_FOUND");
    broadcast("library:changed");
    return updated;
  });
  ipcMain.handle("material:tags", () => meta.tags());
  ipcMain.handle("material:delete", async (_event, ids: unknown) => {
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_DELETE_IDS) throw new Error("IPC_INVALID_IDS");
    const result = await deleteMaterials(ids.map(materialId), { store, annotations, items });
    broadcast("library:changed");
    if (result.unlinkedItems > 0) broadcast("sources:changed");
  });
  ipcMain.handle("item:keep", (_event, id: unknown) => deps.withPrefetch(keepItem(boundedId(id), {
    items, events, store, warn: (message) => deps.warn(`[inbox] ${message}`),
    onMaterialized: () => broadcast("library:changed"),
  }).then((result) => { if (result.ok) broadcast("sources:changed"); return result; })));

  ipcMain.handle("settings:get", () => settings.get());
  ipcMain.handle("settings:update", (_event, patch: unknown) => {
    const before = settings.get();
    const after = settings.update(settingsPatch(patch));
    if (before.codexPath !== after.codexPath) deps.onCodexPathChanged();
    return after;
  });

  ipcMain.handle("agent:sessions:list", () => sessions.list());
  ipcMain.handle("agent:sessions:get", (_event, id: unknown) => sessions.get(boundedId(id)));
  ipcMain.handle("agent:sessions:delete", (_event, id: unknown) => {
    sessions.delete(boundedId(id));
    broadcast("agent:sessions:changed");
  });
}
