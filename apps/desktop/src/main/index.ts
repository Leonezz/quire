import { app, BrowserWindow, Menu, Notification, ipcMain, nativeTheme, shell } from "electron";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { MaterialStore } from "./engine/materials";
import { ImageCache } from "./engine/images";
import { AnnotationStore } from "./engine/annotations";
import { imageUrlsOf } from "./engine/materials";
import type { AddSourceResult, AgentContext, AgentEvent, AgentRequest, AgentTask, ItemDecision, MaterialRecord, OpenUrlResult, ReadingEventKind, SearchHit } from "../shared/contracts";
import { MAX_BYTES, fetchPage } from "./engine/fetch";
import { openDatabase } from "./engine/db";
import { ItemStore } from "./engine/items";
import { SourceStore, detectSource } from "./engine/sources";
import { EventStore } from "./engine/events";
import { syncDue, syncSource } from "./engine/sync";
import { Scheduler } from "./engine/scheduler";
import { readItem } from "./engine/inbox";
import { itemHits, materialHits, mergeHits } from "./engine/search";
import { AgentService } from "./engine/agent";
import { agentTools, createToolHandler } from "./engine/agent-tools";
import { CodexClient } from "./engine/codex-client";
import { MetaStore } from "./engine/meta";
import { SettingsStore } from "./engine/settings";
import { SessionStore } from "./engine/agent-sessions";
import { registerM3Handlers } from "./ipc-m3";

const userData = app.getPath("userData");
const settings = new SettingsStore(join(userData, "settings.json"), userData, { warn: (message) => console.warn(`[settings] ${message}`) });
const db = openDatabase(join(userData, "quire.sqlite"));
// The two stores reference each other: overrides ride on records, and related ids must name records. The checker runs only inside update(), after both exist.
const meta: MetaStore = new MetaStore(db, { materialExists: (id): Promise<boolean> => store.has(id) });
const store: MaterialStore = new MaterialStore(userData, fetchPage, { meta, keepCapture: () => settings.get().keepCapture });
const images = new ImageCache(userData);
const annotations = new AnnotationStore(userData);
const items = new ItemStore(db);
const sources = new SourceStore(db, items);
const events = new EventStore(db);
const sessions = new SessionStore(db);

const MAX_QUEUE_IDS = 5000;
const DECISIONS: readonly ItemDecision[] = ["queue", "dismiss", "unqueue", "undismiss"];
const EVENT_KINDS: readonly ReadingEventKind[] = ["opened", "finished", "kept", "queued", "dismissed"];

function boundedString(value: unknown, max: number, code: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) throw new Error(code);
  return value;
}

function broadcast(channel: "library:changed" | "sources:changed" | "agent:event" | "agent:sessions:changed", payload?: AgentEvent) {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, payload);
}

// One JSON-RPC-ish boundary; every handler validates its input before touching the store.
// A kept article keeps its pictures: the cache fills in the background right after the save.
function withPrefetch(result: Promise<OpenUrlResult>): Promise<OpenUrlResult> {
  return result.then((outcome) => { if (outcome.ok) void images.prefetch(imageUrlsOf(outcome.material)); return outcome; });
}
function prefetchAll(records: readonly MaterialRecord[]) {
  void images.prefetch(records.flatMap((record) => imageUrlsOf(record)), 2);
}
ipcMain.handle("material:openUrl", (_event, url: unknown) => withPrefetch(store.openUrl(boundedString(url, 4096, "IPC_INVALID_URL"))));
ipcMain.handle("material:openFile", (_event, input: unknown) => {
  const value = input as { name?: unknown; mediaType?: unknown; bytes?: unknown };
  const name = boundedString(value?.name, 255, "IPC_INVALID_FILE_NAME");
  const mediaType = typeof value?.mediaType === "string" ? value.mediaType.slice(0, 100) : "";
  if (!(value?.bytes instanceof Uint8Array) || value.bytes.byteLength === 0 || value.bytes.byteLength > MAX_BYTES) throw new Error("IPC_INVALID_FILE_BYTES");
  return withPrefetch(store.openFile({ name, mediaType, bytes: value.bytes }));
});
ipcMain.handle("theme:set", (_event, theme: unknown) => {
  if (theme !== "system" && theme !== "light" && theme !== "dark") throw new Error("IPC_INVALID_THEME");
  nativeTheme.themeSource = theme;
});
ipcMain.handle("material:get", (_event, id: unknown) => store.get(boundedString(id, 64, "IPC_INVALID_ID")));
// The evaluation corpus lives in the repository; it exists only in a development checkout.
function corpusDirectory(): string | undefined {
  const candidate = resolve(app.getAppPath(), "..", "..", "eval", "corpus");
  return existsSync(candidate) ? candidate : undefined;
}

async function importCorpus() {
  const dir = corpusDirectory();
  if (!dir) throw new Error("No evaluation corpus next to this build (expected <repo>/eval/corpus).");
  const result = await store.importSnapshots(dir);
  broadcast("library:changed");
  const all = await store.list();
  prefetchAll((await Promise.all(all.map((item) => store.get(item.id)))).filter((record): record is MaterialRecord => record !== undefined));
  return result;
}
ipcMain.handle("material:importCorpus", () => importCorpus());
ipcMain.handle("annotation:list", (_event, materialId: unknown) => annotations.list(boundedString(materialId, 64, "IPC_INVALID_ID")));
ipcMain.handle("annotation:save", (_event, annotation: unknown) => {
  const value = annotation as Record<string, unknown>;
  if (!value || typeof value !== "object") throw new Error("IPC_INVALID_ANNOTATION");
  const kind = value.kind; const color = value.color;
  if (kind !== "highlight" && kind !== "underline" && kind !== "comment") throw new Error("IPC_INVALID_ANNOTATION");
  if (color !== "#ffd400" && color !== "#5fb236" && color !== "#2ea8e5" && color !== "#e56eee") throw new Error("IPC_INVALID_ANNOTATION");
  return annotations.save({
    id: boundedString(value.id, 64, "IPC_INVALID_ID"), materialId: boundedString(value.materialId, 64, "IPC_INVALID_ID"),
    locator: boundedString(value.locator, 20_000, "IPC_INVALID_ANNOTATION"), quote: typeof value.quote === "string" ? value.quote.slice(0, 20_000) : "",
    ...(typeof value.note === "string" ? { note: value.note.slice(0, 20_000) } : {}), kind, color, createdAt: "", updatedAt: "",
  });
});
ipcMain.handle("annotation:delete", (_event, materialId: unknown, id: unknown) => annotations.delete(boundedString(materialId, 64, "IPC_INVALID_ID"), boundedString(id, 64, "IPC_INVALID_ID")));
ipcMain.handle("image:resolve", (_event, url: unknown) => images.resolve(boundedString(url, 4096, "IPC_INVALID_URL")));
ipcMain.handle("material:bytes", (_event, id: unknown) => store.bytes(boundedString(id, 64, "IPC_INVALID_ID")));
ipcMain.handle("material:list", () => store.list());

// --- M1: sources, the Inbox / Queue loop, reading events, search ------------------------
// Every failure of a sync is written on the source (lastError) and reported; nothing is swallowed.
function reportSyncFailure(context: string, error: unknown) {
  console.error(`[sources] ${context}:`, error instanceof Error ? error.message : error);
}

async function addSource(input: string): Promise<AddSourceResult> {
  let detection;
  try { detection = await detectSource(input, fetchPage); }
  catch (error) { return { ok: false, code: "DETECT_FAILED", message: error instanceof Error ? error.message : String(error) }; }
  if (detection.kind === "page") return { ok: false, code: "NOT_A_FEED", message: `${detection.url} is a page without a feed. Paste its feed URL, or open the page itself in the library.` };
  let created;
  try {
    created = detection.kind === "arxiv"
      ? sources.add({ kind: "arxiv", locator: detection.category, title: detection.title })
      : sources.add({ kind: "feed", locator: detection.url, title: detection.title ?? new URL(detection.url).hostname });
  } catch (error) { return { ok: false, code: "SOURCE_EXISTS", message: error instanceof Error ? error.message : String(error) }; }
  const synced = await syncSource(created, { fetch: fetchPage, sources, items });
  broadcast("sources:changed");
  if (!synced.ok) reportSyncFailure(`first sync of ${created.locator}`, synced.message);
  return synced.ok ? { ok: true, source: synced.source, added: synced.added } : { ok: false, code: synced.code, message: synced.message };
}

// Every sync (scheduled, Sync all, Sync now on one source) runs under one lock, so two runs never touch the same source at once.
let syncLock: Promise<unknown> = Promise.resolve();
function exclusiveSync<T>(run: () => Promise<T>): Promise<T> {
  const next = syncLock.then(run, run);
  syncLock = next.catch(() => undefined);
  return next;
}
async function syncAll() {
  const outcome = await exclusiveSync(() => syncDue({ fetch: fetchPage, sources, items, intervalMinutes: () => settings.get().syncIntervalMinutes, onChanged: () => broadcast("sources:changed") }));
  for (const failure of outcome.failures) reportSyncFailure(`sync of ${failure.source.locator}`, failure.message);
}

// The scheduler polls at the sync interval (never slower than 15 minutes) and syncs what is due by that same setting.
const SCHEDULER_MAX_MS = 15 * 60_000;
const scheduler = new Scheduler({ run: syncAll, report: (error) => reportSyncFailure("scheduled sync", error), intervalMs: () => Math.min(SCHEDULER_MAX_MS, settings.get().syncIntervalMinutes * 60_000) });

ipcMain.handle("source:detect", (_event, input: unknown) => detectSource(boundedString(input, 4096, "IPC_INVALID_INPUT"), fetchPage));
ipcMain.handle("source:add", (_event, input: unknown) => addSource(boundedString(input, 4096, "IPC_INVALID_INPUT")));
ipcMain.handle("source:list", () => sources.list());
ipcMain.handle("source:sync", async (_event, id: unknown) => {
  const source = sources.get(boundedString(id, 64, "IPC_INVALID_ID"));
  if (!source) throw new Error("SOURCE_NOT_FOUND");
  const result = await exclusiveSync(() => syncSource(source, { fetch: fetchPage, sources, items }));
  broadcast("sources:changed");
  if (!result.ok) reportSyncFailure(`sync of ${source.locator}`, result.message);
  return result;
});
// Shares the scheduler's in-flight run, so a manual refresh never overlaps a scheduled one.
ipcMain.handle("source:syncAll", () => scheduler.tick());
ipcMain.handle("source:pause", (_event, id: unknown, paused: unknown) => {
  if (typeof paused !== "boolean") throw new Error("IPC_INVALID_FLAG");
  const result = sources.pause(boundedString(id, 64, "IPC_INVALID_ID"), paused);
  broadcast("sources:changed");
  return result;
});
ipcMain.handle("source:remove", (_event, id: unknown) => {
  sources.remove(boundedString(id, 64, "IPC_INVALID_ID"));
  broadcast("sources:changed");
});
ipcMain.handle("item:inbox", () => items.inbox());
ipcMain.handle("item:queue", () => items.queue());
ipcMain.handle("item:get", (_event, id: unknown) => items.get(boundedString(id, 64, "IPC_INVALID_ID")));
ipcMain.handle("item:read", (_event, id: unknown) => withPrefetch(readItem(boundedString(id, 64, "IPC_INVALID_ID"), {
  items, events, store,
  onMaterialized: () => { broadcast("library:changed"); broadcast("sources:changed"); },
  warn: (message) => console.warn(`[inbox] ${message}`),
})));
ipcMain.handle("item:decide", (_event, id: unknown, decision: unknown) => {
  if (!DECISIONS.includes(decision as ItemDecision)) throw new Error("IPC_INVALID_DECISION");
  const result = items.decide(boundedString(id, 64, "IPC_INVALID_ID"), decision as ItemDecision);
  if (decision === "queue" || decision === "dismiss") events.record(decision === "queue" ? "queued" : "dismissed", result.id);
  broadcast("sources:changed");
  return result;
});
ipcMain.handle("item:reorder", (_event, ids: unknown) => {
  if (!Array.isArray(ids) || ids.length > MAX_QUEUE_IDS) throw new Error("IPC_INVALID_IDS");
  items.reorder(ids.map((id) => boundedString(id, 64, "IPC_INVALID_ID")));
  broadcast("sources:changed");
});
ipcMain.handle("event:record", (_event, kind: unknown, ref: unknown) => {
  if (!EVENT_KINDS.includes(kind as ReadingEventKind)) throw new Error("IPC_INVALID_EVENT_KIND");
  const id = boundedString(ref, 64, "IPC_INVALID_ID");
  const event = events.record(kind as ReadingEventKind, id);
  if (kind === "finished" && items.markFinished(id) > 0) broadcast("sources:changed");
  return event;
});
ipcMain.handle("event:stats", () => events.stats());
ipcMain.handle("search:query", async (_event, query: unknown): Promise<SearchHit[]> => {
  const text = boundedString(query, 200, "IPC_INVALID_QUERY");
  return mergeHits(materialHits(text, await store.search(text)), itemHits(items.search(text)));
});

// --- M2: the agent. Codex app-server in the main process; the renderer sees text and events. -----
// Turns run independently of any window: every event is broadcast with its session, and a turn that
// ends while no window is focused announces itself with a system notification that opens its session.
function firstLine(text: string): string {
  return text.split("\n").map((line) => line.trim()).find((line) => line.length > 0) ?? "";
}

function focusWindow(): BrowserWindow {
  const win = BrowserWindow.getAllWindows()[0] ?? createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  return win;
}

function notifyIfUnfocused(event: AgentEvent) {
  if (event.type !== "completed" && event.type !== "failed") return;
  if (BrowserWindow.getFocusedWindow() !== null) return;
  if (!Notification.isSupported()) { console.warn("[agent] system notifications are not supported here; a turn ended unannounced"); return; }
  const title = sessions.get(event.sessionId)?.title ?? "Quire";
  const body = event.type === "completed" ? firstLine(event.text) : event.message;
  const notification = new Notification({ title, body, silent: false });
  notification.on("click", () => focusWindow().webContents.send("agent:open-session", event.sessionId));
  notification.show();
}

const codex = new CodexClient({ onDiagnostic: (message) => console.warn(`[agent] ${message}`), configuredPath: () => settings.get().codexPath });
const agent = new AgentService({
  client: codex, tools: agentTools, userData, store, sessions,
  toolHandler: createToolHandler({ store, items, annotations, onChanged: () => broadcast("library:changed"), onMaterialized: (record) => void images.prefetch(imageUrlsOf(record)) }),
  onEvent: (event) => { broadcast("agent:event", event); notifyIfUnfocused(event); },
  onSessionsChanged: () => broadcast("agent:sessions:changed"),
  onLibraryChanged: () => broadcast("library:changed"),
  onError: (context, error) => console.error(`[agent] ${context}:`, error instanceof Error ? error.message : error),
  settings: () => { const { agentModel, agentReasoningEffort } = settings.get(); return { agentModel, agentReasoningEffort }; },
  openExternal: (url) => shell.openExternal(url),
});

const AGENT_TASKS: readonly AgentTask[] = ["ask", "explain", "verify", "related", "summary", "synthesis", "rebuild"];
const MAX_AGENT_TEXT = 20_000;

function agentContext(value: unknown): AgentContext {
  const context = value as { kind?: unknown; materialId?: unknown; quote?: unknown; locator?: unknown } | undefined;
  if (context?.kind === "library") return { kind: "library" };
  if (context?.kind === "material") return { kind: "material", materialId: boundedString(context.materialId, 64, "IPC_INVALID_ID") };
  if (context?.kind === "selection") {
    return { kind: "selection", materialId: boundedString(context.materialId, 64, "IPC_INVALID_ID"), quote: boundedString(context.quote, MAX_AGENT_TEXT, "IPC_INVALID_AGENT_QUOTE"), locator: boundedString(context.locator, MAX_AGENT_TEXT, "IPC_INVALID_AGENT_LOCATOR") };
  }
  throw new Error("IPC_INVALID_AGENT_CONTEXT");
}

function agentRequest(value: unknown): AgentRequest {
  const request = value as { context?: unknown; task?: unknown; text?: unknown; threadId?: unknown; sessionId?: unknown } | undefined;
  if (!request || typeof request !== "object") throw new Error("IPC_INVALID_AGENT_REQUEST");
  if (!AGENT_TASKS.includes(request.task as AgentTask)) throw new Error("IPC_INVALID_AGENT_TASK");
  if (typeof request.text !== "string" || request.text.length > MAX_AGENT_TEXT) throw new Error("IPC_INVALID_AGENT_TEXT");
  if (request.threadId !== undefined) boundedString(request.threadId, 128, "IPC_INVALID_AGENT_THREAD");
  if (request.sessionId !== undefined) boundedString(request.sessionId, 64, "IPC_INVALID_AGENT_SESSION");
  return {
    context: agentContext(request.context), task: request.task as AgentTask, text: request.text,
    ...(typeof request.threadId === "string" ? { threadId: request.threadId } : {}),
    ...(typeof request.sessionId === "string" ? { sessionId: request.sessionId } : {}),
  };
}

ipcMain.handle("agent:status", () => agent.status());
ipcMain.handle("agent:ask", (_event, request: unknown) => agent.ask(agentRequest(request)));
ipcMain.handle("agent:interrupt", (_event, sessionId: unknown) => agent.interrupt(boundedString(sessionId, 64, "IPC_INVALID_ID")));
ipcMain.handle("agent:runs", () => agent.listRuns());
ipcMain.handle("agent:login", () => agent.login());

// --- M3: metadata, library management, settings, agent sessions. ------------------------------
registerM3Handlers({
  store, meta, annotations, items, events, settings, sessions, broadcast, withPrefetch,
  onCodexPathChanged: () => codex.stop(),
  warn: (message) => console.warn(message),
});

// One window. Native vibrancy behind a transparent page so the glass panels
// in the renderer sit on the real desktop, not on a painted gradient.
function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 980,
    minHeight: 600,
    show: false,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 20 },
    vibrancy: "under-window",
    visualEffectState: "active",
    backgroundColor: "#00000000",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.once("ready-to-show", () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(join(__dirname, "../renderer/index.html"));
  return win;
}

function installMenu() {
  const template: Electron.MenuItemConstructorOptions[] = [
    { role: "appMenu" },
    { role: "fileMenu" },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
    ...(corpusDirectory()
      ? [{
          label: "Developer",
          submenu: [{
            label: "Import Evaluation Corpus",
            accelerator: "CmdOrCtrl+Shift+I",
            click: async () => {
              try {
                const result = await importCorpus();
                const { dialog } = await import("electron");
                await dialog.showMessageBox({ message: `Imported ${result.imported}, skipped ${result.skipped} already present, ${result.failed.length} failed.`, detail: result.failed.map((f) => `${f.slug}: ${f.message}`).join("\n") });
              } catch (error) {
                const { dialog } = await import("electron");
                await dialog.showMessageBox({ type: "error", message: "Corpus import failed", detail: error instanceof Error ? error.message : String(error) });
              }
            },
          }],
        } satisfies Electron.MenuItemConstructorOptions]
      : []),
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  installMenu();
  createWindow();
  scheduler.start();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
// Runs still open become interrupted turns of their sessions before the database closes.
app.on("before-quit", () => { scheduler.stop(); agent.shutdown(); db.close(); });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
