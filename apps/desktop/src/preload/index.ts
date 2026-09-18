import { contextBridge, ipcRenderer } from "electron";
import type { AgentEvent, ReadApi } from "../shared/contracts";

// The only bridge. Method names mirror the main-process handlers one to one.
const api: ReadApi = {
  version: "0.0.1",
  platform: process.platform,
  setTheme: (theme) => ipcRenderer.invoke("theme:set", theme),
  onLibraryChanged: (listener) => {
    const handler = () => listener();
    ipcRenderer.on("library:changed", handler);
    return () => ipcRenderer.removeListener("library:changed", handler);
  },
  importCorpus: () => ipcRenderer.invoke("material:importCorpus"),
  openUrl: (url) => ipcRenderer.invoke("material:openUrl", url),
  openFile: (input) => ipcRenderer.invoke("material:openFile", input),
  getMaterial: (id) => ipcRenderer.invoke("material:get", id),
  getMaterialBytes: (id) => ipcRenderer.invoke("material:bytes", id),
  resolveImage: (url) => ipcRenderer.invoke("image:resolve", url),
  listAnnotations: (materialId) => ipcRenderer.invoke("annotation:list", materialId),
  saveAnnotation: (annotation) => ipcRenderer.invoke("annotation:save", annotation),
  deleteAnnotation: (materialId, id) => ipcRenderer.invoke("annotation:delete", materialId, id),
  listMaterials: () => ipcRenderer.invoke("material:list"),
  // M1: sources, Inbox / Queue, reading events, search.
  detectSource: (input) => ipcRenderer.invoke("source:detect", input),
  addSource: (input) => ipcRenderer.invoke("source:add", input),
  listSources: () => ipcRenderer.invoke("source:list"),
  syncSource: (id) => ipcRenderer.invoke("source:sync", id),
  syncAllSources: () => ipcRenderer.invoke("source:syncAll"),
  pauseSource: (id, paused) => ipcRenderer.invoke("source:pause", id, paused),
  removeSource: (id) => ipcRenderer.invoke("source:remove", id),
  onSourcesChanged: (listener) => {
    const handler = () => listener();
    ipcRenderer.on("sources:changed", handler);
    return () => ipcRenderer.removeListener("sources:changed", handler);
  },
  listInbox: () => ipcRenderer.invoke("item:inbox"),
  listQueue: () => ipcRenderer.invoke("item:queue"),
  getItem: (id) => ipcRenderer.invoke("item:get", id),
  readItem: (id) => ipcRenderer.invoke("item:read", id),
  decideItem: (id, decision) => ipcRenderer.invoke("item:decide", id, decision),
  reorderQueue: (ids) => ipcRenderer.invoke("item:reorder", ids),
  recordReadingEvent: (kind, ref) => ipcRenderer.invoke("event:record", kind, ref),
  readingStats: () => ipcRenderer.invoke("event:stats"),
  search: (query) => ipcRenderer.invoke("search:query", query),
  // M2: the agent. Events stream on agent:event; the listener receives the event object as sent.
  agentStatus: () => ipcRenderer.invoke("agent:status"),
  agentAsk: (request) => ipcRenderer.invoke("agent:ask", request),
  agentInterrupt: () => ipcRenderer.invoke("agent:interrupt"),
  agentLogin: () => ipcRenderer.invoke("agent:login"),
  onAgentEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: AgentEvent) => listener(payload);
    ipcRenderer.on("agent:event", handler);
    return () => ipcRenderer.removeListener("agent:event", handler);
  },
  // M3: metadata, library management, settings, agent sessions.
  queryLibrary: (filter) => ipcRenderer.invoke("library:query", filter),
  updateMaterialMeta: (id, patch) => ipcRenderer.invoke("material:updateMeta", id, patch),
  listTags: () => ipcRenderer.invoke("material:tags"),
  deleteMaterials: (ids) => ipcRenderer.invoke("material:delete", ids),
  keepItem: (id) => ipcRenderer.invoke("item:keep", id),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  updateSettings: (patch) => ipcRenderer.invoke("settings:update", patch),
  listAgentSessions: () => ipcRenderer.invoke("agent:sessions:list"),
  getAgentSession: (id) => ipcRenderer.invoke("agent:sessions:get", id),
  deleteAgentSession: (id) => ipcRenderer.invoke("agent:sessions:delete", id),
  onAgentSessionsChanged: (listener) => {
    const handler = () => listener();
    ipcRenderer.on("agent:sessions:changed", handler);
    return () => ipcRenderer.removeListener("agent:sessions:changed", handler);
  },
};
contextBridge.exposeInMainWorld("read", api);
