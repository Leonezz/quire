use crate::sqlite_stores::ItemInput;
use crate::types::{
    ContentNormalizationQuality, MaterialMeta, MaterialViewContent, MediaChapter,
    NormalizationProblem, ReaderPayload, TranscriptAnchor,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedHtml {
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub byline: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub published_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lang: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dir: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reader: Option<ReaderPayload>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub markdown: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plain: Option<String>,
    pub reading_minutes: u32,
    pub quality: ContentNormalizationQuality,
    pub problems: Vec<NormalizationProblem>,
    pub extracted: MaterialMeta,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub canonical_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractedPageMeta {
    pub meta: MaterialMeta,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub canonical_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedMarkdown {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reader: Option<ReaderPayload>,
    pub reading_minutes: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfInspection {
    pub pages: u32,
    pub text_layer: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sample_text: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CroppedFigure {
    pub index: u32,
    pub png_base64: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuiltTextView {
    pub content: MaterialViewContent,
    pub figures: Vec<CroppedFigure>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedFeedResult {
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub site_url: Option<String>,
    pub items: Vec<ItemInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptCueDto {
    pub start_sec: f64,
    pub end_sec: f64,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speaker: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptKeyframeDto {
    pub time_sec: f64,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub caption: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizeTranscriptInput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cues: Option<Vec<TranscriptCueDto>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chapters: Option<Vec<MediaChapter>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub keyframes: Option<Vec<TranscriptKeyframeDto>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedTranscriptResult {
    pub reader: ReaderPayload,
    pub markdown: String,
    pub plain: String,
    pub reading_minutes: u32,
    pub time_anchors: Vec<TranscriptAnchor>,
    pub cues: Vec<TranscriptCueDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompiledReact {
    pub code: String,
    pub files: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractMetaInput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub html_base64: Option<String>,
    pub url: String,
    pub media_type: String,
    pub origin: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fetched_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fallback_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fallback_byline: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fallback_published_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fallback_lang: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item: Option<MaterialMeta>,
}

pub trait Normalizer: Send + Sync {
    fn normalize_html<'a>(
        &'a self,
        bytes: &'a [u8],
        media_type: &'a str,
        final_url: &'a str,
        origin: &'a str,
        fetched_at: &'a str,
        item: Option<&'a MaterialMeta>,
    ) -> BoxFuture<'a, Result<NormalizedHtml, String>>;

    fn extract_meta<'a>(&'a self, input: ExtractMetaInput) -> BoxFuture<'a, Result<ExtractedPageMeta, String>>;

    fn normalize_markdown<'a>(
        &'a self,
        content: &'a str,
        base_uri: &'a str,
    ) -> BoxFuture<'a, Result<NormalizedMarkdown, String>>;

    fn inspect_pdf<'a>(&'a self, bytes: &'a [u8]) -> BoxFuture<'a, Result<PdfInspection, String>>;

    fn build_text_view<'a>(
        &'a self,
        bytes: &'a [u8],
        material_id: &'a str,
        title: &'a str,
        judge: &'a str,
        typesafe_api_key: Option<String>,
    ) -> BoxFuture<'a, Result<BuiltTextView, String>>;

    fn parse_feed<'a>(
        &'a self,
        bytes: &'a [u8],
        media_type: &'a str,
        feed_url: &'a str,
        is_arxiv: bool,
    ) -> BoxFuture<'a, Result<ParsedFeedResult, String>>;

    fn capture_text<'a>(&'a self, html: &'a str) -> BoxFuture<'a, Result<String, String>>;

    fn compile_react<'a>(&'a self, source: &'a str) -> BoxFuture<'a, Result<CompiledReact, String>>;

    fn normalize_transcript<'a>(
        &'a self,
        input: NormalizeTranscriptInput,
    ) -> BoxFuture<'a, Result<NormalizedTranscriptResult, String>>;
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BridgeRequest {
    request_id: u64,
    op: String,
    payload: serde_json::Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeReply {
    pub request_id: u64,
    pub ok: bool,
    pub result: Option<serde_json::Value>,
    pub error: Option<String>,
}

pub struct TauriNormalizerBridge {
    app: Mutex<Option<AppHandle>>,
    next_id: AtomicU64,
    pending: Mutex<HashMap<u64, oneshot::Sender<Result<serde_json::Value, String>>>>,
    react_cache: Mutex<HashMap<String, CompiledReact>>,
}

impl Default for TauriNormalizerBridge {
    fn default() -> Self {
        Self::new()
    }
}

impl TauriNormalizerBridge {
    pub fn new() -> Self {
        Self {
            app: Mutex::new(None),
            next_id: AtomicU64::new(1),
            pending: Mutex::new(HashMap::new()),
            react_cache: Mutex::new(HashMap::new()),
        }
    }

    pub fn bind_app(&self, handle: AppHandle) {
        if let Ok(mut slot) = self.app.lock() {
            *slot = Some(handle);
        }
    }

    pub fn complete(&self, reply: BridgeReply) {
        let sender = self
            .pending
            .lock()
            .ok()
            .and_then(|mut map| map.remove(&reply.request_id));
        if let Some(tx) = sender {
            if reply.ok {
                let _ = tx.send(Ok(reply.result.unwrap_or(serde_json::Value::Null)));
            } else {
                let _ = tx.send(Err(reply.error.unwrap_or_else(|| "Normalizer worker failed.".into())));
            }
        }
    }

    async fn call<R: for<'de> Deserialize<'de>>(
        &self,
        op: &str,
        payload: serde_json::Value,
        timeout_secs: u64,
    ) -> Result<R, String> {
        let app = self
            .app
            .lock()
            .map_err(|_| "Normalizer lock poisoned".to_string())?
            .clone()
            .ok_or_else(|| "Normalizer host is not bound yet.".to_string())?;

        let request_id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        {
            let mut pending = self.pending.lock().map_err(|_| "Normalizer lock poisoned".to_string())?;
            pending.insert(request_id, tx);
        }

        let req = BridgeRequest {
            request_id,
            op: op.to_string(),
            payload,
        };
        if let Err(err) = app.emit("normalizer:request", req) {
            if let Ok(mut pending) = self.pending.lock() {
                pending.remove(&request_id);
            }
            return Err(format!("Could not dispatch normalizer job ({op}): {err}"));
        }

        let raw = match tokio::time::timeout(Duration::from_secs(timeout_secs), rx).await {
            Ok(Ok(res)) => res?,
            Ok(Err(_)) => return Err(format!("Normalizer channel closed during {op}.")),
            Err(_) => {
                if let Ok(mut pending) = self.pending.lock() {
                    pending.remove(&request_id);
                }
                return Err(format!("Normalizer timed out after {timeout_secs}s during {op}."));
            }
        };

        serde_json::from_value(raw).map_err(|e| format!("Invalid normalizer payload for {op}: {e}"))
    }
}

impl Normalizer for TauriNormalizerBridge {
    fn normalize_html<'a>(
        &'a self,
        bytes: &'a [u8],
        media_type: &'a str,
        final_url: &'a str,
        origin: &'a str,
        fetched_at: &'a str,
        item: Option<&'a MaterialMeta>,
    ) -> BoxFuture<'a, Result<NormalizedHtml, String>> {
        use base64::Engine;
        let payload = serde_json::json!({
            "bytesBase64": base64::engine::general_purpose::STANDARD.encode(bytes),
            "mediaType": media_type,
            "finalUrl": final_url,
            "origin": origin,
            "fetchedAt": fetched_at,
            "item": item,
        });
        Box::pin(async move { self.call("normalizeHtml", payload, 45).await })
    }

    fn extract_meta<'a>(&'a self, input: ExtractMetaInput) -> BoxFuture<'a, Result<ExtractedPageMeta, String>> {
        let payload = serde_json::to_value(&input).unwrap_or(serde_json::Value::Null);
        Box::pin(async move { self.call("extractMeta", payload, 20).await })
    }

    fn normalize_markdown<'a>(
        &'a self,
        content: &'a str,
        base_uri: &'a str,
    ) -> BoxFuture<'a, Result<NormalizedMarkdown, String>> {
        let payload = serde_json::json!({
            "content": content,
            "baseUri": base_uri,
        });
        Box::pin(async move { self.call("normalizeMarkdown", payload, 20).await })
    }

    fn inspect_pdf<'a>(&'a self, bytes: &'a [u8]) -> BoxFuture<'a, Result<PdfInspection, String>> {
        use base64::Engine;
        let payload = serde_json::json!({
            "bytesBase64": base64::engine::general_purpose::STANDARD.encode(bytes),
        });
        Box::pin(async move { self.call("inspectPdf", payload, 60).await })
    }

    fn build_text_view<'a>(
        &'a self,
        bytes: &'a [u8],
        material_id: &'a str,
        title: &'a str,
        judge: &'a str,
        typesafe_api_key: Option<String>,
    ) -> BoxFuture<'a, Result<BuiltTextView, String>> {
        use base64::Engine;
        let payload = serde_json::json!({
            "bytesBase64": base64::engine::general_purpose::STANDARD.encode(bytes),
            "materialId": material_id,
            "title": title,
            "judge": judge,
            "typesafeApiKey": typesafe_api_key,
        });
        Box::pin(async move { self.call("buildTextView", payload, 180).await })
    }

    fn parse_feed<'a>(
        &'a self,
        bytes: &'a [u8],
        media_type: &'a str,
        feed_url: &'a str,
        is_arxiv: bool,
    ) -> BoxFuture<'a, Result<ParsedFeedResult, String>> {
        use base64::Engine;
        let payload = serde_json::json!({
            "bytesBase64": base64::engine::general_purpose::STANDARD.encode(bytes),
            "mediaType": media_type,
            "feedUrl": feed_url,
            "isArxiv": is_arxiv,
        });
        Box::pin(async move { self.call("parseFeed", payload, 30).await })
    }

    fn capture_text<'a>(&'a self, html: &'a str) -> BoxFuture<'a, Result<String, String>> {
        let payload = serde_json::json!({ "html": html });
        Box::pin(async move { self.call("captureText", payload, 30).await })
    }

    fn compile_react<'a>(&'a self, source: &'a str) -> BoxFuture<'a, Result<CompiledReact, String>> {
        let key = crate::sqlite_stores::sha256_hex(source.as_bytes());
        if let Ok(cache) = self.react_cache.lock() {
            if let Some(hit) = cache.get(&key) {
                let cloned = hit.clone();
                return Box::pin(async move { Ok(cloned) });
            }
        }
        let payload = serde_json::json!({ "source": source });
        Box::pin(async move {
            let compiled: CompiledReact = self.call("compileReact", payload, 15).await?;
            if let Ok(mut cache) = self.react_cache.lock() {
                cache.insert(key, compiled.clone());
            }
            Ok(compiled)
        })
    }

    fn normalize_transcript<'a>(
        &'a self,
        input: NormalizeTranscriptInput,
    ) -> BoxFuture<'a, Result<NormalizedTranscriptResult, String>> {
        let payload = serde_json::to_value(&input).unwrap_or(serde_json::Value::Null);
        Box::pin(async move { self.call("normalizeTranscript", payload, 30).await })
    }
}
