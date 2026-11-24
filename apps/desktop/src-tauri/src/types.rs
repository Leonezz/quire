use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub const IMAGE_SCHEME: &str = "quire-image";
pub const ARTIFACT_SCHEME: &str = "quire-artifact";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NormalizationProblem {
    pub code: String,
    pub severity: String,
    pub recover_by: String,
    pub scope: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ContentNormalizationQuality {
    pub completeness: String,
    pub conformance: String,
    pub identity_confidence: String,
    pub safety: String,
    pub warnings: Vec<NormalizationProblem>,
}

impl Default for ContentNormalizationQuality {
    fn default() -> Self {
        Self {
            completeness: "declared_full".into(),
            conformance: "conformant".into(),
            identity_confidence: "derived".into(),
            safety: "safe".into(),
            warnings: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactInfo {
    #[serde(rename = "type")]
    pub artifact_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    pub version: u32,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PdfInfo {
    pub pages: u32,
    pub byte_length: u64,
    pub text_layer: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CaptureInfo {
    pub byte_length: u64,
    pub media_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fetched_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReaderPayload {
    pub schema: String,
    pub payload: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Creator {
    pub role: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub given: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub family: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MaterialMeta {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub short_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub creators: Option<Vec<Creator>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub r#abstract: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub publication: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub volume: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub issue: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pages: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub publisher: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub place: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub edition: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub series: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accessed: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub doi: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub arxiv_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub isbn: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub issn: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extra: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub related: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MaterialView {
    pub id: String,
    pub label: String,
    pub url: String,
    pub media_type: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fetched_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub byte_length: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pdf: Option<PdfInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MaterialSummary {
    pub id: String,
    pub url: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub byline: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub published_at: Option<String>,
    pub fetched_at: String,
    pub reading_minutes: u32,
    pub origin: String,
    pub media_type: String,
    pub quality: ContentNormalizationQuality,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lineage: Option<Vec<String>>,
    pub tags: Vec<String>,
    pub kind: String,
    pub ready_views: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub publication: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rebuilt_as: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artifact: Option<ArtifactInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MaterialRecord {
    pub id: String,
    pub url: String,
    pub final_url: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub byline: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub published_at: Option<String>,
    pub fetched_at: String,
    pub reading_minutes: u32,
    pub origin: String,
    pub media_type: String,
    pub quality: ContentNormalizationQuality,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lineage: Option<Vec<String>>,
    pub tags: Vec<String>,
    pub kind: String,
    pub ready_views: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub publication: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rebuilt_as: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artifact: Option<ArtifactInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub aliases: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub canonical_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pdf: Option<PdfInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capture: Option<CaptureInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub arxiv_version: Option<u32>,
    pub extracted: MaterialMeta,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub overrides: Option<MaterialMeta>,
    pub meta: MaterialMeta,
    pub views: Vec<MaterialView>,
    pub primary_view: String,
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
    pub problems: Vec<NormalizationProblem>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artifact_source: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum OpenUrlResult {
    Ok {
        ok: bool,
        material: Box<MaterialRecord>,
        #[serde(skip_serializing_if = "Option::is_none")]
        existing: Option<bool>,
    },
    Err {
        ok: bool,
        code: String,
        message: String,
    },
}

impl OpenUrlResult {
    pub fn success(material: MaterialRecord, existing: bool) -> Self {
        Self::Ok {
            ok: true,
            material: Box::new(material),
            existing: if existing { Some(true) } else { None },
        }
    }
    pub fn failure(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::Err {
            ok: false,
            code: code.into(),
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Annotation {
    pub id: String,
    pub material_id: String,
    pub locator: String,
    pub quote: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub view: Option<String>,
    pub color: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CorpusFailure {
    pub slug: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CorpusImportResult {
    pub imported: u32,
    pub skipped: u32,
    pub failed: Vec<CorpusFailure>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SourceRecord {
    pub id: String,
    pub kind: String,
    pub locator: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub site_url: Option<String>,
    pub added_at: String,
    pub interval_minutes: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_sync_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_success_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    pub failure_count: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub paused_at: Option<String>,
    pub item_count: u32,
    pub kept_count: u32,
    pub weekly_rate: f64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ItemSignals {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub math: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub figures: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lang: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ItemRecord {
    pub id: String,
    pub source_id: String,
    pub source_title: String,
    pub source_kind: String,
    pub title: String,
    pub gist: String,
    pub link: String,
    pub published_at: String,
    pub fetched_at: String,
    pub reading_minutes: u32,
    pub signals: ItemSignals,
    pub summary_only: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub opened_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kept_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub queued_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub queue_position: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dismissed_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub material_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub introduced_by: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SourceDetection {
    Feed {
        url: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        title: Option<String>,
    },
    Arxiv {
        category: String,
        title: String,
    },
    Page {
        url: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        feed: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum AddSourceResult {
    Ok {
        ok: bool,
        source: SourceRecord,
        added: u32,
    },
    Err {
        ok: bool,
        code: String,
        message: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum SyncSourceResult {
    Ok {
        ok: bool,
        source: SourceRecord,
        added: u32,
    },
    Err {
        ok: bool,
        code: String,
        message: String,
        source: SourceRecord,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReadingEvent {
    pub id: String,
    pub kind: String,
    pub r#ref: String,
    pub at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReadingStats {
    pub week_start: String,
    pub finished_this_week: u32,
    pub finished_last_week: u32,
    pub opened_this_week: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub kind: String,
    pub id: String,
    pub title: String,
    pub subtitle: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AgentContext {
    Library,
    Material {
        #[serde(rename = "materialId")]
        material_id: String,
    },
    Selection {
        #[serde(rename = "materialId")]
        material_id: String,
        quote: String,
        locator: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentRequest {
    pub context: AgentContext,
    pub task: String,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum AgentResult {
    Ok {
        ok: bool,
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "turnId")]
        turn_id: String,
    },
    Err {
        ok: bool,
        code: String,
        message: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentToolRow {
    pub name: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub count: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentRun {
    pub session_id: String,
    pub turn_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    pub task: String,
    pub prompt: String,
    pub answer: String,
    pub tools: Vec<AgentToolRow>,
    pub started_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatus {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub running: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AgentEvent {
    Started {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "threadId")]
        thread_id: String,
        #[serde(rename = "turnId")]
        turn_id: String,
    },
    Delta {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "turnId")]
        turn_id: String,
        delta: String,
    },
    Tool {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "turnId")]
        turn_id: String,
        name: String,
        status: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        summary: Option<String>,
    },
    Completed {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "turnId")]
        turn_id: String,
        text: String,
        sources: Vec<String>,
    },
    Failed {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "turnId")]
        turn_id: String,
        code: String,
        message: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TagCount {
    pub tag: String,
    pub count: u32,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryFilter {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub material_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tag: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sort: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub sync_interval_minutes: u32,
    pub keep_capture: bool,
    pub codex_path: String,
    pub agent_model: String,
    pub agent_reasoning_effort: String,
    pub data_directory: String,
    pub check_updates_automatically: bool,
    pub reflow_judge: String,
    pub typesafe_api_key_set: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeleteMaterialsResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pictures_kept: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StorageUsage {
    pub materials: u64,
    pub images: u64,
    pub figures: u64,
    pub database: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentTurnRecord {
    pub id: String,
    pub role: String,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<AgentToolRow>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sources: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    pub at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionSummary {
    pub id: String,
    pub title: String,
    pub context: AgentContext,
    pub created_at: String,
    pub updated_at: String,
    pub turn_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentSession {
    pub id: String,
    pub title: String,
    pub context: AgentContext,
    pub created_at: String,
    pub updated_at: String,
    pub turn_count: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    pub turns: Vec<AgentTurnRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TextViewAnchor {
    pub page: u32,
    pub rect: [f64; 4],
    pub start: u32,
    pub end: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TextViewJudged {
    pub provider: String,
    pub asked: u32,
    pub changed: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TextViewReport {
    pub pages: u32,
    pub columns: u32,
    pub furniture_lines: u32,
    pub headings: u32,
    pub paragraphs: u32,
    pub figures: u32,
    pub degraded_pages: Vec<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub judged: Option<TextViewJudged>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactBody {
    #[serde(rename = "type")]
    pub artifact_type: String,
    pub source: String,
    pub version: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MaterialViewContent {
    pub view: String,
    pub media_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pdf: Option<PdfInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reader: Option<ReaderPayload>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub markdown: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plain: Option<String>,
    pub reading_minutes: u32,
    pub quality: ContentNormalizationQuality,
    pub problems: Vec<NormalizationProblem>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anchors: Option<Vec<TextViewAnchor>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artifact_body: Option<ArtifactBody>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub report: Option<TextViewReport>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "phase", rename_all = "kebab-case")]
pub enum UpdateState {
    Idle {
        current: String,
        #[serde(rename = "checkedAt", skip_serializing_if = "Option::is_none")]
        checked_at: Option<String>,
    },
    Checking {
        current: String,
    },
    UpToDate {
        current: String,
        #[serde(rename = "checkedAt")]
        checked_at: String,
    },
    Available {
        current: String,
        latest: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        notes: Option<String>,
        url: String,
        #[serde(rename = "canInstall")]
        can_install: bool,
        #[serde(rename = "downloadUrl", skip_serializing_if = "Option::is_none")]
        download_url: Option<String>,
        #[serde(rename = "checkedAt")]
        checked_at: String,
    },
    Downloading {
        current: String,
        latest: String,
        percent: u32,
    },
    Ready {
        current: String,
        latest: String,
    },
    Saved {
        current: String,
        latest: String,
        path: String,
    },
    Error {
        current: String,
        message: String,
        #[serde(rename = "checkedAt")]
        checked_at: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackViewport {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub scroll_fraction: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackSelectionDraft {
    pub quote: String,
    pub prefix: String,
    pub suffix: String,
    pub rect: FeedbackRect,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RenderingFeedbackDraft {
    pub material_id: String,
    pub view: String,
    pub kinds: Vec<String>,
    pub note: String,
    pub include_capture: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub viewport: Option<FeedbackViewport>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selection: Option<FeedbackSelectionDraft>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prefs: Option<HashMap<String, serde_json::Value>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RenderingFeedbackPackage {
    pub zip_path: String,
    pub zip_bytes: u64,
    pub screenshots: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub composite: Option<String>,
    pub issue_opened: bool,
    pub revealed: bool,
    pub copied_to_clipboard: bool,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackAppInfo {
    pub version: String,
    pub platform: String,
    pub normalize: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackCaptureMeta {
    pub included: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub byte_length: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackSelectionSaved {
    pub quote: String,
    pub prefix: String,
    pub suffix: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackReaderState {
    pub scroll_fraction: f64,
    pub prefs: HashMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RenderingFeedback {
    pub id: String,
    pub created_at: String,
    pub material_id: String,
    pub url: String,
    pub title: String,
    pub view: String,
    pub kinds: Vec<String>,
    pub note: String,
    pub app: FeedbackAppInfo,
    pub quality: ContentNormalizationQuality,
    pub problems: Vec<NormalizationProblem>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub report: Option<TextViewReport>,
    pub capture: FeedbackCaptureMeta,
    pub bundle_dir: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub issue_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub package: Option<RenderingFeedbackPackage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selection: Option<FeedbackSelectionSaved>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reader_state: Option<FeedbackReaderState>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackProgress {
    pub id: String,
    pub step: String,
    pub message: String,
}
