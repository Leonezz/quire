import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type {
  AgentEvent,
  AgentSession,
  ItemRecord,
  MaterialRecord,
  MaterialViewContent,
  MediaCacheProgress,
  MediaState,
  ReadApi,
  ReadApiFeedback,
  UpdateState,
} from "../../shared/contracts";
import { startNormalizerHost } from "./normalizerHost";

declare const __QUIRE_VERSION__: string;

type FeedbackProgress = Parameters<Parameters<ReadApiFeedback["onFeedbackProgress"]>[0]>[0];

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function subscribeVoid(eventName: string, listener: () => void): () => void {
  let disposed = false;
  let unlisten: (() => void) | undefined;
  void listen(eventName, () => {
    if (!disposed) listener();
  }).then((fn) => {
    if (disposed) fn();
    else unlisten = fn;
  });
  return () => {
    disposed = true;
    unlisten?.();
  };
}

function subscribePayload<T>(eventName: string, listener: (payload: T) => void): () => void {
  let disposed = false;
  let unlisten: (() => void) | undefined;
  void listen<T>(eventName, (event) => {
    if (!disposed) listener(event.payload);
  }).then((fn) => {
    if (disposed) fn();
    else unlisten = fn;
  });
  return () => {
    disposed = true;
    unlisten?.();
  };
}

function installTitlebarDrag(): void {
  const INTERACTIVE =
    'button, [role="button"], [role="option"], [role="tab"], [role="menuitem"], input, a, select, textarea, [data-no-drag], [role="separator"]';
  document.addEventListener("mousedown", (event) => {
    if (event.button !== 0) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (!target.closest(".titlebar-drag")) return;
    if (target.closest(INTERACTIVE)) return;
    if (event.detail === 2) {
      void getCurrentWindow().toggleMaximize();
    } else {
      void getCurrentWindow().startDragging();
    }
  });
}

function installExternalLinkBridge(): void {
  window.open = ((url?: string | URL) => {
    const href = typeof url === "string" ? url : url?.toString() ?? "";
    if (/^(?:https?:|mailto:)/i.test(href)) {
      void invoke("open_external", { url: href });
    }
    return null;
  }) as typeof window.open;
}

if (isTauriRuntime() && !window.read) {
  startNormalizerHost();
  installTitlebarDrag();
  installExternalLinkBridge();

  const api: ReadApi = {
    version: typeof __QUIRE_VERSION__ === "string" ? __QUIRE_VERSION__ : "0.2.0-alpha.1",
    platform: "darwin",
    setTheme: (theme) => invoke("theme_set", { theme }),
    onLibraryChanged: (listener) => subscribeVoid("library:changed", listener),
    importCorpus: () => invoke("material_import_corpus"),
    openUrl: (url) => invoke("material_open_url", { url }),
    openFile: (input) =>
      invoke("material_open_file", {
        name: input.name,
        mediaType: input.mediaType,
        bytesBase64: toBase64(input.bytes),
      }),
    getMaterial: async (id) => (await invoke<MaterialRecord | null>("material_get", { id })) ?? undefined,
    getMaterialBytes: async (id, view) => {
      const buf = await invoke<ArrayBuffer>("material_bytes", { id, ...(view ? { view } : {}) });
      return buf.byteLength === 0 ? undefined : new Uint8Array(buf);
    },
    resolveImage: async (url) => (await invoke<string | null>("image_resolve", { url })) ?? undefined,
    listAnnotations: (materialId) => invoke("annotation_list", { materialId }),
    saveAnnotation: (annotation) => invoke("annotation_save", { annotation }),
    deleteAnnotation: (materialId, id) => invoke("annotation_delete", { materialId, id }),
    listMaterials: () => invoke("material_list"),

    // M1: sources, Inbox / Queue, reading events, search
    detectSource: (input) => invoke("source_detect", { input }),
    addSource: (input) => invoke("source_add", { input }),
    listSources: () => invoke("source_list"),
    syncSource: (id) => invoke("source_sync", { id }),
    syncAllSources: () => invoke("source_sync_all"),
    pauseSource: (id, paused) => invoke("source_pause", { id, paused }),
    removeSource: (id) => invoke("source_remove", { id }),
    onSourcesChanged: (listener) => subscribeVoid("sources:changed", listener),
    listInbox: () => invoke("item_inbox"),
    listQueue: () => invoke("item_queue"),
    getItem: async (id) => (await invoke<ItemRecord | null>("item_get", { id })) ?? undefined,
    readItem: (id) => invoke("item_read", { id }),
    decideItem: (id, decision) => invoke("item_decide", { id, decision }),
    reorderQueue: (ids) => invoke("item_reorder", { ids }),
    recordReadingEvent: (kind, ref) => invoke("event_record", { kind, reference: ref }),
    readingStats: () => invoke("event_stats"),
    search: (query) => invoke("search_query", { query }),

    // M2: Agent
    agentStatus: () => invoke("agent_status"),
    agentAsk: (request) => invoke("agent_ask", { request }),
    agentInterrupt: (sessionId) => invoke("agent_interrupt", { sessionId }),
    listAgentRuns: () => invoke("agent_runs"),
    agentLogin: () => invoke("agent_login"),
    onAgentEvent: (listener) => subscribePayload<AgentEvent>("agent:event", listener),
    onAgentStatusChanged: (listener) => subscribeVoid("agent:status:changed", listener),
    onAgentOpenSession: (listener) => subscribePayload<string>("agent:open-session", listener),

    // M3: Metadata, library management, settings, agent sessions
    queryLibrary: (filter) => invoke("library_query", { filter }),
    updateMaterialMeta: (id, patch) => invoke("material_update_meta", { id, patch }),
    refreshMetadata: (id) => invoke("material_refresh_meta", { id }),
    exportBibtex: (ids) => invoke("material_bibtex", { ids }),
    listTags: () => invoke("material_tags"),
    deleteMaterials: (ids) => invoke("material_delete", { ids }),
    keepItem: (id) => invoke("item_keep", { id }),
    getSettings: () => invoke("settings_get"),
    updateSettings: (patch) => invoke("settings_update", { patch }),
    storageUsage: () => invoke("storage_usage_get"),
    listAgentSessions: () => invoke("agent_sessions_list"),
    getAgentSession: async (id) => (await invoke<AgentSession | null>("agent_sessions_get", { id })) ?? undefined,
    deleteAgentSession: (id) => invoke("agent_sessions_delete", { id }),
    onAgentSessionsChanged: (listener) => subscribeVoid("agent:sessions:changed", listener),

    // Views & Artifact versions
    fetchMaterialView: (id, view) => invoke("material_fetch_view", { id, view }),
    getMaterialView: async (id, view) =>
      (await invoke<MaterialViewContent | null>("material_get_view", { id, view })) ?? undefined,
    getArtifactVersion: async (id, version) =>
      (await invoke<MaterialViewContent | null>("artifact_version", { id, version })) ?? undefined,
    restoreArtifactVersion: (id, version) => invoke("artifact_restore", { id, version }),
    setPrimaryView: (id, view) => invoke("material_set_primary_view", { id, view }),

    // Updates
    getUpdateState: () => invoke("update_state"),
    checkForUpdates: () => invoke("update_check"),
    installUpdate: () => invoke("update_install"),
    downloadUpdate: () => invoke("update_download"),
    openDownloadedUpdate: () => invoke("update_open_downloaded"),
    openReleasePage: () => invoke("update_open_release"),
    onUpdateState: (listener) => subscribePayload<UpdateState>("update:state", listener),

    // Rendering feedback
    feedbackSubmit: (draft) => invoke("feedback_submit", { draft }),
    onFeedbackProgress: (listener) => subscribePayload<FeedbackProgress>("feedback:progress", listener),
    feedbackCopyScreenshot: (id) => invoke("feedback_copy_screenshot", { id }),
    feedbackCreate: (draft) => invoke("feedback_create", { draft }),
    feedbackList: () => invoke("feedback_list"),
    feedbackDelete: (id) => invoke("feedback_delete", { id }),
    feedbackOpenIssue: (id) => invoke("feedback_open_issue", { id }),
    feedbackSetIssueUrl: (id, issueUrl) => invoke("feedback_set_issue_url", { id, issueUrl }),
    feedbackReveal: (id) => invoke("feedback_reveal", { id }),
    onFeedbackChanged: (listener) => subscribeVoid("feedback:changed", listener),

    // Media playback state & offline cache
    getMediaState: async (materialId) =>
      (await invoke<MediaState | null>("media_state_get", { materialId })) ?? undefined,
    saveMediaState: (mediaState) =>
      invoke("media_state_save", { mediaState: { updatedAt: "", ...mediaState } }),
    downloadMediaCache: (materialId) => invoke("media_cache_download", { materialId }),
    removeMediaCache: (materialId) => invoke("media_cache_remove", { materialId }),
    clearMediaCache: () => invoke("media_cache_clear_all"),
    onMediaCacheProgress: (listener) => subscribePayload<MediaCacheProgress>("media:cache:progress", listener),
  };

  window.read = api;
}
