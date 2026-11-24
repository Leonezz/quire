pub mod agent;
pub mod codex;
pub mod commands;
pub mod db;
pub mod feedback;
pub mod http;
pub mod images;
pub mod materials;
pub mod normalizer_bridge;
pub mod protocols;
pub mod settings;
pub mod sqlite_stores;
pub mod sync;
pub mod types;
pub mod updates;

use agent::AgentService;
use codex::CodexClient;
use commands::{open_external_url, open_local_path, run_import_corpus, AppState};
use db::{Db, DATABASE_FILE};
use feedback::FeedbackStore;
use http::build_http_client;
use images::ImageCache;
use materials::{AnnotationStore, MaterialStore};
use normalizer_bridge::TauriNormalizerBridge;
use protocols::{artifact_protocol_response, image_protocol_response};
use settings::{KeychainAesEncryptor, SettingsStore};
use sqlite_stores::{EventStore, ItemStore, MetaStore, SessionStore, SourceStore};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use sync::SyncCoordinator;
use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::window::{Effect, EffectState, EffectsBuilder};
use tauri::{Emitter, Manager, RunEvent};
use types::{AgentEvent, FeedbackAppInfo, ARTIFACT_SCHEME, IMAGE_SCHEME};
use updates::UpdateService;

fn default_data_dir(home: &str) -> PathBuf {
    if let Ok(custom) = std::env::var("QUIRE_DATA_DIR") {
        if !custom.trim().is_empty() {
            return PathBuf::from(custom);
        }
    }
    #[cfg(target_os = "macos")]
    {
        Path::new(home).join("Library/Application Support/Quire")
    }
    #[cfg(not(target_os = "macos"))]
    {
        Path::new(home).join(".local/share/Quire")
    }
}

fn current_arch() -> &'static str {
    match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        other => other,
    }
}

fn current_platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    }
}

fn notify_if_unfocused(app: &tauri::AppHandle, sessions: &SessionStore, event: &AgentEvent) {
    let (session_id, body) = match event {
        AgentEvent::Completed { session_id, text, .. } => {
            let first = text
                .lines()
                .map(str::trim)
                .find(|l| !l.is_empty())
                .unwrap_or("")
                .to_string();
            (session_id.as_str(), first)
        }
        AgentEvent::Failed { session_id, message, .. } => (session_id.as_str(), message.clone()),
        _ => return,
    };

    if let Some(win) = app.get_webview_window("main") {
        if win.is_focused().unwrap_or(false) {
            return;
        }
    }

    let title = sessions
        .get(session_id)
        .ok()
        .flatten()
        .map(|s| s.title)
        .unwrap_or_else(|| "Quire".into());

    #[cfg(target_os = "macos")]
    {
        let script = format!(
            "display notification {:?} with title {:?}",
            body.chars().take(200).collect::<String>(),
            title.chars().take(80).collect::<String>()
        );
        let _ = std::process::Command::new("/usr/bin/osascript")
            .arg("-e")
            .arg(script)
            .spawn();
    }
}

pub fn run() {
    tauri::Builder::default()
        .register_asynchronous_uri_scheme_protocol(IMAGE_SCHEME, |ctx, request, responder| {
            let url = request.uri().to_string();
            let cache = ctx.app_handle().state::<AppState>().images.clone();
            tauri::async_runtime::spawn(async move {
                responder.respond(image_protocol_response(&url, &cache));
            });
        })
        .register_asynchronous_uri_scheme_protocol(ARTIFACT_SCHEME, |ctx, request, responder| {
            let url = request.uri().to_string();
            let state = ctx.app_handle().state::<AppState>();
            let store = state.store.clone();
            let normalizer = state.normalizer.clone();
            let runtime_dirs = state.runtime_dirs.clone();
            tauri::async_runtime::spawn(async move {
                let dir_refs: Vec<&Path> = runtime_dirs.iter().map(PathBuf::as_path).collect();
                let resp = artifact_protocol_response(&url, &store, normalizer.as_ref(), &dir_refs).await;
                responder.respond(resp);
            });
        })
        .setup(|app| {
            let handle = app.handle().clone();
            let app_version = app.package_info().version.to_string();
            let home = std::env::var("HOME").unwrap_or_else(|_| "/Users".into());
            let data_dir = default_data_dir(&home);
            let downloads_dir = Path::new(&home).join("Downloads");

            let mut runtime_dirs = Vec::new();
            if let Ok(res_dir) = app.path().resource_dir() {
                runtime_dirs.push(res_dir.join("artifact-runtime"));
            }
            let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
            runtime_dirs.push(manifest_dir.join("../out/artifact-runtime"));

            let corpus_candidate = manifest_dir.join("../../../eval/corpus");
            let corpus_dir = corpus_candidate.canonicalize().ok().filter(|p| p.is_dir());

            let settings = Arc::new(
                SettingsStore::open(
                    data_dir.join("settings.json"),
                    data_dir.to_string_lossy().to_string(),
                    &home,
                    Arc::new(KeychainAesEncryptor::default()),
                )
                .map_err(|e| std::io::Error::other(e))?,
            );

            let db = Arc::new(
                Db::open(&data_dir.join(DATABASE_FILE))
                    .map_err(|e| std::io::Error::other(e))?,
            );

            let http = build_http_client();
            let normalizer = Arc::new(TauriNormalizerBridge::new());
            normalizer.bind_app(handle.clone());

            let meta = MetaStore::new(db.clone());
            let items = ItemStore::new(db.clone());
            let sources = SourceStore::new(db.clone());
            let events = EventStore::new(db.clone());
            let sessions = SessionStore::new(db.clone());
            let images = ImageCache::new(&data_dir);
            let annotations = AnnotationStore::new(&data_dir);

            let settings_keep = settings.clone();
            let settings_judge = settings.clone();
            let store = Arc::new(MaterialStore::new(
                &data_dir,
                http.clone(),
                meta.clone(),
                normalizer.clone(),
                Arc::new(move || settings_keep.get().keep_capture),
                Arc::new(move || {
                    let s = settings_judge.get();
                    if s.reflow_judge == "jev" {
                        let key = settings_judge.secret("typesafeApiKey")?;
                        Ok(("jev".into(), Some(key)))
                    } else {
                        Ok(("rules".into(), None))
                    }
                }),
            ));

            let sync_coord = Arc::new(SyncCoordinator::new());

            let settings_codex = settings.clone();
            let codex = Arc::new(CodexClient::new(
                Arc::new(move || settings_codex.get().codex_path),
                data_dir.join("codex"),
            ));

            let settings_agent = settings.clone();
            let handle_ev = handle.clone();
            let sessions_ev = sessions.clone();
            let handle_sess = handle.clone();
            let handle_lib = handle.clone();
            let agent = Arc::new(AgentService::new(
                codex.clone(),
                store.clone(),
                sessions.clone(),
                items.clone(),
                annotations.clone(),
                images.clone(),
                &data_dir,
                Arc::new(move || {
                    let s = settings_agent.get();
                    (s.agent_model, s.agent_reasoning_effort)
                }),
                Arc::new(move |ev| {
                    let _ = handle_ev.emit("agent:event", &ev);
                    notify_if_unfocused(&handle_ev, &sessions_ev, &ev);
                }),
                Arc::new(move || {
                    let _ = handle_sess.emit("agent:sessions:changed", ());
                }),
                Arc::new(move || {
                    let _ = handle_lib.emit("library:changed", ());
                }),
                Arc::new(open_external_url),
            ));

            let settings_upd = settings.clone();
            let handle_upd = handle.clone();
            let updates = Arc::new(UpdateService::new(
                &app_version,
                "Leonezz",
                "quire",
                current_platform(),
                current_arch(),
                downloads_dir,
                Arc::new(move || settings_upd.get().check_updates_automatically),
                Arc::new(move |st| {
                    let _ = handle_upd.emit("update:state", st);
                }),
                Arc::new(open_external_url),
                Arc::new(open_local_path),
            ));

            let feedback = Arc::new(FeedbackStore::new(
                data_dir.join("feedback"),
                store.clone(),
                FeedbackAppInfo {
                    version: app_version,
                    platform: current_platform().into(),
                    normalize: "0.1.0".into(),
                },
            ));

            // Configure native macOS window vibrancy & menu
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.set_effects(
                    EffectsBuilder::new()
                        .effect(Effect::UnderWindowBackground)
                        .state(EffectState::Active)
                        .build(),
                );
            }

            let app_menu = SubmenuBuilder::new(app, "Quire")
                .about(None)
                .separator()
                .services()
                .separator()
                .hide()
                .hide_others()
                .show_all()
                .separator()
                .quit()
                .build()?;
            let edit_menu = SubmenuBuilder::new(app, "Edit")
                .undo()
                .redo()
                .separator()
                .cut()
                .copy()
                .paste()
                .select_all()
                .build()?;
            let window_menu = SubmenuBuilder::new(app, "Window")
                .minimize()
                .maximize()
                .separator()
                .close_window()
                .build()?;

            let menu = if corpus_dir.is_some() {
                let import_item = MenuItemBuilder::with_id("import_corpus", "Import Evaluation Corpus")
                    .accelerator("CmdOrCtrl+Shift+I")
                    .build(app)?;
                let dev_menu = SubmenuBuilder::new(app, "Developer")
                    .item(&import_item)
                    .build()?;
                MenuBuilder::new(app)
                    .items(&[&app_menu, &edit_menu, &window_menu, &dev_menu])
                    .build()?
            } else {
                MenuBuilder::new(app)
                    .items(&[&app_menu, &edit_menu, &window_menu])
                    .build()?
            };
            app.set_menu(menu)?;

            app.on_menu_event(|app_handle, event| {
                if event.id() == "import_corpus" {
                    let h = app_handle.clone();
                    tauri::async_runtime::spawn(async move {
                        let st = h.state::<AppState>();
                        let _ = run_import_corpus(&h, &st).await;
                    });
                }
            });

            // Start background scheduler & update checker
            let settings_sched = settings.clone();
            let http_sched = http.clone();
            let norm_sched = normalizer.clone();
            let sources_sched = sources.clone();
            let items_sched = items.clone();
            let settings_sched_due = settings.clone();
            let handle_sched = handle.clone();

            sync_coord.start(
                Arc::new(move || settings_sched.get().sync_interval_minutes),
                Arc::new(move || {
                    let h = http_sched.clone();
                    let n = norm_sched.clone();
                    let s = sources_sched.clone();
                    let i = items_sched.clone();
                    let iv = settings_sched_due.get().sync_interval_minutes;
                    let hc = handle_sched.clone();
                    Box::pin(async move {
                        let (_, _, failures) = crate::sync::sync_due(&h, n, &s, &i, iv, &move || {
                            let _ = hc.emit("sources:changed", ());
                        })
                        .await;
                        for (loc, msg) in failures {
                            eprintln!("[sources] sync of {loc}: {msg}");
                        }
                    })
                }),
            );
            updates.start();

            app.manage(AppState {
                data_dir,
                corpus_dir,
                runtime_dirs,
                db,
                http,
                normalizer,
                settings,
                meta,
                store,
                images,
                annotations,
                items,
                sources,
                events,
                sessions,
                sync_coord,
                codex,
                agent,
                updates,
                feedback,
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::normalizer_reply,
            commands::open_external,
            commands::theme_set,
            commands::material_import_corpus,
            commands::material_open_url,
            commands::material_open_file,
            commands::material_get,
            commands::material_bytes,
            commands::image_resolve,
            commands::annotation_list,
            commands::annotation_save,
            commands::annotation_delete,
            commands::material_list,
            commands::source_detect,
            commands::source_add,
            commands::source_list,
            commands::source_sync,
            commands::source_sync_all,
            commands::source_pause,
            commands::source_remove,
            commands::item_inbox,
            commands::item_queue,
            commands::item_get,
            commands::item_read,
            commands::item_keep,
            commands::item_decide,
            commands::item_reorder,
            commands::event_record,
            commands::event_stats,
            commands::search_query,
            commands::agent_status,
            commands::agent_ask,
            commands::agent_interrupt,
            commands::agent_runs,
            commands::agent_login,
            commands::library_query,
            commands::material_update_meta,
            commands::material_refresh_meta,
            commands::material_bibtex,
            commands::material_tags,
            commands::material_delete,
            commands::settings_get,
            commands::settings_update,
            commands::storage_usage_get,
            commands::agent_sessions_list,
            commands::agent_sessions_get,
            commands::agent_sessions_delete,
            commands::material_fetch_view,
            commands::material_get_view,
            commands::artifact_version,
            commands::artifact_restore,
            commands::material_set_primary_view,
            commands::update_state,
            commands::update_check,
            commands::update_install,
            commands::update_download,
            commands::update_open_downloaded,
            commands::update_open_release,
            commands::feedback_submit,
            commands::feedback_copy_screenshot,
            commands::feedback_create,
            commands::feedback_list,
            commands::feedback_delete,
            commands::feedback_open_issue,
            commands::feedback_set_issue_url,
            commands::feedback_reveal,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Quire Tauri application")
        .run(|app_handle, event| {
            if let RunEvent::Exit = event {
                if let Some(state) = app_handle.try_state::<AppState>() {
                    state.sync_coord.stop();
                    state.updates.stop();
                    state.agent.shutdown();
                }
            }
        });
}
