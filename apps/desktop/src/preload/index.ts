import { contextBridge, ipcRenderer } from "electron";
import type { AgentEvent, ReadApi, UpdateState } from "../shared/contracts";

// The only bridge. Method names mirror the main-process handlers one to one.
// Passed by the main process through additionalArguments (see the BrowserWindow in main/index.ts).
const appVersion = process.argv.find((arg) => arg.startsWith("--quire-version="))?.slice("--quire-version=".length) ?? "unknown";

const api: ReadApi = {
  version: appVersion,
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
  getMaterialBytes: (id, view) => ipcRenderer.invoke("material:bytes", id, view),
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
  agentInterrupt: (sessionId) => ipcRenderer.invoke("agent:interrupt", sessionId),
  listAgentRuns: () => ipcRenderer.invoke("agent:runs"),
  agentLogin: () => ipcRenderer.invoke("agent:login"),
  onAgentEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: AgentEvent) => listener(payload);
    ipcRenderer.on("agent:event", handler);
    return () => ipcRenderer.removeListener("agent:event", handler);
  },
  // The agent's settings changed or a sign-in ended: re-read agentStatus().
  onAgentStatusChanged: (listener) => {
    const handler = () => listener();
    ipcRenderer.on("agent:status:changed", handler);
    return () => ipcRenderer.removeListener("agent:status:changed", handler);
  },
  // A clicked notification names the session to show.
  onAgentOpenSession: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, sessionId: string) => listener(sessionId);
    ipcRenderer.on("agent:open-session", handler);
    return () => ipcRenderer.removeListener("agent:open-session", handler);
  },
  // M3: metadata, library management, settings, agent sessions.
  queryLibrary: (filter) => ipcRenderer.invoke("library:query", filter),
  updateMaterialMeta: (id, patch) => ipcRenderer.invoke("material:updateMeta", id, patch),
  refreshMetadata: (id) => ipcRenderer.invoke("material:refreshMeta", id),
  exportBibtex: (ids) => ipcRenderer.invoke("material:bibtex", ids),
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
  // Views: one material, several renderings.
  fetchMaterialView: (id, view) => ipcRenderer.invoke("material:fetchView", id, view),
  getMaterialView: (id, view) => ipcRenderer.invoke("material:getView", id, view),
  setPrimaryView: (id, view) => ipcRenderer.invoke("material:setPrimaryView", id, view),
  // Updates: the state is pushed on every change; `current` in it is the main process's app.getVersion().
  getUpdateState: () => ipcRenderer.invoke("update:state"),
  checkForUpdates: () => ipcRenderer.invoke("update:check"),
  installUpdate: () => ipcRenderer.invoke("update:install"),
  openReleasePage: () => ipcRenderer.invoke("update:openRelease"),
  onUpdateState: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: UpdateState) => listener(state);
    ipcRenderer.on("update:state", handler);
    return () => ipcRenderer.removeListener("update:state", handler);
  },
  // Rendering feedback: local bundles; the issue is opened in the browser, the bundle revealed in Finder.
  feedbackCreate: (draft) => ipcRenderer.invoke("feedback:create", draft),
  feedbackList: () => ipcRenderer.invoke("feedback:list"),
  feedbackDelete: (id) => ipcRenderer.invoke("feedback:delete", id),
  feedbackOpenIssue: (id) => ipcRenderer.invoke("feedback:openIssue", id),
  feedbackSetIssueUrl: (id, issueUrl) => ipcRenderer.invoke("feedback:setIssueUrl", id, issueUrl),
  feedbackReveal: (id) => ipcRenderer.invoke("feedback:reveal", id),
  onFeedbackChanged: (listener) => {
    const handler = () => listener();
    ipcRenderer.on("feedback:changed", handler);
    return () => ipcRenderer.removeListener("feedback:changed", handler);
  },
};
contextBridge.exposeInMainWorld("read", api);
