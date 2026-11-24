use crate::http::{
    arxiv_id_of, arxiv_query_url, assert_public_http_url, detect_source, fetch_page,
    subscription_of, FEED_ACCEPT,
};
use crate::materials::{view_label, FeedMaterialInput, MaterialStore};
use crate::normalizer_bridge::Normalizer;
use crate::sqlite_stores::{now_iso, EventStore, ItemStore, SourceHealthUpdate, SourceStore};
use crate::types::{
    AddSourceResult, ItemRecord, MaterialMeta, MaterialRecord, MaterialView, OpenUrlResult,
    SourceRecord, SyncSourceResult,
};
use chrono::{DateTime, Utc};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{Mutex, Notify};

pub async fn sync_source(
    source: &SourceRecord,
    http: &reqwest::Client,
    normalizer: &dyn Normalizer,
    sources: &SourceStore,
    items: &ItemStore,
) -> SyncSourceResult {
    let outcome: Result<(String, Option<String>, Vec<_>), (String, String)> = async {
        if source.kind == "arxiv" {
            let query_url = arxiv_query_url(&source.locator);
            let url = assert_public_http_url(&query_url).map_err(|e| (e.code, e.message))?;
            let page = fetch_page(http, &url, FEED_ACCEPT)
                .await
                .map_err(|e| (e.code, e.message))?;
            let parsed = normalizer
                .parse_feed(&page.bytes, &page.media_type, &query_url, true)
                .await
                .map_err(|e| ("SYNC_FAILED".into(), e))?;
            Ok((source.title.clone(), None, parsed.items))
        } else {
            let url = assert_public_http_url(&source.locator).map_err(|e| (e.code, e.message))?;
            let page = fetch_page(http, &url, FEED_ACCEPT)
                .await
                .map_err(|e| (e.code, e.message))?;
            let parsed = normalizer
                .parse_feed(&page.bytes, &page.media_type, &source.locator, false)
                .await
                .map_err(|e| ("SYNC_FAILED".into(), e))?;
            Ok((parsed.title, parsed.site_url, parsed.items))
        }
    }
    .await;

    let at = now_iso();
    match outcome {
        Ok((title, site_url, parsed_items)) => {
            match items
                .upsert(&source.id, &title, &source.kind, &parsed_items)
                .and_then(|added| {
                    let updated = sources.update_health(
                        &source.id,
                        SourceHealthUpdate {
                            last_sync_at: &at,
                            last_success_at: Some(&at),
                            last_error: None,
                            failure_count: 0,
                            title: Some(&title),
                            site_url: site_url.as_deref(),
                        },
                    )?;
                    Ok((updated, added))
                }) {
                Ok((updated, added)) => SyncSourceResult::Ok {
                    ok: true,
                    source: updated,
                    added,
                },
                Err(msg) => {
                    let updated = sources
                        .update_health(
                            &source.id,
                            SourceHealthUpdate {
                                last_sync_at: &at,
                                last_success_at: None,
                                last_error: Some(&msg),
                                failure_count: source.failure_count + 1,
                                title: None,
                                site_url: None,
                            },
                        )
                        .unwrap_or_else(|_| source.clone());
                    SyncSourceResult::Err {
                        ok: false,
                        code: "SYNC_FAILED".into(),
                        message: msg,
                        source: updated,
                    }
                }
            }
        }
        Err((code, message)) => {
            let updated = sources
                .update_health(
                    &source.id,
                    SourceHealthUpdate {
                        last_sync_at: &at,
                        last_success_at: None,
                        last_error: Some(&message),
                        failure_count: source.failure_count + 1,
                        title: None,
                        site_url: None,
                    },
                )
                .unwrap_or_else(|_| source.clone());
            SyncSourceResult::Err {
                ok: false,
                code,
                message,
                source: updated,
            }
        }
    }
}

pub fn is_due(source: &SourceRecord, now: DateTime<Utc>, interval_minutes: u32) -> bool {
    if source.paused_at.is_some() {
        return false;
    }
    let Some(last) = &source.last_sync_at else {
        return true;
    };
    let Ok(parsed) = DateTime::parse_from_rfc3339(last) else {
        return true;
    };
    let elapsed_ms = (now - parsed.with_timezone(&Utc)).num_milliseconds();
    elapsed_ms >= (interval_minutes as i64) * 60_000
}

pub async fn sync_due(
    http: &reqwest::Client,
    normalizer: Arc<dyn Normalizer>,
    sources: &SourceStore,
    items: &ItemStore,
    interval_minutes: u32,
    on_changed: &(dyn Fn() + Send + Sync),
) -> (usize, u32, Vec<(String, String)>) {
    let now = Utc::now();
    let due: Vec<SourceRecord> = sources
        .list()
        .unwrap_or_default()
        .into_iter()
        .filter(|s| is_due(s, now, interval_minutes))
        .collect();
    if due.is_empty() {
        return (0, 0, Vec::new());
    }
    let queue = Arc::new(std::sync::Mutex::new(due.into_iter()));
    let workers = 2;
    let mut handles = Vec::with_capacity(workers);
    for _ in 0..workers {
        let http_c = http.clone();
        let norm_c = normalizer.clone();
        let sources_c = sources.clone();
        let items_c = items.clone();
        let q = queue.clone();
        handles.push(tokio::spawn(async move {
            let mut synced = 0usize;
            let mut added = 0u32;
            let mut failures = Vec::new();
            loop {
                let next = q.lock().ok().and_then(|mut it| it.next());
                let Some(src) = next else { break };
                let res = sync_source(&src, &http_c, norm_c.as_ref(), &sources_c, &items_c).await;
                synced += 1;
                match res {
                    SyncSourceResult::Ok { added: a, .. } => added += a,
                    SyncSourceResult::Err { source: s, message, .. } => {
                        failures.push((s.locator, message));
                    }
                }
            }
            (synced, added, failures)
        }));
    }

    let mut total_synced = 0;
    let mut total_added = 0;
    let mut all_failures = Vec::new();
    for h in handles {
        if let Ok((s, a, f)) = h.await {
            total_synced += s;
            total_added += a;
            all_failures.extend(f);
        }
    }
    if total_synced > 0 {
        on_changed();
    }
    (total_synced, total_added, all_failures)
}

pub async fn add_source(
    input: &str,
    http: &reqwest::Client,
    normalizer: &dyn Normalizer,
    sources: &SourceStore,
    items: &ItemStore,
    on_changed: &(dyn Fn() + Send + Sync),
) -> AddSourceResult {
    let detection = match detect_source(http, input).await {
        Ok(d) => d,
        Err(e) => {
            return AddSourceResult::Err {
                ok: false,
                code: "DETECT_FAILED".into(),
                message: e.message,
            }
        }
    };
    let Some((kind, locator, title)) = subscription_of(&detection) else {
        return AddSourceResult::Err {
            ok: false,
            code: "NOT_A_FEED".into(),
            message: format!(
                "{} is a page without a feed. Paste its feed URL, or open the page itself in the library.",
                input.trim()
            ),
        };
    };
    let created = match sources.add(&kind, &locator, &title, None) {
        Ok(s) => s,
        Err(msg) => {
            return AddSourceResult::Err {
                ok: false,
                code: "SOURCE_EXISTS".into(),
                message: msg,
            }
        }
    };
    let synced = sync_source(&created, http, normalizer, sources, items).await;
    on_changed();
    match synced {
        SyncSourceResult::Ok { source, added, .. } => AddSourceResult::Ok {
            ok: true,
            source,
            added,
        },
        SyncSourceResult::Err { code, message, .. } => AddSourceResult::Err {
            ok: false,
            code,
            message,
        },
    }
}

// ---------------------------------------------------------------------------
// Inbox Read / Keep (matching inbox.ts)
// ---------------------------------------------------------------------------

fn with_arxiv_view(store: &MaterialStore, mat: MaterialRecord, view: MaterialView) -> OpenUrlResult {
    if mat.ready_views.contains(&view.id) {
        return OpenUrlResult::success(mat, false);
    }
    match store.register_view(&mat.id, view) {
        Ok(updated) => OpenUrlResult::success(updated, false),
        Err(msg) => OpenUrlResult::failure("NORMALIZE_FAILED", msg),
    }
}

async fn materialize_arxiv(
    item: &ItemRecord,
    store: &MaterialStore,
    meta: Option<MaterialMeta>,
) -> OpenUrlResult {
    let Some(id) = arxiv_id_of(&item.link) else {
        return OpenUrlResult::failure("ARXIV_ID_INVALID", format!("Not an arXiv link: {}", item.link));
    };
    let html_url = format!("https://arxiv.org/html/{id}");
    let pdf_url = format!("https://arxiv.org/pdf/{id}");

    let html = store.open_url(&html_url, "feed", meta.clone()).await;
    let html_err = match html {
        OpenUrlResult::Ok { material, .. } => {
            return with_arxiv_view(
                store,
                *material,
                MaterialView {
                    id: "pdf".into(),
                    label: view_label("pdf").into(),
                    url: pdf_url,
                    media_type: "application/pdf".into(),
                    status: "available".into(),
                    fetched_at: None,
                    byte_length: None,
                    pdf: None,
                    error: None,
                },
            );
        }
        OpenUrlResult::Err { code, message, .. } => (code, message),
    };

    let pdf = store.open_url(&pdf_url, "feed", meta).await;
    match pdf {
        OpenUrlResult::Ok { material, .. } => {
            let no_html = html_err.0 == "HTTP_404" || html_err.0 == "HTTP_410";
            let web_view = MaterialView {
                id: "web".into(),
                label: view_label("web").into(),
                url: html_url,
                media_type: "text/html".into(),
                status: if no_html { "available".into() } else { "failed".into() },
                fetched_at: None,
                byte_length: None,
                pdf: None,
                error: if no_html { None } else { Some(html_err.1) },
            };
            with_arxiv_view(store, *material, web_view)
        }
        OpenUrlResult::Err { code, message, .. } => OpenUrlResult::failure(
            code,
            format!(
                "Neither the HTML rendering ({}) nor the PDF ({message}) of {id} could be read.",
                html_err.1
            ),
        ),
    }
}

async fn materialize_feed_item(
    item: &ItemRecord,
    items: &ItemStore,
    store: &MaterialStore,
    meta: Option<MaterialMeta>,
) -> OpenUrlResult {
    let page = store.open_url(&item.link, "feed", meta.clone()).await;
    if matches!(page, OpenUrlResult::Ok { .. }) {
        return page;
    }
    let Some(content) = items.content(&item.id).ok().flatten() else {
        return page;
    };
    match store.save_from_feed(FeedMaterialInput {
        url: item.link.clone(),
        title: item.title.clone(),
        byline: None,
        published_at: Some(item.published_at.clone()),
        lang: item.signals.lang.clone(),
        meta,
        content,
    }) {
        Ok(mat) => OpenUrlResult::success(mat, false),
        Err(msg) => OpenUrlResult::failure("NORMALIZE_FAILED", msg),
    }
}

async fn material_of_item(
    item: &ItemRecord,
    items: &ItemStore,
    store: &MaterialStore,
) -> Result<(MaterialRecord, bool), (String, String)> {
    if let Some(ref mid) = item.material_id {
        if let Ok(Some(existing)) = store.get(mid) {
            return Ok((existing, false));
        }
    }
    let meta = items.meta(&item.id).ok().flatten();
    let res = if item.source_kind == "arxiv" {
        materialize_arxiv(item, store, meta).await
    } else {
        materialize_feed_item(item, items, store, meta).await
    };
    match res {
        OpenUrlResult::Ok { material, .. } => Ok((*material, true)),
        OpenUrlResult::Err { code, message, .. } => Err((code, message)),
    }
}

pub async fn read_item(
    id: &str,
    items: &ItemStore,
    events: &EventStore,
    store: &MaterialStore,
    on_materialized: &(dyn Fn() + Send + Sync),
) -> OpenUrlResult {
    let Some(item) = items.get(id).ok().flatten() else {
        return OpenUrlResult::failure("ITEM_NOT_FOUND", "This item is no longer in the library.");
    };
    match material_of_item(&item, items, store).await {
        Ok((material, fresh)) => {
            let _ = items.mark_opened(id, &material.id);
            let _ = events.record("opened", id);
            if fresh {
                on_materialized();
            }
            OpenUrlResult::success(material, false)
        }
        Err((code, msg)) => OpenUrlResult::failure(code, msg),
    }
}

pub async fn keep_item(
    id: &str,
    items: &ItemStore,
    events: &EventStore,
    store: &MaterialStore,
    on_materialized: &(dyn Fn() + Send + Sync),
) -> OpenUrlResult {
    let Some(item) = items.get(id).ok().flatten() else {
        return OpenUrlResult::failure("ITEM_NOT_FOUND", "This item is no longer in the library.");
    };
    match material_of_item(&item, items, store).await {
        Ok((material, fresh)) => {
            let _ = items.mark_kept(id, &material.id);
            let _ = events.record("kept", &material.id);
            if fresh {
                on_materialized();
            }
            OpenUrlResult::success(material, false)
        }
        Err((code, msg)) => OpenUrlResult::failure(code, msg),
    }
}

// ---------------------------------------------------------------------------
// SyncCoordinator & Scheduler
// ---------------------------------------------------------------------------

pub struct SyncCoordinator {
    lock: Mutex<()>,
    stopped: AtomicBool,
    wake: Notify,
    in_flight: Mutex<Option<Arc<Notify>>>,
}

impl Default for SyncCoordinator {
    fn default() -> Self {
        Self::new()
    }
}

impl SyncCoordinator {
    pub fn new() -> Self {
        Self {
            lock: Mutex::new(()),
            stopped: AtomicBool::new(false),
            wake: Notify::new(),
            in_flight: Mutex::new(None),
        }
    }

    pub async fn exclusive<F, T>(&self, run: F) -> T
    where
        F: std::future::Future<Output = T>,
    {
        let _guard = self.lock.lock().await;
        run.await
    }

    pub async fn tick<F, Fut>(&self, sync_all_fn: F)
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = ()>,
    {
        let existing = { self.in_flight.lock().await.clone() };
        if let Some(waiter) = existing {
            waiter.notified().await;
            return;
        }
        let notify = Arc::new(Notify::new());
        {
            *self.in_flight.lock().await = Some(notify.clone());
        }
        self.exclusive(sync_all_fn()).await;
        {
            *self.in_flight.lock().await = None;
        }
        notify.notify_waiters();
    }

    pub fn start(
        self: &Arc<Self>,
        interval_minutes: Arc<dyn Fn() -> u32 + Send + Sync>,
        sync_fn: Arc<dyn Fn() -> crate::normalizer_bridge::BoxFuture<'static, ()> + Send + Sync>,
    ) {
        let coord = self.clone();
        tauri::async_runtime::spawn(async move {
            // Initial tick shortly after boot (give WebView 3s to mount so normalizer is ready)
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(3)) => {}
                _ = coord.wake.notified() => {}
            }
            while !coord.stopped.load(Ordering::Relaxed) {
                let f = sync_fn.clone();
                coord.tick(|| (f)()).await;
                let mins = interval_minutes().clamp(1, 15);
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_secs((mins as u64) * 60)) => {}
                    _ = coord.wake.notified() => {}
                }
            }
        });
    }

    pub fn stop(&self) {
        self.stopped.store(true, Ordering::Relaxed);
        self.wake.notify_waiters();
    }
}
