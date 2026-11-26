import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type {
  AgentEvent,
  AgentSession,
  AsrModelDownloadProgress,
  ItemRecord,
  MaterialRecord,
  MaterialViewContent,
  MediaCacheProgress,
  MediaState,
  ReadApi,
  ReadApiFeedback,
  TranscribeEvent,
  UpdateState,
} from "../../shared/contracts";
import { startNormalizerHost } from "./normalizerHost";

declare const __QUIRE_VERSION__: string;

type FeedbackProgress = Parameters<Parameters<ReadApiFeedback["onFeedbackProgress"]>[0]>[0];

/** Tauri commands reject with plain strings when returning `Err(String)`; wrap them in `Error` so `cause instanceof Error` works everywhere. */
async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await (args ? invoke<T>(cmd, args) : invoke<T>(cmd));
  } catch (err: unknown) {
    if (err instanceof Error) throw err;
    throw new Error(typeof err === "string" ? err : JSON.stringify(err));
  }
}

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
    setTheme: (theme) => call("theme_set", { theme }),
    onLibraryChanged: (listener) => subscribeVoid("library:changed", listener),
    importCorpus: () => call("material_import_corpus"),
    openUrl: (url) => call("material_open_url", { url }),
    openFile: (input) =>
      call("material_open_file", {
        name: input.name,
        mediaType: input.mediaType,
        bytesBase64: toBase64(input.bytes),
      }),
    getMaterial: async (id) => (await call<MaterialRecord | null>("material_get", { id })) ?? undefined,
    getMaterialBytes: async (id, view) => {
      const buf = await call<ArrayBuffer>("material_bytes", { id, ...(view ? { view } : {}) });
      return buf.byteLength === 0 ? undefined : new Uint8Array(buf);
    },
    resolveImage: async (url) => (await call<string | null>("image_resolve", { url })) ?? undefined,
    listAnnotations: (materialId) => call("annotation_list", { materialId }),
    saveAnnotation: (annotation) => call("annotation_save", { annotation }),
    deleteAnnotation: (materialId, id) => call("annotation_delete", { materialId, id }),
    listMaterials: () => call("material_list"),

    // M1: sources, Inbox / Queue, reading events, search
    detectSource: (input) => call("source_detect", { input }),
    addSource: (input) => call("source_add", { input }),
    listSources: () => call("source_list"),
    syncSource: (id) => call("source_sync", { id }),
    syncAllSources: () => call("source_sync_all"),
    pauseSource: (id, paused) => call("source_pause", { id, paused }),
    removeSource: (id) => call("source_remove", { id }),
    onSourcesChanged: (listener) => subscribeVoid("sources:changed", listener),
    listInbox: () => call("item_inbox"),
    listQueue: () => call("item_queue"),
    getItem: async (id) => (await call<ItemRecord | null>("item_get", { id })) ?? undefined,
    readItem: (id) => call("item_read", { id }),
    decideItem: (id, decision) => call("item_decide", { id, decision }),
    reorderQueue: (ids) => call("item_reorder", { ids }),
    recordReadingEvent: (kind, ref) => call("event_record", { kind, reference: ref }),
    readingStats: () => call("event_stats"),
    search: (query) => call("search_query", { query }),

    // M2: Agent
    agentStatus: () => call("agent_status"),
    agentAsk: (request) => call("agent_ask", { request }),
    agentInterrupt: (sessionId) => call("agent_interrupt", { sessionId }),
    listAgentRuns: () => call("agent_runs"),
    agentLogin: () => call("agent_login"),
    onAgentEvent: (listener) => subscribePayload<AgentEvent>("agent:event", listener),
    onAgentStatusChanged: (listener) => subscribeVoid("agent:status:changed", listener),
    onAgentOpenSession: (listener) => subscribePayload<string>("agent:open-session", listener),

    // M3: Metadata, library management, settings, agent sessions
    queryLibrary: (filter) => call("library_query", { filter }),
    updateMaterialMeta: (id, patch) => call("material_update_meta", { id, patch }),
    refreshMetadata: (id) => call("material_refresh_meta", { id }),
    exportBibtex: (ids) => call("material_bibtex", { ids }),
    listTags: () => call("material_tags"),
    deleteMaterials: (ids) => call("material_delete", { ids }),
    keepItem: (id) => call("item_keep", { id }),
    getSettings: () => call("settings_get"),
    updateSettings: (patch) => call("settings_update", { patch }),
    storageUsage: () => call("storage_usage_get"),
    listAgentSessions: () => call("agent_sessions_list"),
    getAgentSession: async (id) => (await call<AgentSession | null>("agent_sessions_get", { id })) ?? undefined,
    deleteAgentSession: (id) => call("agent_sessions_delete", { id }),
    onAgentSessionsChanged: (listener) => subscribeVoid("agent:sessions:changed", listener),

    // Views & Artifact versions
    fetchMaterialView: (id, view) => call("material_fetch_view", { id, view }),
    getMaterialView: async (id, view) =>
      (await call<MaterialViewContent | null>("material_get_view", { id, view })) ?? undefined,
    getArtifactVersion: async (id, version) =>
      (await call<MaterialViewContent | null>("artifact_version", { id, version })) ?? undefined,
    restoreArtifactVersion: (id, version) => call("artifact_restore", { id, version }),
    setPrimaryView: (id, view) => call("material_set_primary_view", { id, view }),

    // Updates
    getUpdateState: () => call("update_state"),
    checkForUpdates: () => call("update_check"),
    installUpdate: () => call("update_install"),
    downloadUpdate: () => call("update_download"),
    openDownloadedUpdate: () => call("update_open_downloaded"),
    openReleasePage: () => call("update_open_release"),
    onUpdateState: (listener) => subscribePayload<UpdateState>("update:state", listener),

    // Rendering feedback
    feedbackSubmit: (draft) => call("feedback_submit", { draft }),
    onFeedbackProgress: (listener) => subscribePayload<FeedbackProgress>("feedback:progress", listener),
    feedbackCopyScreenshot: (id) => call("feedback_copy_screenshot", { id }),
    feedbackCreate: (draft) => call("feedback_create", { draft }),
    feedbackList: () => call("feedback_list"),
    feedbackDelete: (id) => call("feedback_delete", { id }),
    feedbackOpenIssue: (id) => call("feedback_open_issue", { id }),
    feedbackSetIssueUrl: (id, issueUrl) => call("feedback_set_issue_url", { id, issueUrl }),
    feedbackReveal: (id) => call("feedback_reveal", { id }),
    onFeedbackChanged: (listener) => subscribeVoid("feedback:changed", listener),

    // Media playback state & offline cache
    getMediaState: async (materialId) =>
      (await call<MediaState | null>("media_state_get", { materialId })) ?? undefined,
    saveMediaState: (mediaState) =>
      call("media_state_save", { mediaState: { updatedAt: "", ...mediaState } }),
    downloadMediaCache: (materialId) => call("media_cache_download", { materialId }),
    removeMediaCache: (materialId) => call("media_cache_remove", { materialId }),
    clearMediaCache: () => call("media_cache_clear_all"),
    onMediaCacheProgress: (listener) => subscribePayload<MediaCacheProgress>("media:cache:progress", listener),
    startTranscription: (materialId, provider) =>
      call("transcribe_start", { materialId, ...(provider ? { provider } : {}) }),
    cancelTranscription: (materialId) => call("transcribe_cancel", { materialId }),
    listTranscriptionJobs: () => call("transcribe_jobs"),
    onTranscribeEvent: (listener) => subscribePayload<TranscribeEvent>("transcribe:event", listener),
    asrModelStatus: () => call("asr_model_status"),
    downloadAsrModel: (model) => call("asr_model_download", { model }),
    onAsrModelProgress: (listener) => subscribePayload<AsrModelDownloadProgress>("asr:model:progress", listener),
    testAsrConnection: () => call("asr_test_connection"),
  };

  window.read = api;
}
