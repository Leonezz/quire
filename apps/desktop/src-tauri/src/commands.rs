use crate::agent::AgentService;
use crate::codex::CodexClient;
use crate::db::Db;
use crate::feedback::{copy_png_to_clipboard, issue_url_for, FeedbackStore};
use crate::http::{detect_source, MAX_BYTES};
use crate::images::ImageCache;
use crate::materials::{
    delete_materials, image_urls_of_record, is_material_view_id, query_library, search_hits,
    storage_usage, valid_hex_16, AnnotationStore, MaterialStore,
};
use crate::media::MediaCache;
use crate::normalizer_bridge::{BridgeReply, TauriNormalizerBridge};
use crate::settings::SettingsStore;
use crate::sqlite_stores::{
    EventStore, ItemStore, MediaStateStore, MetaStore, SessionStore, SourceStore,
};
use crate::sync::{add_source, keep_item, read_item, sync_source, SyncCoordinator};
use crate::transcribe::{
    check_asr_model_status, download_asr_model, test_asr_connection, TranscriptionService,
};
use crate::types::{
    AddSourceResult, AgentRequest, AgentResult, AgentRun, AgentSession, AgentSessionSummary,
    AgentStatus, Annotation, AsrConnectionTestResult, AsrModelStatus, CorpusImportResult,
    DeleteMaterialsResult, ItemRecord, LibraryFilter, MaterialRecord, MaterialSummary,
    MaterialViewContent, MediaState, OpenUrlResult, ReadingEvent, ReadingStats, RenderingFeedback,
    RenderingFeedbackDraft, SearchHit, Settings, SourceDetection, SourceRecord, StorageUsage,
    SyncSourceResult, TagCount, TranscribeJobSnapshot, UpdateState,
};
use crate::updates::UpdateService;
use base64::Engine;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State, Theme};

pub struct AppState {
    pub data_dir: PathBuf,
    pub corpus_dir: Option<PathBuf>,
    pub runtime_dirs: Vec<PathBuf>,
    pub db: Arc<Db>,
    pub http: reqwest::Client,
    pub normalizer: Arc<TauriNormalizerBridge>,
    pub settings: Arc<SettingsStore>,
    pub meta: MetaStore,
    pub store: Arc<MaterialStore>,
    pub images: ImageCache,
    pub media_cache: MediaCache,
    pub media_states: MediaStateStore,
    pub annotations: AnnotationStore,
    pub items: ItemStore,
    pub sources: SourceStore,
    pub events: EventStore,
    pub sessions: SessionStore,
    pub sync_coord: Arc<SyncCoordinator>,
    pub codex: Arc<CodexClient>,
    pub agent: Arc<AgentService>,
    pub transcribe: Arc<TranscriptionService>,
    pub updates: Arc<UpdateService>,
    pub feedback: Arc<FeedbackStore>,
}

pub fn open_external_url(url: &str) -> Result<(), String> {
    if !url.starts_with("https://") && !url.starts_with("http://") && !url.starts_with("mailto:") {
        return Err("Refusing to open non-web URL.".into());
    }
    let status = std::process::Command::new("/usr/bin/open")
        .arg(url)
        .status()
        .map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("Could not open {url}"))
    }
}

pub fn open_local_path(path: &str) -> Result<(), String> {
    let status = std::process::Command::new("/usr/bin/open")
        .arg(path)
        .status()
        .map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("Could not open {path}"))
    }
}

pub fn reveal_in_finder(path: &Path) -> Result<(), String> {
    let status = std::process::Command::new("/usr/bin/open")
        .arg("-R")
        .arg(path)
        .status()
        .map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("Could not reveal {}", path.display()))
    }
}

fn bounded_str(val: &str, max: usize, code: &str) -> Result<String, String> {
    if val.is_empty() || val.chars().count() > max {
        Err(code.into())
    } else {
        Ok(val.to_string())
    }
}

fn spawn_prefetch(images: &ImageCache, result: &OpenUrlResult) {
    if let OpenUrlResult::Ok { material, .. } = result {
        let urls = image_urls_of_record(material);
        if !urls.is_empty() {
            let cache = images.clone();
            tauri::async_runtime::spawn(async move {
                let _ = cache.prefetch(urls, 3).await;
            });
        }
    }
}

pub async fn run_import_corpus(app: &AppHandle, state: &AppState) -> Result<CorpusImportResult, String> {
    let dir = state
        .corpus_dir
        .as_ref()
        .ok_or_else(|| "No evaluation corpus next to this build (expected <repo>/eval/corpus).".to_string())?;
    let res = state.store.import_snapshots(dir).await?;
    let _ = app.emit("library:changed", ());
    if let Ok(all) = state.store.list() {
        let mut urls = Vec::new();
        for item in all {
            if let Ok(Some(rec)) = state.store.get(&item.id) {
                urls.extend(image_urls_of_record(&rec));
            }
        }
        if !urls.is_empty() {
            let cache = state.images.clone();
            tauri::async_runtime::spawn(async move {
                let _ = cache.prefetch(urls, 2).await;
            });
        }
    }
    Ok(res)
}

#[tauri::command]
pub fn normalizer_reply(state: State<'_, AppState>, reply: BridgeReply) -> Result<(), String> {
    state.normalizer.complete(reply);
    Ok(())
}

#[tauri::command]
pub fn open_external(url: String) -> Result<(), String> {
    open_external_url(&url)
}

#[tauri::command]
pub fn theme_set(app: AppHandle, theme: String) -> Result<(), String> {
    let target = match theme.as_str() {
        "system" => None,
        "light" => Some(Theme::Light),
        "dark" => Some(Theme::Dark),
        _ => return Err("IPC_INVALID_THEME".into()),
    };
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.set_theme(target);
    }
    Ok(())
}

#[tauri::command]
pub async fn material_import_corpus(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<CorpusImportResult, String> {
    run_import_corpus(&app, &state).await
}

#[tauri::command]
pub async fn material_open_url(
    state: State<'_, AppState>,
    url: String,
) -> Result<OpenUrlResult, String> {
    let u = bounded_str(&url, 4096, "IPC_INVALID_URL")?;
    let res = state.store.open_url(&u, "web", None).await;
    spawn_prefetch(&state.images, &res);
    Ok(res)
}

#[tauri::command]
pub async fn material_open_file(
    state: State<'_, AppState>,
    name: String,
    media_type: String,
    bytes_base64: String,
) -> Result<OpenUrlResult, String> {
    let clean_name = bounded_str(&name, 255, "IPC_INVALID_FILE_NAME")?;
    let clean_type: String = media_type.chars().take(100).collect();
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(bytes_base64)
        .map_err(|_| "IPC_INVALID_FILE_BYTES".to_string())?;
    if bytes.is_empty() || bytes.len() > MAX_BYTES {
        return Err("IPC_INVALID_FILE_BYTES".into());
    }
    let res = state.store.open_file(&clean_name, &clean_type, &bytes).await;
    spawn_prefetch(&state.images, &res);
    Ok(res)
}

#[tauri::command]
pub fn material_get(
    state: State<'_, AppState>,
    id: String,
) -> Result<Option<MaterialRecord>, String> {
    let cid = bounded_str(&id, 64, "IPC_INVALID_ID")?;
    state.store.get(&cid)
}

#[tauri::command]
pub fn material_bytes(
    state: State<'_, AppState>,
    id: String,
    view: Option<String>,
) -> Result<tauri::ipc::Response, String> {
    let cid = bounded_str(&id, 64, "IPC_INVALID_ID")?;
    if let Some(ref v) = view {
        if !is_material_view_id(v) {
            return Err("IPC_INVALID_VIEW".into());
        }
    }
    let bytes = state.store.bytes(&cid, view.as_deref())?.unwrap_or_default();
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub async fn image_resolve(
    state: State<'_, AppState>,
    url: String,
) -> Result<Option<String>, String> {
    let u = bounded_str(&url, 4096, "IPC_INVALID_URL")?;
    Ok(state.images.resolve(&u).await)
}

#[tauri::command]
pub fn annotation_list(
    state: State<'_, AppState>,
    material_id: String,
) -> Result<Vec<Annotation>, String> {
    let mid = bounded_str(&material_id, 64, "IPC_INVALID_ID")?;
    state.annotations.list(&mid)
}

#[tauri::command]
pub fn annotation_save(
    state: State<'_, AppState>,
    annotation: Annotation,
) -> Result<Annotation, String> {
    if !matches!(annotation.kind.as_str(), "highlight" | "underline" | "comment") {
        return Err("IPC_INVALID_ANNOTATION".into());
    }
    if !matches!(
        annotation.color.as_str(),
        "#ffd400" | "#5fb236" | "#2ea8e5" | "#e56eee"
    ) {
        return Err("IPC_INVALID_ANNOTATION".into());
    }
    state.annotations.save(annotation)
}

#[tauri::command]
pub fn annotation_delete(
    state: State<'_, AppState>,
    material_id: String,
    id: String,
) -> Result<(), String> {
    let mid = bounded_str(&material_id, 64, "IPC_INVALID_ID")?;
    let aid = bounded_str(&id, 64, "IPC_INVALID_ID")?;
    state.annotations.delete(&mid, &aid)
}

#[tauri::command]
pub fn material_list(state: State<'_, AppState>) -> Result<Vec<MaterialSummary>, String> {
    state.store.list()
}

#[tauri::command]
pub async fn source_detect(
    state: State<'_, AppState>,
    input: String,
) -> Result<SourceDetection, String> {
    let text = bounded_str(&input, 4096, "IPC_INVALID_INPUT")?;
    detect_source(&state.http, &text)
        .await
        .map_err(|e| e.message)
}

#[tauri::command]
pub async fn source_add(
    app: AppHandle,
    state: State<'_, AppState>,
    input: String,
) -> Result<AddSourceResult, String> {
    let text = bounded_str(&input, 4096, "IPC_INVALID_INPUT")?;
    let app_c = app.clone();
    Ok(add_source(
        &text,
        &state.http,
        state.normalizer.as_ref(),
        &state.sources,
        &state.items,
        &move || {
            let _ = app_c.emit("sources:changed", ());
        },
    )
    .await)
}

#[tauri::command]
pub fn source_list(state: State<'_, AppState>) -> Result<Vec<SourceRecord>, String> {
    state.sources.list()
}

#[tauri::command]
pub async fn source_sync(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<SyncSourceResult, String> {
    let sid = bounded_str(&id, 64, "IPC_INVALID_ID")?;
    let src = state
        .sources
        .get(&sid)?
        .ok_or_else(|| "SOURCE_NOT_FOUND".to_string())?;
    let http = state.http.clone();
    let norm = state.normalizer.clone();
    let sources = state.sources.clone();
    let items = state.items.clone();
    let res = state
        .sync_coord
        .exclusive(async move { sync_source(&src, &http, norm.as_ref(), &sources, &items).await })
        .await;
    let _ = app.emit("sources:changed", ());
    Ok(res)
}

#[tauri::command]
pub async fn source_sync_all(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let http = state.http.clone();
    let norm = state.normalizer.clone();
    let sources = state.sources.clone();
    let items = state.items.clone();
    let interval = state.settings.get().sync_interval_minutes;
    let app_c = app.clone();
    state
        .sync_coord
        .tick(|| async move {
            let _ = crate::sync::sync_due(&http, norm, &sources, &items, interval, &move || {
                let _ = app_c.emit("sources:changed", ());
            })
            .await;
        })
        .await;
    Ok(())
}

#[tauri::command]
pub fn source_pause(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    paused: bool,
) -> Result<SourceRecord, String> {
    let sid = bounded_str(&id, 64, "IPC_INVALID_ID")?;
    let updated = state.sources.pause(&sid, paused)?;
    let _ = app.emit("sources:changed", ());
    Ok(updated)
}

#[tauri::command]
pub fn source_remove(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    let sid = bounded_str(&id, 64, "IPC_INVALID_ID")?;
    state.sources.remove(&sid, &state.items)?;
    let _ = app.emit("sources:changed", ());
    Ok(())
}

#[tauri::command]
pub fn item_inbox(state: State<'_, AppState>) -> Result<Vec<ItemRecord>, String> {
    state.items.inbox()
}

#[tauri::command]
pub fn item_queue(state: State<'_, AppState>) -> Result<Vec<ItemRecord>, String> {
    state.items.queue()
}

#[tauri::command]
pub fn item_get(state: State<'_, AppState>, id: String) -> Result<Option<ItemRecord>, String> {
    let iid = bounded_str(&id, 64, "IPC_INVALID_ID")?;
    state.items.get(&iid)
}

#[tauri::command]
pub async fn item_read(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<OpenUrlResult, String> {
    let iid = bounded_str(&id, 64, "IPC_INVALID_ID")?;
    let app_c = app.clone();
    let res = read_item(&iid, &state.items, &state.events, &state.store, &move || {
        let _ = app_c.emit("library:changed", ());
        let _ = app_c.emit("sources:changed", ());
    })
    .await;
    spawn_prefetch(&state.images, &res);
    Ok(res)
}

#[tauri::command]
pub async fn item_keep(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<OpenUrlResult, String> {
    let iid = bounded_str(&id, 64, "IPC_INVALID_ID")?;
    let app_c = app.clone();
    let res = keep_item(&iid, &state.items, &state.events, &state.store, &move || {
        let _ = app_c.emit("library:changed", ());
    })
    .await;
    if matches!(res, OpenUrlResult::Ok { .. }) {
        let _ = app.emit("sources:changed", ());
    }
    spawn_prefetch(&state.images, &res);
    Ok(res)
}

#[tauri::command]
pub fn item_decide(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    decision: String,
) -> Result<ItemRecord, String> {
    let iid = bounded_str(&id, 64, "IPC_INVALID_ID")?;
    let item = state.items.decide(&iid, &decision)?;
    if decision == "queue" || decision == "dismiss" {
        let kind = if decision == "queue" { "queued" } else { "dismissed" };
        let _ = state.events.record(kind, &item.id);
    }
    let _ = app.emit("sources:changed", ());
    Ok(item)
}

#[tauri::command]
pub fn item_reorder(
    app: AppHandle,
    state: State<'_, AppState>,
    ids: Vec<String>,
) -> Result<(), String> {
    if ids.len() > 5000 {
        return Err("IPC_INVALID_IDS".into());
    }
    state.items.reorder(&ids)?;
    let _ = app.emit("sources:changed", ());
    Ok(())
}

#[tauri::command]
pub fn event_record(
    app: AppHandle,
    state: State<'_, AppState>,
    kind: String,
    reference: String,
) -> Result<ReadingEvent, String> {
    if !matches!(kind.as_str(), "opened" | "finished" | "kept" | "queued" | "dismissed") {
        return Err("IPC_INVALID_EVENT_KIND".into());
    }
    let rid = bounded_str(&reference, 64, "IPC_INVALID_ID")?;
    let ev = state.events.record(&kind, &rid)?;
    if kind == "finished" {
        if state.items.mark_finished(&rid).unwrap_or(0) > 0 {
            let _ = app.emit("sources:changed", ());
        }
        if state.settings.get().remove_cached_media_after_finish && valid_hex_16(&rid) {
            if state.media_cache.remove(&rid).unwrap_or(0) > 0 {
                let _ = app.emit("library:changed", ());
            }
        }
    }
    Ok(ev)
}

#[tauri::command]
pub fn event_stats(state: State<'_, AppState>) -> Result<ReadingStats, String> {
    state.events.stats()
}

#[tauri::command]
pub fn search_query(state: State<'_, AppState>, query: String) -> Result<Vec<SearchHit>, String> {
    let q = bounded_str(&query, 200, "IPC_INVALID_QUERY")?;
    let mats = state.store.search(&q)?;
    let its = state.items.search(&q)?;
    Ok(search_hits(&q, &mats, &its))
}

#[tauri::command]
pub async fn agent_status(state: State<'_, AppState>) -> Result<AgentStatus, String> {
    Ok(state.agent.status().await)
}

#[tauri::command]
pub async fn agent_ask(
    state: State<'_, AppState>,
    request: AgentRequest,
) -> Result<AgentResult, String> {
    if !matches!(
        request.task.as_str(),
        "ask"
            | "explain"
            | "verify"
            | "related"
            | "summary"
            | "synthesis"
            | "rebuild"
            | "cleanup_transcript"
    ) {
        return Err("IPC_INVALID_AGENT_TASK".into());
    }
    if request.text.chars().count() > 20_000 {
        return Err("IPC_INVALID_AGENT_TEXT".into());
    }
    Ok(state.agent.ask(request).await)
}

#[tauri::command]
pub async fn agent_interrupt(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    let sid = bounded_str(&session_id, 64, "IPC_INVALID_ID")?;
    state.agent.interrupt(&sid).await;
    Ok(())
}

#[tauri::command]
pub fn agent_runs(state: State<'_, AppState>) -> Result<Vec<AgentRun>, String> {
    Ok(state.agent.list_runs())
}

#[tauri::command]
pub async fn agent_login(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<AgentStatus, String> {
    let st = state.agent.login().await;
    let _ = app.emit("agent:status:changed", ());
    Ok(st)
}

#[tauri::command]
pub fn library_query(
    state: State<'_, AppState>,
    filter: Option<LibraryFilter>,
) -> Result<Vec<MaterialSummary>, String> {
    let list = state.store.list()?;
    Ok(query_library(list, &filter.unwrap_or_default()))
}

#[tauri::command]
pub fn material_update_meta(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    patch: serde_json::Map<String, serde_json::Value>,
) -> Result<MaterialRecord, String> {
    if !valid_hex_16(&id) {
        return Err("IPC_INVALID_ID".into());
    }
    if !state.store.has(&id) {
        return Err("MATERIAL_NOT_FOUND".into());
    }
    let store_ref = state.store.clone();
    state.meta.update(&id, &patch, |cand| store_ref.has(cand))?;
    let updated = state
        .store
        .get(&id)?
        .ok_or_else(|| "MATERIAL_NOT_FOUND".to_string())?;
    let _ = app.emit("library:changed", ());
    Ok(updated)
}

#[tauri::command]
pub async fn material_refresh_meta(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<MaterialRecord, String> {
    if !valid_hex_16(&id) {
        return Err("IPC_INVALID_ID".into());
    }
    let refreshed = state.store.refresh_metadata(&id).await?;
    let _ = app.emit("library:changed", ());
    Ok(refreshed)
}

#[tauri::command]
pub fn material_bibtex(state: State<'_, AppState>, ids: Vec<String>) -> Result<String, String> {
    if ids.is_empty() || ids.len() > 500 || ids.iter().any(|id| !valid_hex_16(id)) {
        return Err("IPC_INVALID_IDS".into());
    }
    state.store.export_bibtex(&ids)
}

#[tauri::command]
pub fn material_tags(state: State<'_, AppState>) -> Result<Vec<TagCount>, String> {
    state.meta.tags()
}

#[tauri::command]
pub async fn material_delete(
    app: AppHandle,
    state: State<'_, AppState>,
    ids: Vec<String>,
) -> Result<DeleteMaterialsResult, String> {
    if ids.is_empty() || ids.len() > 5000 || ids.iter().any(|id| !valid_hex_16(id)) {
        return Err("IPC_INVALID_IDS".into());
    }
    let res = delete_materials(&ids, &state.store, &state.annotations, &state.items, &state.images).await;
    for id in &ids {
        let _ = state.media_states.remove(id);
    }
    let _ = app.emit("library:changed", ());
    let (_, unlinked, out) = res?;
    if unlinked > 0 {
        let _ = app.emit("sources:changed", ());
    }
    Ok(out)
}

#[tauri::command]
pub fn settings_get(state: State<'_, AppState>) -> Result<Settings, String> {
    Ok(state.settings.get())
}

#[tauri::command]
pub fn settings_update(
    app: AppHandle,
    state: State<'_, AppState>,
    patch: serde_json::Map<String, serde_json::Value>,
) -> Result<Settings, String> {
    let before = state.settings.get();
    let after = state.settings.update(&patch)?;
    if before.codex_path != after.codex_path {
        state.codex.stop();
    }
    if before.codex_path != after.codex_path
        || before.agent_model != after.agent_model
        || before.agent_reasoning_effort != after.agent_reasoning_effort
    {
        let _ = app.emit("agent:status:changed", ());
    }
    Ok(after)
}

#[tauri::command]
pub fn storage_usage_get(state: State<'_, AppState>) -> Result<StorageUsage, String> {
    Ok(storage_usage(&state.data_dir))
}

#[tauri::command]
pub fn media_state_get(
    state: State<'_, AppState>,
    material_id: String,
) -> Result<Option<MediaState>, String> {
    if !valid_hex_16(&material_id) {
        return Err("IPC_INVALID_ID".into());
    }
    state.media_states.get(&material_id)
}

#[tauri::command]
pub fn media_state_save(
    state: State<'_, AppState>,
    media_state: MediaState,
) -> Result<(), String> {
    if !valid_hex_16(&media_state.material_id) {
        return Err("IPC_INVALID_ID".into());
    }
    if !media_state.position_sec.is_finite() || !media_state.playback_speed.is_finite() {
        return Err("IPC_INVALID_MEDIA_STATE".into());
    }
    state.media_states.save(media_state)?;
    Ok(())
}

#[tauri::command]
pub async fn media_cache_download(
    app: AppHandle,
    state: State<'_, AppState>,
    material_id: String,
) -> Result<MaterialRecord, String> {
    if !valid_hex_16(&material_id) {
        return Err("IPC_INVALID_ID".into());
    }
    let record = state
        .store
        .read_stored(&material_id)?
        .ok_or_else(|| "MATERIAL_NOT_FOUND".to_string())?;
    let media = record
        .media
        .ok_or_else(|| "This material has no audio or video stream.".to_string())?;
    let app_ev = app.clone();
    state
        .media_cache
        .download(&material_id, &media.stream_url, |prog| {
            let _ = app_ev.emit("media:cache:progress", &prog);
        })
        .await?;
    let updated = state
        .store
        .get(&material_id)?
        .ok_or_else(|| "MATERIAL_NOT_FOUND".to_string())?;
    let _ = app.emit("library:changed", ());
    Ok(updated)
}

#[tauri::command]
pub fn media_cache_remove(
    app: AppHandle,
    state: State<'_, AppState>,
    material_id: String,
) -> Result<MaterialRecord, String> {
    if !valid_hex_16(&material_id) {
        return Err("IPC_INVALID_ID".into());
    }
    state.media_cache.remove(&material_id)?;
    let updated = state
        .store
        .get(&material_id)?
        .ok_or_else(|| "MATERIAL_NOT_FOUND".to_string())?;
    let _ = app.emit("library:changed", ());
    Ok(updated)
}

#[tauri::command]
pub fn media_cache_clear_all(app: AppHandle, state: State<'_, AppState>) -> Result<u64, String> {
    let freed = state.media_cache.clear_all()?;
    let _ = app.emit("library:changed", ());
    Ok(freed)
}

#[tauri::command]
pub fn transcribe_start(
    state: State<'_, AppState>,
    material_id: String,
    provider: Option<String>,
) -> Result<TranscribeJobSnapshot, String> {
    if !valid_hex_16(&material_id) {
        return Err("IPC_INVALID_ID".into());
    }
    state.transcribe.start(&material_id, provider)
}

#[tauri::command]
pub fn transcribe_cancel(state: State<'_, AppState>, material_id: String) -> Result<(), String> {
    if !valid_hex_16(&material_id) {
        return Err("IPC_INVALID_ID".into());
    }
    state.transcribe.cancel(&material_id);
    Ok(())
}

#[tauri::command]
pub fn transcribe_jobs(state: State<'_, AppState>) -> Result<Vec<TranscribeJobSnapshot>, String> {
    Ok(state.transcribe.list_jobs())
}

#[tauri::command]
pub fn asr_model_status(state: State<'_, AppState>) -> Result<AsrModelStatus, String> {
    let cur = state.settings.get();
    Ok(check_asr_model_status(&state.data_dir, &cur.local_whisper_model))
}

#[tauri::command]
pub async fn asr_model_download(
    app: AppHandle,
    state: State<'_, AppState>,
    model: String,
) -> Result<AsrModelStatus, String> {
    let m = bounded_str(&model, 32, "IPC_INVALID_MODEL")?;
    let app_ev = app.clone();
    download_asr_model(&state.data_dir, &m, move |progress| {
        let _ = app_ev.emit("asr:model:progress", &progress);
    })
    .await
}

#[tauri::command]
pub async fn asr_test_connection(state: State<'_, AppState>) -> Result<AsrConnectionTestResult, String> {
    test_asr_connection(&state.settings).await
}

#[tauri::command]
pub fn agent_sessions_list(state: State<'_, AppState>) -> Result<Vec<AgentSessionSummary>, String> {
    state.sessions.list()
}

#[tauri::command]
pub fn agent_sessions_get(
    state: State<'_, AppState>,
    id: String,
) -> Result<Option<AgentSession>, String> {
    let sid = bounded_str(&id, 64, "IPC_INVALID_ID")?;
    state.sessions.get(&sid)
}

#[tauri::command]
pub fn agent_sessions_delete(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    let sid = bounded_str(&id, 64, "IPC_INVALID_ID")?;
    state.sessions.delete(&sid)?;
    let _ = app.emit("agent:sessions:changed", ());
    Ok(())
}

#[tauri::command]
pub async fn material_fetch_view(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    view: String,
) -> Result<OpenUrlResult, String> {
    if !valid_hex_16(&id) {
        return Err("IPC_INVALID_ID".into());
    }
    if !is_material_view_id(&view) {
        return Err("IPC_INVALID_VIEW".into());
    }
    let res = state.store.fetch_view(&id, &view).await;
    let _ = app.emit("library:changed", ());
    Ok(res)
}

#[tauri::command]
pub fn material_get_view(
    state: State<'_, AppState>,
    id: String,
    view: String,
) -> Result<Option<MaterialViewContent>, String> {
    if !valid_hex_16(&id) {
        return Err("IPC_INVALID_ID".into());
    }
    if !is_material_view_id(&view) {
        return Err("IPC_INVALID_VIEW".into());
    }
    state.store.get_view(&id, &view)
}

#[tauri::command]
pub async fn artifact_version(
    state: State<'_, AppState>,
    id: String,
    version: u32,
) -> Result<Option<MaterialViewContent>, String> {
    if !valid_hex_16(&id) {
        return Err("IPC_INVALID_ID".into());
    }
    if version < 1 {
        return Err("Invalid artifact version.".into());
    }
    state.store.artifact_version_content(&id, version).await
}

#[tauri::command]
pub async fn artifact_restore(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    version: u32,
) -> Result<MaterialRecord, String> {
    if !valid_hex_16(&id) {
        return Err("IPC_INVALID_ID".into());
    }
    if version < 1 {
        return Err("Invalid artifact version.".into());
    }
    let updated = state.store.restore_artifact(&id, version).await?;
    let _ = app.emit("library:changed", ());
    Ok(updated)
}

#[tauri::command]
pub fn material_set_primary_view(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    view: String,
) -> Result<MaterialRecord, String> {
    if !valid_hex_16(&id) {
        return Err("IPC_INVALID_ID".into());
    }
    if !is_material_view_id(&view) {
        return Err("IPC_INVALID_VIEW".into());
    }
    let updated = state.store.set_primary_view(&id, &view)?;
    let _ = app.emit("library:changed", ());
    Ok(updated)
}

#[tauri::command]
pub fn update_state(state: State<'_, AppState>) -> Result<UpdateState, String> {
    Ok(state.updates.get_state())
}

#[tauri::command]
pub async fn update_check(state: State<'_, AppState>) -> Result<UpdateState, String> {
    Ok(state.updates.check().await)
}

#[tauri::command]
pub async fn update_install(state: State<'_, AppState>) -> Result<(), String> {
    state.updates.install().await
}

#[tauri::command]
pub async fn update_download(state: State<'_, AppState>) -> Result<(), String> {
    state.updates.download().await
}

#[tauri::command]
pub fn update_open_downloaded(state: State<'_, AppState>) -> Result<(), String> {
    state.updates.open_downloaded()
}

#[tauri::command]
pub fn update_open_release(state: State<'_, AppState>) -> Result<(), String> {
    state.updates.open_release_page()
}

#[tauri::command]
pub async fn feedback_submit(
    app: AppHandle,
    state: State<'_, AppState>,
    draft: RenderingFeedbackDraft,
) -> Result<RenderingFeedback, String> {
    let app_p = app.clone();
    let res = state
        .feedback
        .submit(
            &draft,
            "Leonezz",
            "quire",
            &move |prog| {
                let _ = app_p.emit("feedback:progress", prog);
            },
            &open_external_url,
            &reveal_in_finder,
        )
        .await;
    let _ = app.emit("feedback:changed", ());
    res
}

#[tauri::command]
pub fn feedback_copy_screenshot(state: State<'_, AppState>, id: String) -> Result<(), String> {
    if !valid_hex_16(&id) {
        return Err("IPC_INVALID_ID".into());
    }
    let rec = state
        .feedback
        .get(&id)?
        .ok_or_else(|| format!("Feedback {id} does not exist."))?;
    let comp = rec
        .package
        .as_ref()
        .and_then(|p| p.composite.as_ref())
        .ok_or_else(|| "This report has no side-by-side screenshot to copy.".to_string())?;
    copy_png_to_clipboard(&Path::new(&rec.bundle_dir).join(comp))
}

#[tauri::command]
pub fn feedback_create(
    app: AppHandle,
    state: State<'_, AppState>,
    draft: RenderingFeedbackDraft,
) -> Result<RenderingFeedback, String> {
    let rec = state.feedback.create(&draft)?;
    let _ = app.emit("feedback:changed", ());
    Ok(rec)
}

#[tauri::command]
pub fn feedback_list(state: State<'_, AppState>) -> Result<Vec<RenderingFeedback>, String> {
    state.feedback.list()
}

#[tauri::command]
pub fn feedback_delete(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    if !valid_hex_16(&id) {
        return Err("IPC_INVALID_ID".into());
    }
    state.feedback.delete(&id)?;
    let _ = app.emit("feedback:changed", ());
    Ok(())
}

#[tauri::command]
pub fn feedback_open_issue(state: State<'_, AppState>, id: String) -> Result<(), String> {
    if !valid_hex_16(&id) {
        return Err("IPC_INVALID_ID".into());
    }
    let rec = state
        .feedback
        .get(&id)?
        .ok_or_else(|| format!("Feedback {id} does not exist."))?;
    open_external_url(&issue_url_for(&rec, "Leonezz", "quire"))
}

#[tauri::command]
pub fn feedback_set_issue_url(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    issue_url: String,
) -> Result<RenderingFeedback, String> {
    if !valid_hex_16(&id) {
        return Err("IPC_INVALID_ID".into());
    }
    let rec = state.feedback.set_issue_url(&id, &issue_url)?;
    let _ = app.emit("feedback:changed", ());
    Ok(rec)
}

#[tauri::command]
pub fn feedback_reveal(state: State<'_, AppState>, id: String) -> Result<(), String> {
    if !valid_hex_16(&id) {
        return Err("IPC_INVALID_ID".into());
    }
    if state.feedback.get(&id)?.is_none() {
        return Err(format!("Feedback {id} does not exist."));
    }
    reveal_in_finder(&state.feedback.bundle_dir(&id)?)
}
