use crate::db::DATABASE_FILE;
use crate::http::{
    arxiv_id_of_url, arxiv_rendering_version, assert_public_http_url, canonical_url_of,
    fetch_page, id_for, is_audio_stream_url, material_id_of, resolve_apple_podcast_episode,
    stored_ids_of, FEED_ACCEPT, PAGE_ACCEPT,
};
use crate::media::{cached_media_info, remove_cached_media_files};
use crate::normalizer_bridge::{
    ExtractMetaInput, NormalizeTranscriptInput, NormalizedTranscriptResult, Normalizer,
    RefineTranscriptInput, StoryboardCropInputRegion, TranscriptCueDto, TranscriptKeyframeDto,
};
use crate::sqlite_stores::{now_iso, sha256_hex, ItemContent, ItemStore, MetaStore};
use crate::types::{
    Annotation, ArtifactBody, ArtifactInfo, CaptureInfo, ContentNormalizationQuality,
    CorpusFailure, CorpusImportResult, Creator, DeleteMaterialsResult, ItemRecord, LibraryFilter,
    MaterialMeta, MaterialRecord, MaterialSummary, MaterialView, MaterialViewContent, MediaChapter,
    MediaInfo, NormalizationProblem, OpenUrlResult, PdfInfo, ReaderPayload, SearchHit,
    StorageUsage, TranscriptAnchor, TranscriptTrackRef,
};
use base64::Engine;
use flate2::read::GzDecoder;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use url::Url;

pub const MATERIAL_VIEW_IDS: &[&str] = &["web", "pdf", "markdown", "text", "artifact", "transcript", "shownotes"];
pub const TEXT_VIEW_MEDIA_TYPE: &str = "text/x-quire-reflow";
pub const TRANSCRIPT_VIEW_MEDIA_TYPE: &str = "text/x-quire-transcript";
pub const SHOWNOTES_VIEW_MEDIA_TYPE: &str = "text/x-quire-shownotes";
pub const ARTIFACT_TYPES: &[&str] = &["markdown", "code", "html", "svg", "react", "mermaid"];
pub const MAX_ARTIFACT_SOURCE: usize = 400_000;

pub fn is_material_view_id(value: &str) -> bool {
    MATERIAL_VIEW_IDS.contains(&value)
}

pub fn view_label(id: &str) -> &'static str {
    match id {
        "pdf" => "PDF",
        "markdown" => "Markdown",
        "text" => "Text",
        "artifact" => "Artifact",
        "transcript" => "Transcript",
        "shownotes" => "Show notes",
        _ => "Web page",
    }
}

pub fn artifact_media_type(artifact_type: &str) -> Option<&'static str> {
    match artifact_type {
        "html" => Some("application/vnd.quire.artifact+html"),
        "svg" => Some("application/vnd.quire.artifact+svg"),
        "react" => Some("application/vnd.quire.artifact+react"),
        "mermaid" => Some("application/vnd.quire.artifact+mermaid"),
        _ => None,
    }
}

pub fn is_artifact_media_type(media_type: &str) -> bool {
    matches!(
        media_type,
        "application/vnd.quire.artifact+html"
            | "application/vnd.quire.artifact+svg"
            | "application/vnd.quire.artifact+react"
            | "application/vnd.quire.artifact+mermaid"
    )
}

pub fn view_id_for_media_type(media_type: &str) -> &'static str {
    if media_type == "application/pdf" {
        "pdf"
    } else if media_type == TEXT_VIEW_MEDIA_TYPE {
        "text"
    } else if media_type == TRANSCRIPT_VIEW_MEDIA_TYPE {
        "transcript"
    } else if media_type == SHOWNOTES_VIEW_MEDIA_TYPE {
        "shownotes"
    } else if matches!(media_type, "text/markdown" | "text/x-markdown" | "text/plain") {
        "markdown"
    } else if is_artifact_media_type(media_type) {
        "artifact"
    } else {
        "web"
    }
}

pub fn is_html_media(media_type: &str) -> bool {
    media_type == "text/html" || media_type == "application/xhtml+xml"
}

pub fn looks_like_pdf(bytes: &[u8]) -> bool {
    bytes.len() > 4 && &bytes[0..4] == b"%PDF"
}

pub fn is_pdf(bytes: &[u8], media_type: &str) -> bool {
    media_type == "application/pdf" || (media_type == "application/octet-stream" && looks_like_pdf(bytes))
}

pub fn media_type_for_name(name: &str) -> &'static str {
    let ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "md" | "markdown" => "text/markdown",
        "txt" => "text/plain",
        "html" | "htm" | "xhtml" => "text/html",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}

fn is_cjk(c: char) -> bool {
    matches!(
        c as u32,
        0x3400..=0x4DBF
            | 0x4E00..=0x9FFF
            | 0xF900..=0xFAFF
            | 0x20000..=0x2A6DF
            | 0x3040..=0x309F
            | 0x30A0..=0x30FF
            | 0xAC00..=0xD7AF
    )
}

fn is_cjk_punct(c: char) -> bool {
    matches!(c as u32, 0x2000..=0x206F | 0x3000..=0x303F | 0xFF00..=0xFFEF)
}

pub fn reading_minutes(text: &str) -> u32 {
    let mut cjk = 0usize;
    let mut rest = String::with_capacity(text.len());
    for c in text.chars() {
        if is_cjk(c) {
            cjk += 1;
            rest.push(' ');
        } else if is_cjk_punct(c) {
            rest.push(' ');
        } else {
            rest.push(c);
        }
    }
    let words = rest.split_whitespace().count();
    let mins = (words as f64 / 240.0 + cjk as f64 / 400.0).round();
    mins.max(1.0) as u32
}

pub fn valid_hex_16(s: &str) -> bool {
    s.len() == 16 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

// ---------------------------------------------------------------------------
// StoredRecord (on-disk JSON representation under materials/<id>.json)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredRecord {
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
    #[serde(default)]
    pub quality: ContentNormalizationQuality,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lineage: Option<Vec<String>>,
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
    pub media: Option<MediaInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capture: Option<CaptureInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub arxiv_version: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extracted: Option<MaterialMeta>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item_meta: Option<MaterialMeta>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub views: Option<Vec<MaterialView>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub primary_view: Option<String>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub time_anchors: Option<Vec<TranscriptAnchor>>,
    #[serde(default)]
    pub problems: Vec<NormalizationProblem>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artifact_source: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactRevision {
    pub version: u32,
    pub updated_at: String,
    pub title: String,
    pub source: String,
}

pub fn artifact_info_of(record: &StoredRecord) -> Option<ArtifactInfo> {
    if record.origin != "agent" {
        return None;
    }
    Some(record.artifact.clone().unwrap_or_else(|| ArtifactInfo {
        artifact_type: "markdown".into(),
        language: None,
        version: 1,
        updated_at: record.fetched_at.clone(),
    }))
}

pub fn artifact_source_of(record: &StoredRecord) -> Option<String> {
    record.artifact_source.clone().or_else(|| record.markdown.clone())
}

pub fn byline_of(creators: Option<&[Creator]>) -> Option<String> {
    let list = creators?;
    if list.is_empty() {
        return None;
    }
    let authors: Vec<&str> = list.iter().filter(|c| c.role == "author").map(|c| c.name.as_str()).collect();
    if !authors.is_empty() {
        return Some(authors.join(", "));
    }
    let editors: Vec<String> = list
        .iter()
        .filter(|c| c.role == "editor")
        .map(|c| format!("{} (ed.)", c.name))
        .collect();
    if !editors.is_empty() {
        return Some(editors.join(", "));
    }
    Some(list.iter().map(|c| c.name.as_str()).collect::<Vec<_>>().join(", "))
}

pub fn published_at_of(date: Option<&str>) -> Option<String> {
    let d = date?;
    if d.len() >= 11 && d.as_bytes()[10] == b'T' {
        return Some(d.to_string());
    }
    if d.len() == 10 && d.as_bytes()[4] == b'-' && d.as_bytes()[7] == b'-' {
        return Some(format!("{d}T00:00:00.000Z"));
    }
    None
}

fn creators_from_byline(byline: Option<&str>) -> Option<Vec<Creator>> {
    let raw = byline?.trim();
    if raw.is_empty() {
        return None;
    }
    let stripped = Regex::new(r"(?i)^\s*by\s+").unwrap().replace(raw, "");
    let split_re = Regex::new(r",|\band\b|&|·").unwrap();
    let list: Vec<Creator> = split_re
        .split(&stripped)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .take(50)
        .map(|name| Creator {
            role: "author".into(),
            name: name.to_string(),
            given: None,
            family: None,
        })
        .collect();
    if list.is_empty() {
        None
    } else {
        Some(list)
    }
}

pub fn fallback_extracted_for(record: &StoredRecord) -> MaterialMeta {
    let arxiv_from_url = Url::parse(&record.final_url).ok().and_then(|u| arxiv_id_of_url(&u));
    let mut meta = record.item_meta.clone().unwrap_or_default();
    if meta.title.is_none() && !record.title.is_empty() {
        meta.title = Some(record.title.clone());
    }
    if meta.creators.is_none() {
        meta.creators = creators_from_byline(record.byline.as_deref());
    }
    if meta.date.is_none() {
        meta.date = record.published_at.clone();
    }
    if meta.language.is_none() {
        meta.language = record.lang.clone();
    }
    if meta.arxiv_id.is_none() {
        meta.arxiv_id = arxiv_from_url;
    }
    let kind = if record.origin == "agent" {
        "note"
    } else if meta.arxiv_id.is_some() {
        "preprint"
    } else if let Some(k) = meta.kind.as_deref() {
        k
    } else if record.origin == "feed" {
        "blogPost"
    } else if record.media_type == "application/pdf" {
        "document"
    } else {
        "webpage"
    };
    meta.kind = Some(kind.into());
    meta.url = Some(record.final_url.clone());
    meta.accessed = Some(record.fetched_at.clone());
    meta
}

pub fn extracted_of(record: &StoredRecord) -> MaterialMeta {
    record.extracted.clone().unwrap_or_else(|| fallback_extracted_for(record))
}

pub fn apply_overrides(extracted: &MaterialMeta, overrides: Option<&MaterialMeta>) -> MaterialMeta {
    let Some(ov) = overrides else {
        return extracted.clone();
    };
    let mut base = serde_json::to_value(extracted).unwrap_or_else(|_| serde_json::json!({}));
    let ov_val = serde_json::to_value(ov).unwrap_or_else(|_| serde_json::json!({}));
    if let (Some(base_map), Some(ov_map)) = (base.as_object_mut(), ov_val.as_object()) {
        for (k, v) in ov_map {
            let empty = v.is_null()
                || v.as_str().is_some_and(str::is_empty)
                || v.as_array().is_some_and(Vec::is_empty);
            if !empty {
                base_map.insert(k.clone(), v.clone());
            }
        }
    }
    serde_json::from_value(base).unwrap_or_else(|_| extracted.clone())
}

pub fn primary_view_of(record: &StoredRecord) -> String {
    record
        .primary_view
        .clone()
        .unwrap_or_else(|| view_id_for_media_type(&record.media_type).to_string())
}

fn with_text_view(views: Vec<MaterialView>) -> Vec<MaterialView> {
    let has_text = views.iter().any(|v| v.id == "text");
    if !has_text {
        if let Some(pdf) = views.iter().find(|v| v.id == "pdf").cloned() {
            let mut next = views;
            next.push(MaterialView {
                id: "text".into(),
                label: view_label("text").into(),
                url: pdf.url,
                media_type: TEXT_VIEW_MEDIA_TYPE.into(),
                status: "available".into(),
                fetched_at: None,
                byte_length: None,
                pdf: None,
                error: None,
            });
            return next;
        }
    }
    views
}

pub fn views_of(record: &StoredRecord) -> Vec<MaterialView> {
    if let Some(v) = &record.views {
        if !v.is_empty() {
            return with_text_view(v.clone());
        }
    }
    let id = view_id_for_media_type(&record.media_type);
    let byte_length = record
        .pdf
        .as_ref()
        .map(|p| p.byte_length)
        .or_else(|| record.capture.as_ref().map(|c| c.byte_length));
    with_text_view(vec![MaterialView {
        id: id.into(),
        label: view_label(id).into(),
        url: record.final_url.clone(),
        media_type: record.media_type.clone(),
        status: "ready".into(),
        fetched_at: Some(record.fetched_at.clone()),
        byte_length,
        pdf: record.pdf.clone(),
        error: None,
    }])
}

pub fn with_primary_view(mut record: StoredRecord) -> StoredRecord {
    if record.views.as_ref().is_some_and(|v| !v.is_empty()) && record.primary_view.is_some() {
        return record;
    }
    let views = views_of(&record);
    let primary = primary_view_of(&record);
    record.views = Some(views);
    record.primary_view = Some(primary);
    record
}

pub fn upsert_view(views: &[MaterialView], view: MaterialView) -> Vec<MaterialView> {
    if views.iter().any(|v| v.id == view.id) {
        return views
            .iter()
            .map(|v| if v.id == view.id { view.clone() } else { v.clone() })
            .collect();
    }
    if view.id == "text" {
        let mut out = views.to_vec();
        out.push(view);
        out
    } else {
        let mut out: Vec<MaterialView> = views.iter().filter(|v| v.id != "text").cloned().collect();
        out.push(view);
        out.extend(views.iter().filter(|v| v.id == "text").cloned());
        out
    }
}

pub fn merge_views(previous: &StoredRecord, mut next: StoredRecord) -> StoredRecord {
    let primary = primary_view_of(&next);
    let prev_primary = primary_view_of(previous);
    let mut views = views_of(&next);
    for carried in views_of(previous) {
        if carried.id != primary && carried.id != prev_primary {
            views = upsert_view(&views, carried);
        }
    }
    next.views = Some(views);
    next.primary_view = Some(primary);
    next
}

pub fn primary_content_of(record: &StoredRecord) -> MaterialViewContent {
    let artifact_body = artifact_info_of(record).and_then(|info| {
        if matches!(info.artifact_type.as_str(), "html" | "svg" | "react" | "mermaid") {
            record.artifact_source.as_ref().map(|source| ArtifactBody {
                artifact_type: info.artifact_type,
                source: source.clone(),
                version: info.version,
            })
        } else {
            None
        }
    });
    MaterialViewContent {
        view: primary_view_of(record),
        media_type: record.media_type.clone(),
        pdf: record.pdf.clone(),
        reader: record.reader.clone(),
        markdown: record.markdown.clone(),
        plain: record.plain.clone(),
        reading_minutes: record.reading_minutes,
        quality: record.quality.clone(),
        problems: record.problems.clone(),
        anchors: None,
        time_anchors: record.time_anchors.clone(),
        artifact_body,
        report: None,
    }
}

pub fn effective_of(record: &StoredRecord, overrides: Option<MaterialMeta>) -> MaterialRecord {
    let extracted = extracted_of(record);
    let has_overrides = overrides
        .as_ref()
        .and_then(|ov| serde_json::to_value(ov).ok())
        .and_then(|v| v.as_object().map(|m| !m.is_empty()))
        .unwrap_or(false);
    let meta = apply_overrides(&extracted, overrides.as_ref());
    let byline = byline_of(meta.creators.as_deref());
    let published_at = published_at_of(meta.date.as_deref());
    let views = views_of(record);
    let ready_views: Vec<String> = views
        .iter()
        .filter(|v| v.status == "ready")
        .map(|v| v.id.clone())
        .collect();
    let artifact = artifact_info_of(record);
    MaterialRecord {
        id: record.id.clone(),
        url: record.url.clone(),
        final_url: record.final_url.clone(),
        title: meta.title.clone().unwrap_or_else(|| record.title.clone()),
        byline,
        published_at,
        fetched_at: record.fetched_at.clone(),
        reading_minutes: record.reading_minutes,
        origin: record.origin.clone(),
        media_type: record.media_type.clone(),
        quality: record.quality.clone(),
        lineage: record.lineage.clone(),
        tags: meta.tags.clone().unwrap_or_default(),
        kind: meta.kind.clone().unwrap_or_else(|| "webpage".into()),
        ready_views,
        publication: meta.publication.clone(),
        rebuilt_as: record.rebuilt_as.clone(),
        artifact,
        aliases: record.aliases.clone(),
        canonical_url: record.canonical_url.clone(),
        pdf: record.pdf.clone(),
        media: record.media.clone(),
        capture: record.capture.clone(),
        arxiv_version: record.arxiv_version,
        extracted,
        overrides: if has_overrides { overrides } else { None },
        meta,
        views,
        primary_view: primary_view_of(record),
        lang: record.lang.clone(),
        dir: record.dir.clone(),
        reader: record.reader.clone(),
        markdown: record.markdown.clone(),
        plain: record.plain.clone(),
        time_anchors: record.time_anchors.clone(),
        problems: record.problems.clone(),
        artifact_source: record.artifact_source.clone(),
    }
}

pub fn summary_of(record: &MaterialRecord) -> MaterialSummary {
    MaterialSummary {
        id: record.id.clone(),
        url: record.url.clone(),
        title: record.title.clone(),
        byline: record.byline.clone(),
        published_at: record.published_at.clone(),
        fetched_at: record.fetched_at.clone(),
        reading_minutes: record.reading_minutes,
        origin: record.origin.clone(),
        media_type: record.media_type.clone(),
        quality: record.quality.clone(),
        lineage: record.lineage.clone(),
        tags: record.tags.clone(),
        kind: record.kind.clone(),
        ready_views: record.ready_views.clone(),
        publication: record.meta.publication.clone(),
        rebuilt_as: record.rebuilt_as.clone(),
        artifact: record.artifact.clone(),
    }
}

pub fn search_fields_of(record: &MaterialRecord) -> String {
    let creators = record
        .meta
        .creators
        .as_deref()
        .unwrap_or(&[])
        .iter()
        .map(|c| c.name.as_str())
        .collect::<Vec<_>>()
        .join(" ");
    let tags = record.tags.join(" ");
    [
        Some(record.title.as_str()),
        if creators.is_empty() { None } else { Some(creators.as_str()) },
        record.meta.publication.as_deref(),
        record.meta.r#abstract.as_deref(),
        record.meta.doi.as_deref(),
        record.meta.arxiv_id.as_deref(),
        if tags.is_empty() { None } else { Some(tags.as_str()) },
    ]
    .into_iter()
    .flatten()
    .filter(|s| !s.is_empty())
    .collect::<Vec<_>>()
    .join("\n")
}

// ---------------------------------------------------------------------------
// IdentityIndex
// ---------------------------------------------------------------------------

fn url_names_of(record: &StoredRecord) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    let iter = std::iter::once(record.url.as_str())
        .chain(std::iter::once(record.final_url.as_str()))
        .chain(record.aliases.as_deref().unwrap_or(&[]).iter().map(String::as_str));
    for raw in iter {
        if let Ok(u) = Url::parse(raw) {
            if u.scheme() == "http" || u.scheme() == "https" {
                let can = canonical_url_of(&u);
                if seen.insert(can.clone()) {
                    out.push(can);
                }
            }
        }
    }
    out
}

pub fn identity_keys_of(record: &StoredRecord) -> Vec<String> {
    let mut keys: Vec<String> = url_names_of(record).into_iter().map(|u| format!("url:{u}")).collect();
    if let Some(can) = &record.canonical_url {
        keys.push(format!("canonical:{can}"));
    }
    let ext = extracted_of(record);
    if let Some(doi) = &ext.doi {
        keys.push(format!("doi:{doi}"));
    }
    if let Some(arxiv) = &ext.arxiv_id {
        keys.push(format!("arxiv:{arxiv}"));
    }
    keys
}

pub fn request_keys_of(url: &Url) -> Vec<String> {
    let named = canonical_url_of(url);
    let mut keys = vec![format!("url:{named}"), format!("canonical:{named}")];
    if let Some(arxiv) = arxiv_id_of_url(url) {
        keys.push(format!("arxiv:{arxiv}"));
    }
    keys
}

pub fn with_aliases(mut record: StoredRecord, urls: &[String]) -> StoredRecord {
    let mut existing: HashSet<String> = url_names_of(&record).into_iter().collect();
    if let Some(can) = &record.canonical_url {
        existing.insert(can.clone());
    }
    let mut added = Vec::new();
    for raw in urls {
        if let Ok(u) = Url::parse(raw) {
            if u.scheme() == "http" || u.scheme() == "https" {
                let can = canonical_url_of(&u);
                if existing.insert(can.clone()) {
                    added.push(can);
                }
            }
        }
    }
    if !added.is_empty() {
        let mut list = record.aliases.unwrap_or_default();
        list.extend(added);
        record.aliases = Some(list);
    }
    record
}

pub fn with_names_of(previous: &StoredRecord, record: StoredRecord) -> StoredRecord {
    let mut urls = vec![previous.url.clone(), previous.final_url.clone()];
    if let Some(a) = &previous.aliases {
        urls.extend(a.clone());
    }
    with_aliases(record, &urls)
}

#[derive(Default)]
struct IdentityIndex {
    ids: HashMap<String, Vec<String>>,
    indexed: bool,
}

impl IdentityIndex {
    fn add(&mut self, record: &StoredRecord) {
        for key in identity_keys_of(record) {
            let entry = self.ids.entry(key).or_default();
            if !entry.contains(&record.id) {
                entry.push(record.id.clone());
            }
        }
    }

    fn remove(&mut self, id: &str) {
        self.ids.retain(|_, list| {
            list.retain(|x| x != id);
            !list.is_empty()
        });
    }

    fn candidates(&self, key: &str) -> Vec<String> {
        self.ids.get(key).cloned().unwrap_or_default()
    }
}

// ---------------------------------------------------------------------------
// Image URL extraction (matching material-content.ts)
// ---------------------------------------------------------------------------

pub fn reader_image_urls(reader: Option<&ReaderPayload>, limit: usize) -> Option<Vec<String>> {
    let r = reader?;
    let root: serde_json::Value = serde_json::from_str(&r.payload).ok()?;
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    fn visit(node: &serde_json::Value, limit: usize, seen: &mut HashSet<String>, out: &mut Vec<String>) {
        if out.len() >= limit {
            return;
        }
        match node {
            serde_json::Value::Array(arr) => {
                for item in arr {
                    visit(item, limit, seen, out);
                }
            }
            serde_json::Value::Object(map) => {
                if map.get("type").and_then(|v| v.as_str()) == Some("image") {
                    if let Some(url) = map.get("url").and_then(|v| v.as_str()) {
                        if (url.starts_with("http://") || url.starts_with("https://") || url.starts_with("data:"))
                            && seen.insert(url.to_string())
                        {
                            out.push(url.to_string());
                        }
                    }
                }
                for val in map.values() {
                    visit(val, limit, seen, out);
                }
            }
            _ => {}
        }
    }
    visit(&root, limit, &mut seen, &mut out);
    Some(out)
}

pub fn image_urls_of_record(record: &MaterialRecord) -> Vec<String> {
    reader_image_urls(record.reader.as_ref(), 80).unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Artifacts helpers
// ---------------------------------------------------------------------------

pub fn without_title_heading(markdown: &str, title: &str) -> String {
    let re = Regex::new(r"^\s*#\s+(.+?)\s*\n").unwrap();
    let Some(caps) = re.captures(markdown) else {
        return markdown.to_string();
    };
    let same = |s: &str| s.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase();
    if same(caps.get(1).map(|m| m.as_str()).unwrap_or("")) == same(title) {
        let rest = &markdown[caps.get(0).unwrap().end()..];
        Regex::new(r"^\s*\n").unwrap().replace(rest, "").to_string()
    } else {
        markdown.to_string()
    }
}

fn text_of_markup(source: &str) -> String {
    let comments = Regex::new(r"(?s)<!--.*?-->").unwrap().replace_all(source, " ");
    let scripts = Regex::new(r"(?is)<(?:script|style|template)\b.*?</(?:script|style|template)\s*>")
        .unwrap()
        .replace_all(&comments, " ");
    let tags = Regex::new(r"<[^>]+>").unwrap().replace_all(&scripts, " ");
    tags.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&nbsp;", " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn text_of_component(source: &str) -> String {
    let jsx_re = Regex::new(r">([^<>{}]+)<").unwrap();
    let mut words: Vec<String> = jsx_re
        .captures_iter(source)
        .filter_map(|c| c.get(1).map(|m| m.as_str().to_string()))
        .collect();
    for quote in ['"', '\'', '`'] {
        let pat = format!(r#"{quote}((?:[^\\{quote}\n]|\\.){{3,}}){quote}"#);
        if let Ok(str_re) = Regex::new(&pat) {
            let class_tok = Regex::new(r"^[a-z0-9:./@#%\[\]-]*$").unwrap();
            for cap in str_re.captures_iter(source) {
                if let Some(m) = cap.get(1) {
                    let txt = m.as_str();
                    let has_letters = txt.chars().filter(|c| c.is_alphabetic()).count() >= 2;
                    let all_tokens_code = txt.split_whitespace().all(|tok| class_tok.is_match(tok));
                    if has_letters && !all_tokens_code {
                        words.push(txt.to_string());
                    }
                }
            }
        }
    }
    words.join(" ").split_whitespace().collect::<Vec<_>>().join(" ")
}

pub fn apply_artifact_edit(source: &str, old_text: &str, new_text: &str) -> Result<String, String> {
    if old_text.is_empty() {
        return Err("old_str must not be empty.".into());
    }
    let Some(first) = source.find(old_text) else {
        return Err("old_str does not occur in the artifact. Read it again with material_read and copy the passage exactly, whitespace included.".into());
    };
    if source[first + old_text.len()..].contains(old_text) {
        return Err("old_str occurs more than once in the artifact. Include more of the surrounding text so it is unique.".into());
    }
    let mut out = String::with_capacity(source.len() - old_text.len() + new_text.len());
    out.push_str(&source[..first]);
    out.push_str(new_text);
    out.push_str(&source[first + old_text.len()..]);
    Ok(out)
}

// ---------------------------------------------------------------------------
// FigureStore & AnnotationStore
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FigureRef {
    pub material_id: String,
    pub index: u32,
}

pub fn parse_figure_url(url: &str) -> Option<FigureRef> {
    let re = Regex::new(r"^quire-figure://([a-f0-9]{16})/([1-9]\d{0,3})\.png$").unwrap();
    let caps = re.captures(url)?;
    Some(FigureRef {
        material_id: caps.get(1)?.as_str().to_string(),
        index: caps.get(2)?.as_str().parse::<u32>().ok()?,
    })
}

#[derive(Clone)]
pub struct FigureStore {
    root: PathBuf,
}

impl FigureStore {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    fn dir_of(&self, material_id: &str) -> PathBuf {
        self.root.join("figures").join(material_id)
    }

    fn path_of(&self, r: &FigureRef) -> PathBuf {
        self.dir_of(&r.material_id).join(format!("{}.png", r.index))
    }

    pub fn write(&self, material_id: &str, index: u32, png: &[u8]) -> Result<String, String> {
        let dir = self.dir_of(material_id);
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        fs::write(dir.join(format!("{index}.png")), png).map_err(|e| e.to_string())?;
        Ok(format!("quire-figure://{material_id}/{index}.png"))
    }

    pub fn has(&self, r: &FigureRef) -> bool {
        self.path_of(r).is_file()
    }

    pub fn bytes(&self, r: &FigureRef) -> Result<Option<Vec<u8>>, String> {
        match fs::read(self.path_of(r)) {
            Ok(b) => Ok(Some(b)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    pub fn remove(&self, material_id: &str) -> Result<(), String> {
        match fs::remove_dir_all(self.dir_of(material_id)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

#[derive(Clone)]
pub struct AnnotationStore {
    root: PathBuf,
}

#[derive(Serialize, Deserialize)]
struct AnnotationFile {
    annotations: Vec<Annotation>,
}

impl AnnotationStore {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    fn dir(&self) -> PathBuf {
        self.root.join("annotations")
    }

    fn path(&self, material_id: &str) -> PathBuf {
        self.dir().join(format!("{material_id}.json"))
    }

    pub fn list(&self, material_id: &str) -> Result<Vec<Annotation>, String> {
        if !valid_hex_16(material_id) {
            return Err("ANNOTATION_INVALID_MATERIAL".into());
        }
        match fs::read_to_string(self.path(material_id)) {
            Ok(raw) => {
                let parsed: AnnotationFile = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
                Ok(parsed.annotations)
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
            Err(e) => Err(e.to_string()),
        }
    }

    pub fn save(&self, mut input: Annotation) -> Result<Annotation, String> {
        if !valid_hex_16(&input.material_id) || !valid_hex_16(&input.id) {
            return Err("ANNOTATION_INVALID_ID".into());
        }
        if let Some(v) = &input.view {
            if !is_material_view_id(v) {
                return Err("ANNOTATION_INVALID_VIEW".into());
            }
        }
        if input.locator.is_empty() || input.locator.chars().count() > 20_000 {
            return Err("ANNOTATION_INVALID_LOCATOR".into());
        }
        if input.quote.chars().count() > 20_000
            || input.note.as_deref().unwrap_or("").chars().count() > 20_000
        {
            return Err("ANNOTATION_INVALID_TEXT".into());
        }
        let mut existing = self.list(&input.material_id)?;
        let now = now_iso();
        let prev_idx = existing.iter().position(|a| a.id == input.id);
        if prev_idx.is_none() && existing.len() >= 2_000 {
            return Err("ANNOTATION_LIMIT".into());
        }
        input.created_at = prev_idx
            .map(|i| existing[i].created_at.clone())
            .unwrap_or_else(|| now.clone());
        input.updated_at = now;
        if let Some(i) = prev_idx {
            existing[i] = input.clone();
        } else {
            existing.push(input.clone());
        }
        self.write(&input.material_id, &existing)?;
        Ok(input)
    }

    pub fn delete(&self, material_id: &str, id: &str) -> Result<(), String> {
        let existing = self.list(material_id)?;
        let next: Vec<Annotation> = existing.into_iter().filter(|a| a.id != id).collect();
        if next.is_empty() {
            let _ = fs::remove_file(self.path(material_id));
            return Ok(());
        }
        self.write(material_id, &next)
    }

    pub fn delete_all(&self, material_id: &str) -> Result<(), String> {
        if !valid_hex_16(material_id) {
            return Err("ANNOTATION_INVALID_MATERIAL".into());
        }
        match fs::remove_file(self.path(material_id)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }

    fn write(&self, material_id: &str, annotations: &[Annotation]) -> Result<(), String> {
        fs::create_dir_all(self.dir()).map_err(|e| e.to_string())?;
        let json = serde_json::to_string_pretty(&AnnotationFile {
            annotations: annotations.to_vec(),
        })
        .map_err(|e| e.to_string())?;
        fs::write(self.path(material_id), json).map_err(|e| e.to_string())
    }
}

// ---------------------------------------------------------------------------
// MaterialStore
// ---------------------------------------------------------------------------

pub struct SaveArtifactInput {
    pub title: String,
    pub artifact_type: Option<String>,
    pub source: Option<String>,
    pub markdown: Option<String>,
    pub language: Option<String>,
    pub lineage: Vec<String>,
}

pub struct UpdateArtifactChange {
    pub source: Option<String>,
    pub edit: Option<(String, String)>,
    pub title: Option<String>,
    pub lineage: Option<Vec<String>>,
}

pub struct FeedMaterialInput {
    pub url: String,
    pub title: String,
    pub byline: Option<String>,
    pub published_at: Option<String>,
    pub lang: Option<String>,
    pub meta: Option<MaterialMeta>,
    pub content: ItemContent,
}

pub struct PodcastEpisodeInput {
    pub id: String,
    pub url: String,
    pub page_url: Option<String>,
    pub stream_url: String,
    pub title: String,
    pub published_at: Option<String>,
    pub duration_sec: Option<u32>,
    pub lang: Option<String>,
    pub transcripts: Vec<TranscriptTrackRef>,
    pub chapters_url: Option<String>,
    pub chapters: Vec<MediaChapter>,
    pub shownotes_content: Option<ItemContent>,
    pub shownotes_markdown: Option<String>,
    pub meta: Option<MaterialMeta>,
}

fn detect_html_audio_stream(bytes: &[u8]) -> Option<String> {
    let head = String::from_utf8_lossy(&bytes[..bytes.len().min(512 * 1024)]);
    let audio_tag = Regex::new(r#"(?i)<audio\b[^>]*\bsrc\s*=\s*["'](https?://[^"']+)["']"#).unwrap();
    if let Some(m) = audio_tag.captures(&head).and_then(|c| c.get(1)) {
        if let Ok(u) = assert_public_http_url(m.as_str()) {
            return Some(u.to_string());
        }
    }
    let source_tag = Regex::new(
        r#"(?i)<source\b[^>]*?(?:\bsrc\s*=\s*["'](https?://[^"']+)["'][^>]*?\btype\s*=\s*["']audio/|\btype\s*=\s*["']audio/[^"']*["'][^>]*?\bsrc\s*=\s*["'](https?://[^"']+)["'])"#,
    )
    .unwrap();
    if let Some(caps) = source_tag.captures(&head) {
        if let Some(m) = caps.get(1).or_else(|| caps.get(2)) {
            if let Ok(u) = assert_public_http_url(m.as_str()) {
                return Some(u.to_string());
            }
        }
    }
    let json_audio = Regex::new(r#""audio_url"\s*:\s*"(https?:[^"]+)""#).unwrap();
    if let Some(m) = json_audio.captures(&head).and_then(|c| c.get(1)) {
        let unescaped = m
            .as_str()
            .replace("\\/", "/")
            .replace("\\u0026", "&");
        if let Ok(u) = assert_public_http_url(&unescaped) {
            return Some(u.to_string());
        }
    }
    None
}

pub struct MaterialStore {
    root: PathBuf,
    http: reqwest::Client,
    meta: MetaStore,
    normalizer: Arc<dyn Normalizer>,
    keep_capture: Arc<dyn Fn() -> bool + Send + Sync>,
    reflow_judge: Arc<dyn Fn() -> Result<(String, Option<String>), String> + Send + Sync>,
    youtube_cookies: Arc<dyn Fn() -> Option<String> + Send + Sync>,
    figures: FigureStore,
    identities: Mutex<IdentityIndex>,
}

fn is_unreadable_page(record: &StoredRecord) -> bool {
    record.quality.safety == "degraded_plaintext"
}

fn is_feed_copy(record: &StoredRecord) -> bool {
    record.problems.iter().any(|p| p.code == "FEED_CONTENT_FALLBACK")
}

fn is_fallback_copy(record: &StoredRecord) -> bool {
    is_unreadable_page(record) || is_feed_copy(record)
}

fn is_single_paragraph_reader(reader: &Option<ReaderPayload>) -> bool {
    let Some(ref rp) = reader else {
        return true;
    };
    let Ok(val) = serde_json::from_str::<serde_json::Value>(&rp.payload) else {
        return true;
    };
    let Some(children) = val.get("children").and_then(|c| c.as_array()) else {
        return true;
    };
    if children.is_empty() {
        return true;
    }
    let has_rich = children.iter().any(|c| {
        matches!(
            c.get("type").and_then(|t| t.as_str()),
            Some("heading" | "list" | "blockquote" | "table")
        )
    });
    !has_rich && children.len() <= 1
}

fn is_legacy_collapsed_shownotes(record: &StoredRecord) -> bool {
    let is_absent_tx = record
        .media
        .as_ref()
        .is_some_and(|m| m.transcript_origin == "absent");
    if !is_absent_tx || primary_view_of(record) != "shownotes" {
        return false;
    }
    let t = record.title.trim();
    if t.eq_ignore_ascii_case("- youtube")
        || t.eq_ignore_ascii_case("youtube")
        || t.starts_with("YouTube video ")
    {
        return true;
    }
    if record.media.as_ref().is_some_and(|m| m.provider == "youtube")
        && record.byline.is_none()
        && record.plain.as_deref() == Some("No video description was provided.")
    {
        return true;
    }
    let text_len = record
        .markdown
        .as_deref()
        .or(record.plain.as_deref())
        .map_or(0, |s| s.chars().count());
    text_len >= 80 && is_single_paragraph_reader(&record.reader)
}

fn normalize_episode_title_key(raw: &str) -> String {
    raw.replace('｜', "|")
        .replace('：', ":")
        .replace('\u{00a0}', " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn audio_asset_stem(url_str: &str) -> Option<String> {
    let parsed = Url::parse(url_str).ok()?;
    let last = parsed.path_segments()?.next_back()?;
    let stem = last
        .rsplit_once('.')
        .map(|(s, _)| s)
        .unwrap_or(last)
        .trim()
        .to_ascii_lowercase();
    if stem.len() >= 12 {
        Some(stem)
    } else {
        None
    }
}

fn podcast_episode_matches(
    item_enclosure: Option<&str>,
    item_title: &str,
    ep_stream: &str,
    ep_title: &str,
) -> bool {
    if let Some(enc) = item_enclosure {
        if enc == ep_stream {
            return true;
        }
        if let (Ok(u1), Ok(u2)) = (Url::parse(enc), Url::parse(ep_stream)) {
            if u1.host_str() == u2.host_str() && u1.path() == u2.path() {
                return true;
            }
        }
        if let (Some(s1), Some(s2)) = (audio_asset_stem(enc), audio_asset_stem(ep_stream)) {
            if s1 == s2 {
                return true;
            }
        }
    }
    let t1 = normalize_episode_title_key(item_title);
    let t2 = normalize_episode_title_key(ep_title);
    !t1.is_empty() && t1 == t2
}

impl MaterialStore {
    pub fn new(
        root: impl Into<PathBuf>,
        http: reqwest::Client,
        meta: MetaStore,
        normalizer: Arc<dyn Normalizer>,
        keep_capture: Arc<dyn Fn() -> bool + Send + Sync>,
        reflow_judge: Arc<dyn Fn() -> Result<(String, Option<String>), String> + Send + Sync>,
    ) -> Self {
        let root_path = root.into();
        let figures = FigureStore::new(&root_path);
        Self {
            root: root_path,
            http,
            meta,
            normalizer,
            keep_capture,
            reflow_judge,
            youtube_cookies: Arc::new(|| None),
            figures,
            identities: Mutex::new(IdentityIndex::default()),
        }
    }

    pub fn with_youtube_cookies(
        mut self,
        provider: Arc<dyn Fn() -> Option<String> + Send + Sync>,
    ) -> Self {
        self.youtube_cookies = provider;
        self
    }

    pub fn dir(&self) -> PathBuf {
        self.root.join("materials")
    }

    fn pdf_path(&self, id: &str) -> PathBuf {
        self.dir().join(format!("{id}.pdf"))
    }

    fn html_path(&self, id: &str) -> PathBuf {
        self.dir().join(format!("{id}.html"))
    }

    fn view_content_path(&self, id: &str, view: &str) -> PathBuf {
        self.dir().join(format!("{id}.{view}.json"))
    }

    fn view_pdf_path(&self, id: &str, view: &str) -> PathBuf {
        self.dir().join(format!("{id}.{view}.pdf"))
    }

    fn revision_path(&self, id: &str, version: u32) -> PathBuf {
        self.dir().join(format!("{id}.rev{version}.json"))
    }

    fn read_optional(&self, path: &Path) -> Result<Option<Vec<u8>>, String> {
        match fs::read(path) {
            Ok(b) => Ok(Some(b)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    pub fn has(&self, id: &str) -> bool {
        valid_hex_16(id) && self.dir().join(format!("{id}.json")).is_file()
    }

    pub fn read_stored(&self, id: &str) -> Result<Option<StoredRecord>, String> {
        if !valid_hex_16(id) {
            return Ok(None);
        }
        let Some(bytes) = self.read_optional(&self.dir().join(format!("{id}.json")))? else {
            return Ok(None);
        };
        serde_json::from_slice(&bytes).map(Some).map_err(|e| e.to_string())
    }

    fn require_stored(&self, id: &str) -> Result<StoredRecord, String> {
        self.read_stored(id)?
            .ok_or_else(|| format!("Material {id} is not in the library."))
    }

    fn save_stored(&self, record: StoredRecord) -> Result<StoredRecord, String> {
        let stored = with_primary_view(record);
        fs::create_dir_all(self.dir()).map_err(|e| e.to_string())?;
        let json = serde_json::to_string(&stored).map_err(|e| e.to_string())?;
        fs::write(self.dir().join(format!("{}.json", stored.id)), json).map_err(|e| e.to_string())?;
        if let Ok(mut idx) = self.identities.lock() {
            idx.add(&stored);
        }
        Ok(stored)
    }

    fn decorate(&self, record: &StoredRecord) -> Result<MaterialRecord, String> {
        let overrides = self.meta.get(&record.id)?;
        let mut mat = effective_of(record, overrides);
        if let Some(ref mut media) = mat.media {
            media.cached_bytes = cached_media_info(&self.root, &record.id).map(|(_, _, len)| len);
        }
        Ok(mat)
    }

    pub fn get(&self, id: &str) -> Result<Option<MaterialRecord>, String> {
        match self.read_stored(id)? {
            Some(s) => self.decorate(&s).map(Some),
            None => Ok(None),
        }
    }

    fn ensure_indexed(&self) -> Result<(), String> {
        let mut idx = self.identities.lock().map_err(|_| "Identity lock poisoned".to_string())?;
        if idx.indexed {
            return Ok(());
        }
        fs::create_dir_all(self.dir()).map_err(|e| e.to_string())?;
        let entries = fs::read_dir(self.dir()).map_err(|e| e.to_string())?;
        for entry in entries {
            let entry = entry.map_err(|e| e.to_string())?;
            let name = entry.file_name().to_string_lossy().to_string();
            if name.len() == 21 && name.ends_with(".json") && valid_hex_16(&name[..16]) {
                let bytes = fs::read(entry.path()).map_err(|e| e.to_string())?;
                let record: StoredRecord = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
                idx.add(&record);
            }
        }
        idx.indexed = true;
        Ok(())
    }

    fn read_by_url(&self, url: &Url) -> Result<Option<StoredRecord>, String> {
        for id in stored_ids_of(url) {
            if let Some(rec) = self.read_stored(&id)? {
                return Ok(Some(rec));
            }
        }
        Ok(None)
    }

    fn lookup_keys(&self, keys: &[String]) -> Result<Option<StoredRecord>, String> {
        self.ensure_indexed()?;
        for key in keys {
            let candidates = {
                let idx = self.identities.lock().map_err(|_| "Identity lock poisoned".to_string())?;
                idx.candidates(key)
            };
            let mut named = Vec::new();
            for id in candidates {
                if let Some(rec) = self.read_stored(&id)? {
                    if identity_keys_of(&rec).contains(key) {
                        named.push(rec);
                    }
                }
            }
            if !named.is_empty() {
                named.sort_by(|a, b| a.fetched_at.cmp(&b.fetched_at));
                return Ok(named.into_iter().next());
            }
        }
        Ok(None)
    }

    pub fn find_by_url(&self, url: &Url) -> Result<Option<StoredRecord>, String> {
        if let Some(rec) = self.read_by_url(url)? {
            return Ok(Some(rec));
        }
        self.lookup_keys(&request_keys_of(url))
    }

    async fn existing_result(
        &self,
        record: StoredRecord,
        item: Option<&MaterialMeta>,
        urls: &[String],
    ) -> Result<OpenUrlResult, String> {
        let mut named = with_aliases(record.clone(), urls);
        let mut changed = serde_json::to_string(&named).ok() != serde_json::to_string(&record).ok();
        if let Some(item_meta) = item {
            let mut merged_item = named.item_meta.clone().unwrap_or_default();
            merged_item = apply_overrides(&merged_item, Some(item_meta));
            if serde_json::to_string(&Some(&merged_item)).ok() != serde_json::to_string(&named.item_meta).ok() {
                named.item_meta = Some(merged_item.clone());
                let page_bytes = if is_html_media(&named.media_type) {
                    self.read_optional(&self.html_path(&named.id))?
                } else {
                    None
                };
                if let Ok(ext) = self
                    .normalizer
                    .extract_meta(ExtractMetaInput {
                        html_base64: page_bytes
                            .as_ref()
                            .map(|b| base64::engine::general_purpose::STANDARD.encode(b)),
                        url: named.final_url.clone(),
                        media_type: named.media_type.clone(),
                        origin: named.origin.clone(),
                        fetched_at: Some(named.fetched_at.clone()),
                        fallback_title: Some(named.title.clone()),
                        fallback_byline: named.byline.clone(),
                        fallback_published_at: named.published_at.clone(),
                        fallback_lang: named.lang.clone(),
                        item: Some(merged_item),
                    })
                    .await
                {
                    named.extracted = Some(ext.meta);
                    if page_bytes.is_some() {
                        named.canonical_url = ext.canonical_url;
                    }
                } else {
                    named.extracted = Some(fallback_extracted_for(&named));
                }
                changed = true;
            }
        }
        let saved = if changed { self.save_stored(named)? } else { record };
        Ok(OpenUrlResult::success(self.decorate(&saved)?, true))
    }

    pub async fn open_url(
        &self,
        raw: &str,
        origin: &str,
        item: Option<MaterialMeta>,
    ) -> OpenUrlResult {
        match self.open_url_inner(raw, origin, item).await {
            Ok(res) => res,
            Err((code, msg)) => OpenUrlResult::failure(code, msg),
        }
    }

    async fn open_url_inner(
        &self,
        raw: &str,
        origin: &str,
        item: Option<MaterialMeta>,
    ) -> Result<OpenUrlResult, (String, String)> {
        let url = assert_public_http_url(raw).map_err(|e| (e.code, e.message))?;
        let known = self.find_by_url(&url).map_err(|e| ("NORMALIZE_FAILED".into(), e))?;
        if let Some(ref k) = known {
            if !is_fallback_copy(k) && !is_legacy_collapsed_shownotes(k) {
                return self
                    .existing_result(k.clone(), item.as_ref(), &[raw.to_string()])
                    .await
                    .map_err(|e| ("NORMALIZE_FAILED".into(), e));
            }
        }
        if let Some(apple_ep) = resolve_apple_podcast_episode(&self.http, url.as_str())
            .await
            .map_err(|e| (e.code, e.message))?
        {
            return self.open_apple_episode(apple_ep, origin, item).await;
        }
        if let Some(video_id) = crate::youtube::parse_youtube_video_id(url.as_str()) {
            return self.open_youtube_video(&video_id, raw, origin, None, item).await;
        }
        if is_audio_stream_url(&url) {
            let id = material_id_of(&url);
            let title = url
                .path_segments()
                .and_then(|s| s.last())
                .map(String::from)
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "Audio episode".into());
            let rec = self
                .materialize_podcast_episode(
                    PodcastEpisodeInput {
                        id,
                        url: url.to_string(),
                        page_url: None,
                        stream_url: url.to_string(),
                        title,
                        published_at: None,
                        duration_sec: None,
                        lang: None,
                        transcripts: Vec::new(),
                        chapters_url: None,
                        chapters: Vec::new(),
                        shownotes_content: None,
                        shownotes_markdown: None,
                        meta: item,
                    },
                    origin,
                )
                .await?;
            let saved = self.save_stored(rec).map_err(|e| ("NORMALIZE_FAILED".into(), e))?;
            return Ok(OpenUrlResult::success(
                self.decorate(&saved).map_err(|e| ("NORMALIZE_FAILED".into(), e))?,
                false,
            ));
        }
        let page = fetch_page(&self.http, &url, PAGE_ACCEPT)
            .await
            .map_err(|e| (e.code, e.message))?;
        let final_url = Url::parse(&page.final_url)
            .map_err(|_| ("URL_INVALID".into(), "Invalid final URL.".into()))?;

        let mut page_keys = request_keys_of(&final_url);
        if !is_pdf(&page.bytes, &page.media_type) && is_html_media(&page.media_type) {
            let head_slice = &page.bytes[..page.bytes.len().min(256 * 1024)];
            if let Ok(ext) = self
                .normalizer
                .extract_meta(ExtractMetaInput {
                    html_base64: Some(base64::engine::general_purpose::STANDARD.encode(head_slice)),
                    url: page.final_url.clone(),
                    media_type: page.media_type.clone(),
                    origin: origin.to_string(),
                    fetched_at: None,
                    fallback_title: None,
                    fallback_byline: None,
                    fallback_published_at: None,
                    fallback_lang: None,
                    item: item.clone(),
                })
                .await
            {
                if let Some(can) = &ext.canonical_url {
                    page_keys.push(format!("url:{can}"));
                }
                if let Some(doi) = &ext.meta.doi {
                    page_keys.push(format!("doi:{doi}"));
                }
                if let Some(arxiv) = &ext.meta.arxiv_id {
                    page_keys.push(format!("arxiv:{arxiv}"));
                }
            }
        }

        let previous = self
            .read_by_url(&final_url)
            .map_err(|e| ("NORMALIZE_FAILED".into(), e))?
            .or(self.lookup_keys(&page_keys).map_err(|e| ("NORMALIZE_FAILED".into(), e))?)
            .or(known);

        if let Some(ref prev) = previous {
            if !is_fallback_copy(prev) {
                return self
                    .existing_result(prev.clone(), item.as_ref(), &[raw.to_string(), page.final_url.clone()])
                    .await
                    .map_err(|e| ("NORMALIZE_FAILED".into(), e));
            }
        }

        let id = previous
            .as_ref()
            .map(|p| p.id.clone())
            .unwrap_or_else(|| material_id_of(&final_url));
        let item_meta = match (previous.as_ref().and_then(|p| p.item_meta.as_ref()), item.as_ref()) {
            (Some(prev_m), Some(new_m)) => Some(apply_overrides(prev_m, Some(new_m))),
            (Some(prev_m), None) => Some(prev_m.clone()),
            (None, Some(new_m)) => Some(new_m.clone()),
            (None, None) => None,
        };

        let record = self
            .materialize_any(&page.bytes, &page.media_type, &page.final_url, raw, origin, &id, item_meta)
            .await?;

        if let Some(prev) = previous {
            if is_feed_copy(&prev) && is_unreadable_page(&record) {
                let _ = fs::remove_file(self.html_path(&id));
                return self
                    .existing_result(prev, item.as_ref(), &[raw.to_string(), page.final_url])
                    .await
                    .map_err(|e| ("NORMALIZE_FAILED".into(), e));
            }
            let merged = with_names_of(&prev, merge_views(&prev, record));
            let saved = self.save_stored(merged).map_err(|e| ("NORMALIZE_FAILED".into(), e))?;
            return Ok(OpenUrlResult::success(
                self.decorate(&saved).map_err(|e| ("NORMALIZE_FAILED".into(), e))?,
                false,
            ));
        }

        let saved = self.save_stored(record).map_err(|e| ("NORMALIZE_FAILED".into(), e))?;
        Ok(OpenUrlResult::success(
            self.decorate(&saved).map_err(|e| ("NORMALIZE_FAILED".into(), e))?,
            false,
        ))
    }

    pub async fn open_file(&self, name: &str, media_type: &str, bytes: &[u8]) -> OpenUrlResult {
        let hash = sha256_hex(bytes);
        let id = hash[..16].to_string();
        match self.read_stored(&id) {
            Ok(Some(known)) => match self.decorate(&known) {
                Ok(mat) => return OpenUrlResult::success(mat, true),
                Err(e) => return OpenUrlResult::failure("NORMALIZE_FAILED", e),
            },
            Err(e) => return OpenUrlResult::failure("NORMALIZE_FAILED", e),
            Ok(None) => {}
        }
        let safe_name: String = name
            .chars()
            .map(|c| if c == '/' || c == '\\' { '_' } else { c })
            .take(200)
            .collect();
        let clean_name = if safe_name.is_empty() { "file" } else { safe_name.as_str() };
        let resolved_media = if media_type.is_empty() {
            media_type_for_name(clean_name)
        } else {
            media_type
        };
        let encoded: String = url::form_urlencoded::byte_serialize(clean_name.as_bytes()).collect();
        let locator = format!("https://file.local/{encoded}");
        let file_url = format!("file:///{encoded}");
        match self
            .materialize_any(bytes, resolved_media, &locator, &file_url, "file", &id, None)
            .await
        {
            Ok(rec) => match self.save_stored(rec).and_then(|s| self.decorate(&s)) {
                Ok(mat) => OpenUrlResult::success(mat, false),
                Err(e) => OpenUrlResult::failure("NORMALIZE_FAILED", e),
            },
            Err((code, msg)) => OpenUrlResult::failure(code, msg),
        }
    }

    async fn materialize_any(
        &self,
        bytes: &[u8],
        media_type: &str,
        final_url: &str,
        requested_url: &str,
        origin: &str,
        id: &str,
        item_meta: Option<MaterialMeta>,
    ) -> Result<StoredRecord, (String, String)> {
        let mut record = self
            .materialize_bytes(bytes, media_type, final_url, requested_url, origin, id, item_meta)
            .await?;
        if let Some(arxiv_id) = record.extracted.as_ref().and_then(|e| e.arxiv_id.clone()) {
            if let Ok(u) = Url::parse(&record.final_url) {
                if arxiv_id_of_url(&u).as_deref() == Some(arxiv_id.as_str()) {
                    let text = if record.media_type == "application/pdf" {
                        record.plain.clone().unwrap_or_default()
                    } else {
                        String::from_utf8_lossy(bytes).to_string()
                    };
                    record.arxiv_version = arxiv_rendering_version(
                        &arxiv_id,
                        &[record.final_url.as_str(), record.url.as_str()],
                        &text,
                    );
                }
            }
        }
        Ok(record)
    }

    async fn materialize_bytes(
        &self,
        bytes: &[u8],
        media_type: &str,
        final_url: &str,
        requested_url: &str,
        origin: &str,
        id: &str,
        item_meta: Option<MaterialMeta>,
    ) -> Result<StoredRecord, (String, String)> {
        let fetched_at = now_iso();
        if is_pdf(bytes, media_type) {
            let inspection = self
                .normalizer
                .inspect_pdf(bytes)
                .await
                .map_err(|e| ("PDF_INVALID".into(), e))?;
            fs::create_dir_all(self.dir()).map_err(|e| ("NORMALIZE_FAILED".into(), e.to_string()))?;
            fs::write(self.pdf_path(id), bytes).map_err(|e| ("NORMALIZE_FAILED".into(), e.to_string()))?;
            let parsed_url = Url::parse(final_url).ok();
            let file_name = parsed_url
                .as_ref()
                .and_then(|u| u.path_segments()?.last())
                .map(|s| s.trim_end_matches(".pdf").trim_end_matches(".PDF").to_string())
                .filter(|s| !s.is_empty());
            let host = parsed_url
                .as_ref()
                .and_then(|u| u.host_str().map(String::from))
                .unwrap_or_else(|| "PDF".into());
            let title = inspection.title.clone().or(file_name).unwrap_or(host);
            let reading_mins = ((inspection.pages as f64) * 2.5).round().max(1.0) as u32;
            let mut rec = StoredRecord {
                id: id.to_string(),
                url: requested_url.to_string(),
                final_url: final_url.to_string(),
                title,
                byline: inspection.author.clone(),
                published_at: None,
                fetched_at,
                reading_minutes: reading_mins,
                origin: origin.to_string(),
                media_type: "application/pdf".into(),
                quality: ContentNormalizationQuality {
                    completeness: "declared_full".into(),
                    conformance: "conformant".into(),
                    identity_confidence: if origin == "file" { "derived".into() } else { "strong".into() },
                    safety: "safe".into(),
                    warnings: Vec::new(),
                },
                lineage: None,
                rebuilt_as: None,
                artifact: None,
                aliases: None,
                canonical_url: None,
                pdf: Some(PdfInfo {
                    pages: inspection.pages,
                    byte_length: bytes.len() as u64,
                    text_layer: inspection.text_layer,
                }),
                media: None,
                capture: None,
                arxiv_version: None,
                extracted: None,
                item_meta,
                views: None,
                primary_view: None,
                lang: None,
                dir: None,
                reader: None,
                markdown: None,
                plain: inspection.sample_text,
                time_anchors: None,
                problems: Vec::new(),
                artifact_source: None,
            };
            rec.extracted = Some(fallback_extracted_for(&rec));
            return Ok(rec);
        }

        if is_html_media(media_type) {
            let content_identity = format!("sha256:{}", sha256_hex(bytes));
            let normalized = self
                .normalizer
                .normalize_html(bytes, media_type, final_url, origin, &fetched_at, item_meta.as_ref())
                .await
                .map_err(|e| ("NORMALIZE_FAILED".into(), e))?;
            let keep = (self.keep_capture)();
            let capture = if keep {
                fs::create_dir_all(self.dir()).map_err(|e| ("NORMALIZE_FAILED".into(), e.to_string()))?;
                fs::write(self.html_path(id), bytes).map_err(|e| ("NORMALIZE_FAILED".into(), e.to_string()))?;
                Some(CaptureInfo {
                    byte_length: bytes.len() as u64,
                    media_type: media_type.to_string(),
                    sha256: Some(content_identity),
                    fetched_at: Some(fetched_at.clone()),
                })
            } else {
                let _ = fs::remove_file(self.html_path(id));
                None
            };
            let html_media = detect_html_audio_stream(bytes).map(|stream_url| {
                let word_count = normalized
                    .plain
                    .as_deref()
                    .unwrap_or("")
                    .split_whitespace()
                    .count();
                MediaInfo {
                    kind: "audio".into(),
                    provider: "web".into(),
                    stream_url,
                    video_id: None,
                    duration_sec: None,
                    cached_bytes: None,
                    transcript_origin: if word_count >= 250 {
                        "official".into()
                    } else {
                        "absent".into()
                    },
                    chapters: None,
                }
            });
            return Ok(StoredRecord {
                id: id.to_string(),
                url: requested_url.to_string(),
                final_url: final_url.to_string(),
                title: normalized.title,
                byline: normalized.byline,
                published_at: normalized.published_at,
                fetched_at,
                reading_minutes: normalized.reading_minutes,
                origin: origin.to_string(),
                media_type: media_type.to_string(),
                quality: normalized.quality,
                lineage: None,
                rebuilt_as: None,
                artifact: None,
                aliases: None,
                canonical_url: normalized.canonical_url,
                pdf: None,
                media: html_media,
                capture,
                arxiv_version: None,
                extracted: Some(normalized.extracted),
                item_meta,
                views: None,
                primary_view: None,
                lang: normalized.lang,
                dir: normalized.dir,
                reader: normalized.reader,
                markdown: normalized.markdown,
                plain: normalized.plain,
                time_anchors: None,
                problems: normalized.problems,
                artifact_source: None,
            });
        }

        if matches!(media_type, "text/markdown" | "text/plain" | "text/x-markdown") {
            let content = String::from_utf8_lossy(bytes).to_string();
            let heading_re = Regex::new(r"(?m)^#\s+(.+)$").unwrap();
            let title = heading_re
                .captures(&content)
                .and_then(|c| c.get(1).map(|m| m.as_str().trim().to_string()))
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| {
                    Url::parse(final_url)
                        .ok()
                        .and_then(|u| u.path_segments()?.last().map(String::from))
                        .unwrap_or_else(|| final_url.to_string())
                });
            let md_parts = self
                .normalizer
                .normalize_markdown(&content, final_url)
                .await
                .map_err(|e| ("NORMALIZE_FAILED".into(), e))?;
            let mut rec = StoredRecord {
                id: id.to_string(),
                url: requested_url.to_string(),
                final_url: final_url.to_string(),
                title,
                byline: None,
                published_at: None,
                fetched_at,
                reading_minutes: md_parts.reading_minutes,
                origin: origin.to_string(),
                media_type: media_type.to_string(),
                quality: ContentNormalizationQuality::default(),
                lineage: None,
                rebuilt_as: None,
                artifact: None,
                aliases: None,
                canonical_url: None,
                pdf: None,
                media: None,
                capture: None,
                arxiv_version: None,
                extracted: None,
                item_meta,
                views: None,
                primary_view: None,
                lang: None,
                dir: None,
                reader: md_parts.reader,
                markdown: Some(content),
                plain: None,
                time_anchors: None,
                problems: Vec::new(),
                artifact_source: None,
            };
            rec.extracted = Some(fallback_extracted_for(&rec));
            return Ok(rec);
        }

        Err((
            "UNSUPPORTED_TYPE".into(),
            format!("This is {media_type}; only pages, PDFs, Markdown and plain text can be read in M0."),
        ))
    }

    pub async fn validate_artifact_source(&self, artifact_type: &str, source: &str) -> Result<(), String> {
        if source.trim().is_empty() {
            return Err("The artifact is empty.".into());
        }
        if source.chars().count() > MAX_ARTIFACT_SOURCE {
            return Err(format!("The artifact is longer than {MAX_ARTIFACT_SOURCE} characters."));
        }
        if artifact_type == "svg" && !Regex::new(r"(?i)<svg[\s>]").unwrap().is_match(source) {
            return Err("An SVG artifact must contain an <svg> element.".into());
        }
        if artifact_type == "html" && !Regex::new(r"(?is)<[a-z].*>").unwrap().is_match(source) {
            return Err("An HTML artifact must contain HTML markup.".into());
        }
        if artifact_type == "react" {
            self.normalizer.compile_react(source).await?;
        }
        Ok(())
    }

    async fn build_artifact_fields(
        &self,
        artifact_type: &str,
        source: &str,
        title: &str,
        language: Option<&str>,
        url: &str,
    ) -> Result<(String, Option<ReaderPayload>, Option<String>, Option<String>, u32), String> {
        if artifact_type == "markdown" {
            let body = without_title_heading(source, title);
            let parts = self.normalizer.normalize_markdown(&body, url).await?;
            return Ok(("text/markdown".into(), parts.reader, Some(body), None, parts.reading_minutes));
        }
        if artifact_type == "code" {
            let longest_ticks = Regex::new(r"`+")
                .unwrap()
                .find_iter(source)
                .map(|m| m.as_str().len())
                .max()
                .unwrap_or(2)
                .max(2);
            let fence = "`".repeat(longest_ticks + 1);
            let md = format!("{fence}{}\n{source}\n{fence}", language.unwrap_or(""));
            let parts = self.normalizer.normalize_markdown(&md, url).await?;
            return Ok(("text/markdown".into(), parts.reader, Some(md), None, parts.reading_minutes));
        }
        let plain = match artifact_type {
            "react" => text_of_component(source),
            "mermaid" => source.split_whitespace().collect::<Vec<_>>().join(" "),
            _ => text_of_markup(source),
        };
        let mins = reading_minutes(&plain);
        let media = artifact_media_type(artifact_type).unwrap_or("application/vnd.quire.artifact+html");
        Ok((
            media.into(),
            None,
            None,
            if plain.is_empty() { None } else { Some(plain) },
            mins,
        ))
    }

    fn present_lineage(&self, ids: &[String]) -> Result<Vec<String>, String> {
        let mut seen = HashSet::new();
        let mut unique = Vec::new();
        for id in ids {
            if seen.insert(id.clone()) {
                unique.push(id.clone());
            }
        }
        let unknown: Vec<&str> = unique.iter().filter(|id| !self.has(id)).map(String::as_str).collect();
        if !unknown.is_empty() {
            return Err(format!(
                "Unknown material ids in lineage: {}. Cite only materials that are in the library.",
                unknown.join(", ")
            ));
        }
        Ok(unique)
    }

    pub async fn save_artifact(&self, input: SaveArtifactInput) -> Result<MaterialRecord, String> {
        let title = input.title.trim().to_string();
        if title.is_empty() {
            return Err("An artifact needs a title.".into());
        }
        let artifact_type = input.artifact_type.unwrap_or_else(|| "markdown".into());
        let source = input.source.or(input.markdown).unwrap_or_default();
        if let Err(problem) = self.validate_artifact_source(&artifact_type, &source).await {
            return Err(if problem == "The artifact is empty." {
                "An artifact needs content.".into()
            } else {
                problem
            });
        }
        let lineage = self.present_lineage(&input.lineage)?;
        let fetched_at = now_iso();
        let id = sha256_hex(format!("{title}\n{fetched_at}").as_bytes())[..16].to_string();
        let url = format!("quire://artifact/{id}");
        let language = if artifact_type == "code" { input.language } else { None };
        let artifact = ArtifactInfo {
            artifact_type: artifact_type.clone(),
            language: language.clone(),
            version: 1,
            updated_at: fetched_at.clone(),
        };
        let (media_type, reader, markdown, plain, reading_mins) = self
            .build_artifact_fields(&artifact_type, &source, &title, language.as_deref(), &url)
            .await?;
        let mut rec = StoredRecord {
            id,
            url: url.clone(),
            final_url: url,
            title,
            byline: None,
            published_at: None,
            fetched_at,
            reading_minutes: reading_mins,
            origin: "agent".into(),
            media_type,
            quality: ContentNormalizationQuality::default(),
            lineage: Some(lineage),
            rebuilt_as: None,
            artifact: Some(artifact),
            aliases: None,
            canonical_url: None,
            pdf: None,
            media: None,
            capture: None,
            arxiv_version: None,
            extracted: None,
            item_meta: None,
            views: None,
            primary_view: None,
            lang: None,
            dir: None,
            reader,
            markdown,
            plain,
            time_anchors: None,
            problems: Vec::new(),
            artifact_source: Some(source),
        };
        rec.extracted = Some(fallback_extracted_for(&rec));
        let saved = self.save_stored(rec)?;
        self.decorate(&saved)
    }

    pub async fn update_artifact(&self, id: &str, change: UpdateArtifactChange) -> Result<MaterialRecord, String> {
        let mut record = self.require_stored(id)?;
        let info = artifact_info_of(&record).ok_or_else(|| {
            format!("Material {id} ({}) is not an artifact the agent wrote; only artifacts can be edited.", record.title)
        })?;
        let current = artifact_source_of(&record).ok_or_else(|| format!("Artifact {id} has no source to edit."))?;
        let source = if let Some((old_text, new_text)) = change.edit {
            apply_artifact_edit(&current, &old_text, &new_text)?
        } else {
            change.source.unwrap_or_else(|| current.clone())
        };
        self.validate_artifact_source(&info.artifact_type, &source).await?;
        let title = change
            .title
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(String::from)
            .unwrap_or_else(|| record.title.clone());
        let lineage = if let Some(added) = change.lineage {
            let verified = self.present_lineage(&added)?;
            let mut merged = record.lineage.clone().unwrap_or_default();
            for item in verified {
                if !merged.contains(&item) {
                    merged.push(item);
                }
            }
            Some(merged)
        } else {
            record.lineage.clone()
        };

        let revision = ArtifactRevision {
            version: info.version,
            updated_at: info.updated_at.clone(),
            title: record.title.clone(),
            source: current,
        };
        fs::create_dir_all(self.dir()).map_err(|e| e.to_string())?;
        fs::write(
            self.revision_path(id, info.version),
            serde_json::to_string(&revision).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;

        let updated_at = now_iso();
        let (media_type, reader, markdown, plain, reading_mins) = self
            .build_artifact_fields(&info.artifact_type, &source, &title, info.language.as_deref(), &record.url)
            .await?;

        record.title = title;
        record.lineage = lineage;
        record.artifact = Some(ArtifactInfo {
            version: info.version + 1,
            updated_at,
            ..info
        });
        record.media_type = media_type;
        record.reader = reader;
        record.markdown = markdown;
        record.plain = plain;
        record.reading_minutes = reading_mins;
        record.artifact_source = Some(source);
        record.views = None;
        record.primary_view = None;
        record.extracted = Some(fallback_extracted_for(&record));

        let saved = self.save_stored(record)?;
        self.decorate(&saved)
    }

    pub fn artifact_revision(&self, id: &str, version: u32) -> Result<Option<ArtifactRevision>, String> {
        if !valid_hex_16(id) || version < 1 {
            return Ok(None);
        }
        let Some(bytes) = self.read_optional(&self.revision_path(id, version))? else {
            return Ok(None);
        };
        serde_json::from_slice(&bytes).map(Some).map_err(|e| e.to_string())
    }

    pub fn artifact_at(
        &self,
        id: &str,
        version: Option<u32>,
    ) -> Result<Option<(StoredRecord, ArtifactInfo, String, String)>, String> {
        let Some(record) = self.read_stored(id)? else {
            return Ok(None);
        };
        let Some(info) = artifact_info_of(&record) else {
            return Ok(None);
        };
        let Some(current) = artifact_source_of(&record) else {
            return Ok(None);
        };
        if version.is_none() || version == Some(info.version) {
            let title = record.title.clone();
            return Ok(Some((record, info, current, title)));
        }
        let v = version.unwrap();
        if v >= info.version {
            return Ok(None);
        }
        let Some(rev) = self.artifact_revision(id, v)? else {
            return Ok(None);
        };
        let rev_info = ArtifactInfo {
            version: rev.version,
            updated_at: rev.updated_at,
            ..info
        };
        Ok(Some((record, rev_info, rev.source, rev.title)))
    }

    pub async fn artifact_version_content(&self, id: &str, version: u32) -> Result<Option<MaterialViewContent>, String> {
        let Some((mut record, info, source, title)) = self.artifact_at(id, Some(version))? else {
            return Ok(None);
        };
        let (media_type, reader, markdown, plain, reading_mins) = self
            .build_artifact_fields(&info.artifact_type, &source, &title, info.language.as_deref(), &record.url)
            .await?;
        record.artifact = Some(info);
        record.media_type = media_type;
        record.reader = reader;
        record.markdown = markdown;
        record.plain = plain;
        record.reading_minutes = reading_mins;
        record.artifact_source = Some(source);
        Ok(Some(primary_content_of(&record)))
    }

    pub async fn restore_artifact(&self, id: &str, version: u32) -> Result<MaterialRecord, String> {
        let rev = self
            .artifact_revision(id, version)?
            .ok_or_else(|| format!("Version {version} of artifact {id} is not kept."))?;
        self.update_artifact(
            id,
            UpdateArtifactChange {
                source: Some(rev.source),
                edit: None,
                title: Some(rev.title),
                lineage: None,
            },
        )
        .await
    }

    pub async fn refresh_metadata(&self, id: &str) -> Result<MaterialRecord, String> {
        let mut record = self.require_stored(id)?;
        let page_bytes = if is_html_media(&record.media_type) {
            self.read_optional(&self.html_path(&record.id))?
        } else {
            None
        };
        let ext = self
            .normalizer
            .extract_meta(ExtractMetaInput {
                html_base64: page_bytes
                    .as_ref()
                    .map(|b| base64::engine::general_purpose::STANDARD.encode(b)),
                url: record.final_url.clone(),
                media_type: record.media_type.clone(),
                origin: record.origin.clone(),
                fetched_at: Some(record.fetched_at.clone()),
                fallback_title: Some(record.title.clone()),
                fallback_byline: record.byline.clone(),
                fallback_published_at: record.published_at.clone(),
                fallback_lang: record.lang.clone(),
                item: record.item_meta.clone(),
            })
            .await?;
        record.extracted = Some(ext.meta);
        if page_bytes.is_some() {
            record.canonical_url = ext.canonical_url;
        }
        let saved = self.save_stored(record)?;
        self.decorate(&saved)
    }

    pub fn set_rebuilt_as(&self, id: &str, artifact_id: &str) -> Result<MaterialRecord, String> {
        let mut record = self.require_stored(id)?;
        let artifact = self.read_stored(artifact_id)?;
        if !artifact.is_some_and(|a| a.origin == "agent") {
            return Err(format!("Artifact {artifact_id} is not in the library."));
        }
        record.rebuilt_as = Some(artifact_id.to_string());
        let saved = self.save_stored(record)?;
        self.decorate(&saved)
    }

    pub fn register_view(&self, id: &str, view: MaterialView) -> Result<MaterialRecord, String> {
        let mut record = self.require_stored(id)?;
        if view.id == primary_view_of(&record) || view.status == "ready" {
            return Err(format!(
                "View {} of {id} cannot be registered: it is the primary view or claims to be stored.",
                view.id
            ));
        }
        record.views = Some(upsert_view(&views_of(&record), view));
        let saved = self.save_stored(record)?;
        self.decorate(&saved)
    }

    fn read_view_content(&self, id: &str, view: &str) -> Result<Option<MaterialViewContent>, String> {
        let Some(bytes) = self.read_optional(&self.view_content_path(id, view))? else {
            return Ok(None);
        };
        serde_json::from_slice(&bytes).map(Some).map_err(|e| e.to_string())
    }

    fn write_view_content(&self, id: &str, content: &MaterialViewContent, pdf_bytes: Option<&[u8]>) -> Result<(), String> {
        fs::create_dir_all(self.dir()).map_err(|e| e.to_string())?;
        if let Some(pdf) = pdf_bytes {
            fs::write(self.view_pdf_path(id, &content.view), pdf).map_err(|e| e.to_string())?;
        }
        let json = serde_json::to_string(content).map_err(|e| e.to_string())?;
        fs::write(self.view_content_path(id, &content.view), json).map_err(|e| e.to_string())
    }

    pub fn get_view(&self, id: &str, view: &str) -> Result<Option<MaterialViewContent>, String> {
        let Some(record) = self.read_stored(id)? else {
            return Ok(None);
        };
        if view != primary_view_of(&record) {
            return self.read_view_content(id, view);
        }
        if view == "text" || view == "transcript" {
            if let Some(c) = self.read_view_content(id, view)? {
                return Ok(Some(c));
            }
        }
        Ok(Some(primary_content_of(&record)))
    }

    pub async fn fetch_view(&self, id: &str, view_id: &str) -> OpenUrlResult {
        let record = match self.read_stored(id) {
            Ok(Some(r)) => r,
            Ok(None) => return OpenUrlResult::failure("MATERIAL_NOT_FOUND", format!("Material {id} is not in the library.")),
            Err(e) => return OpenUrlResult::failure("NORMALIZE_FAILED", e),
        };
        let views = views_of(&record);
        let Some(view) = views.iter().find(|v| v.id == view_id).cloned() else {
            return OpenUrlResult::failure("VIEW_UNKNOWN", format!("This material has no {view_id} view."));
        };
        if view.status == "ready" {
            return OpenUrlResult::failure("VIEW_ALREADY_STORED", format!("The {} view is stored already.", view.label));
        }

        let outcome: Result<(MaterialViewContent, u64), (String, String)> = if view_id == "text" {
            self.build_text_view_for(&record).await
        } else {
            self.fetch_remote_view(&record, &view).await
        };

        match outcome {
            Ok((content, byte_len)) => {
                let ready = MaterialView {
                    media_type: content.media_type.clone(),
                    status: "ready".into(),
                    fetched_at: Some(now_iso()),
                    byte_length: Some(byte_len),
                    pdf: content.pdf.clone(),
                    error: None,
                    ..view
                };
                let mut next = record;
                next.views = Some(upsert_view(&views, ready));
                match self.save_stored(next).and_then(|s| self.decorate(&s)) {
                    Ok(mat) => OpenUrlResult::success(mat, false),
                    Err(e) => OpenUrlResult::failure("NORMALIZE_FAILED", e),
                }
            }
            Err((code, msg)) => {
                let failed = MaterialView {
                    status: "failed".into(),
                    fetched_at: None,
                    byte_length: None,
                    pdf: None,
                    error: Some(msg.clone()),
                    ..view
                };
                let mut next = record;
                next.views = Some(upsert_view(&views, failed));
                let _ = self.save_stored(next);
                OpenUrlResult::failure(code, msg)
            }
        }
    }

    async fn fetch_remote_view(
        &self,
        record: &StoredRecord,
        view: &MaterialView,
    ) -> Result<(MaterialViewContent, u64), (String, String)> {
        let url = assert_public_http_url(&view.url).map_err(|e| (e.code, e.message))?;
        let page = fetch_page(&self.http, &url, PAGE_ACCEPT)
            .await
            .map_err(|e| (e.code, e.message))?;
        let pdf = is_pdf(&page.bytes, &page.media_type);
        let eff_media = if pdf { "application/pdf" } else { page.media_type.as_str() };
        if view_id_for_media_type(eff_media) != view.id {
            return Err((
                "VIEW_TYPE_MISMATCH".into(),
                format!("The {} view answered {}.", view.id, page.media_type),
            ));
        }
        let byte_len = page.bytes.len() as u64;
        if pdf {
            let inspection = self
                .normalizer
                .inspect_pdf(&page.bytes)
                .await
                .map_err(|e| ("PDF_INVALID".into(), e))?;
            let content = MaterialViewContent {
                view: view.id.clone(),
                media_type: "application/pdf".into(),
                pdf: Some(PdfInfo {
                    pages: inspection.pages,
                    byte_length: byte_len,
                    text_layer: inspection.text_layer,
                }),
                reader: None,
                markdown: None,
                plain: inspection.sample_text,
                reading_minutes: ((inspection.pages as f64) * 2.5).round().max(1.0) as u32,
                quality: ContentNormalizationQuality {
                    completeness: "declared_full".into(),
                    conformance: "conformant".into(),
                    identity_confidence: if record.origin == "file" { "derived".into() } else { "strong".into() },
                    safety: "safe".into(),
                    warnings: Vec::new(),
                },
                problems: Vec::new(),
                anchors: None,
                time_anchors: None,
                artifact_body: None,
                report: None,
            };
            self.write_view_content(&record.id, &content, Some(&page.bytes))
                .map_err(|e| ("NORMALIZE_FAILED".into(), e))?;
            return Ok((content, byte_len));
        }

        let temp = self
            .materialize_bytes(
                &page.bytes,
                &page.media_type,
                &page.final_url,
                &page.final_url,
                &record.origin,
                &record.id,
                None,
            )
            .await?;
        let mut content = primary_content_of(&temp);
        content.view = view.id.clone();
        self.write_view_content(&record.id, &content, None)
            .map_err(|e| ("NORMALIZE_FAILED".into(), e))?;
        Ok((content, byte_len))
    }

    async fn build_text_view_for(
        &self,
        record: &StoredRecord,
    ) -> Result<(MaterialViewContent, u64), (String, String)> {
        let views = views_of(record);
        let pdf_ready = views.iter().any(|v| v.id == "pdf" && v.status == "ready");
        if !pdf_ready {
            return Err((
                "PDF_NOT_STORED".into(),
                "The PDF is not stored yet; fetch the PDF view before building the text view.".into(),
            ));
        }
        let pdf_bytes = self
            .bytes(&record.id, Some("pdf"))
            .map_err(|e| ("PDF_NOT_STORED".into(), e))?
            .ok_or_else(|| {
                (
                    "PDF_NOT_STORED".into(),
                    "The PDF view is listed as stored but its file is missing.".into(),
                )
            })?;
        let (judge, api_key) = (self.reflow_judge)().map_err(|e| ("NORMALIZE_FAILED".into(), e))?;
        let _ = self.figures.remove(&record.id);
        let built = self
            .normalizer
            .build_text_view(&pdf_bytes, &record.id, &record.title, &judge, api_key)
            .await
            .map_err(|e| ("NORMALIZE_FAILED".into(), e))?;
        for fig in &built.figures {
            if let Ok(png) = base64::engine::general_purpose::STANDARD.decode(&fig.png_base64) {
                let _ = self.figures.write(&record.id, fig.index, &png);
            }
        }
        let json = serde_json::to_string(&built.content).map_err(|e| ("NORMALIZE_FAILED".into(), e.to_string()))?;
        let byte_len = json.len() as u64;
        self.write_view_content(&record.id, &built.content, None)
            .map_err(|e| ("NORMALIZE_FAILED".into(), e))?;
        Ok((built.content, byte_len))
    }

    pub fn set_primary_view(&self, id: &str, view: &str) -> Result<MaterialRecord, String> {
        let record = with_primary_view(self.require_stored(id)?);
        let current_primary = primary_view_of(&record);
        if view == current_primary {
            return self.decorate(&record);
        }
        let views = views_of(&record);
        if !views.iter().any(|v| v.id == view && v.status == "ready") {
            return Err(format!("The {view} view of {id} is not stored; fetch it first."));
        }
        let incoming = self
            .read_view_content(id, view)?
            .ok_or_else(|| format!("The {view} view of {id} is listed as stored but its file is missing."))?;
        let outgoing = if current_primary == "text" || current_primary == "transcript" {
            self.read_view_content(id, &current_primary)?
                .unwrap_or_else(|| primary_content_of(&record))
        } else {
            primary_content_of(&record)
        };

        self.write_view_content(id, &outgoing, None)?;
        if outgoing.pdf.is_some() {
            fs::rename(self.pdf_path(id), self.view_pdf_path(id, &outgoing.view)).map_err(|e| e.to_string())?;
        }
        if incoming.pdf.is_some() {
            fs::rename(self.view_pdf_path(id, &incoming.view), self.pdf_path(id)).map_err(|e| e.to_string())?;
        }
        if incoming.view != "text" && incoming.view != "transcript" {
            let _ = fs::remove_file(self.view_content_path(id, &incoming.view));
        }

        let mut next = record;
        next.media_type = incoming.media_type;
        next.reading_minutes = incoming.reading_minutes;
        next.quality = incoming.quality;
        next.problems = incoming.problems;
        next.primary_view = Some(incoming.view);
        next.pdf = incoming.pdf;
        next.reader = incoming.reader;
        next.markdown = incoming.markdown;
        next.plain = incoming.plain;
        next.time_anchors = incoming.time_anchors;

        let saved = self.save_stored(next)?;
        self.decorate(&saved)
    }

    pub fn save_from_feed(&self, input: FeedMaterialInput) -> Result<MaterialRecord, String> {
        let link = Url::parse(&input.url).ok();
        let known = match &link {
            Some(u) => self.find_by_url(u)?,
            None => self.read_stored(&id_for(&input.url))?,
        };
        if let Some(ref k) = known {
            if !is_unreadable_page(k) {
                let named = with_aliases(k.clone(), &[input.url]);
                let saved = self.save_stored(named)?;
                return self.decorate(&saved);
            }
        }
        let id = known
            .as_ref()
            .map(|k| k.id.clone())
            .unwrap_or_else(|| link.as_ref().map(material_id_of).unwrap_or_else(|| id_for(&input.url)));
        let item_meta = match (known.as_ref().and_then(|k| k.item_meta.as_ref()), input.meta.as_ref()) {
            (Some(a), Some(b)) => Some(apply_overrides(a, Some(b))),
            (Some(a), None) => Some(a.clone()),
            (None, Some(b)) => Some(b.clone()),
            (None, None) => None,
        };
        let plain_ref = input
            .content
            .plain
            .as_deref()
            .or(input.content.markdown.as_deref())
            .unwrap_or("");
        let mut rec = StoredRecord {
            id: id.clone(),
            url: input.url.clone(),
            final_url: input.url,
            title: input.title,
            byline: input.byline,
            published_at: input.published_at,
            fetched_at: now_iso(),
            reading_minutes: reading_minutes(plain_ref),
            origin: "feed".into(),
            media_type: "text/html".into(),
            quality: ContentNormalizationQuality {
                completeness: "declared_full".into(),
                conformance: "conformant".into(),
                identity_confidence: "medium".into(),
                safety: "safe".into(),
                warnings: Vec::new(),
            },
            lineage: None,
            rebuilt_as: None,
            artifact: None,
            aliases: None,
            canonical_url: None,
            pdf: None,
            media: None,
            capture: None,
            arxiv_version: None,
            extracted: None,
            item_meta,
            views: None,
            primary_view: None,
            lang: input.lang,
            dir: None,
            reader: input.content.reader,
            markdown: input.content.markdown,
            plain: input.content.plain,
            time_anchors: None,
            problems: vec![NormalizationProblem {
                code: "FEED_CONTENT_FALLBACK".into(),
                recover_by: "reopen".into(),
                scope: "capture".into(),
                severity: "warning".into(),
                detail: None,
                path: None,
            }],
            artifact_source: None,
        };
        rec.extracted = Some(fallback_extracted_for(&rec));
        if let Some(prev) = known {
            let _ = fs::remove_file(self.html_path(&id));
            let merged = with_names_of(&prev, merge_views(&prev, rec));
            let saved = self.save_stored(merged)?;
            return self.decorate(&saved);
        }
        let saved = self.save_stored(rec)?;
        self.decorate(&saved)
    }

    async fn fetch_podcast_chapters(&self, chapters_url: &str) -> Option<Vec<MediaChapter>> {
        #[derive(Deserialize)]
        struct ChaptersDoc {
            #[serde(default)]
            chapters: Vec<ChapterItem>,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct ChapterItem {
            start_time: Option<f64>,
            title: Option<String>,
        }
        let u = assert_public_http_url(chapters_url).ok()?;
        let page = fetch_page(&self.http, &u, "application/json+chapters,application/json;q=0.9,*/*;q=0.5")
            .await
            .ok()?;
        let doc: ChaptersDoc = serde_json::from_slice(&page.bytes).ok()?;
        let mut out: Vec<MediaChapter> = doc
            .chapters
            .into_iter()
            .filter_map(|c| {
                let start_sec = c.start_time.filter(|s| s.is_finite() && *s >= 0.0)?;
                let title = c.title?.trim().to_string();
                if title.is_empty() {
                    None
                } else {
                    Some(MediaChapter { start_sec, title })
                }
            })
            .collect();
        out.sort_by(|a, b| a.start_sec.partial_cmp(&b.start_sec).unwrap_or(std::cmp::Ordering::Equal));
        if out.is_empty() {
            None
        } else {
            Some(out)
        }
    }

    async fn open_apple_episode(
        &self,
        ep: crate::http::ApplePodcastEpisode,
        origin: &str,
        override_meta: Option<MaterialMeta>,
    ) -> Result<OpenUrlResult, (String, String)> {
        let parsed_url = Url::parse(&ep.url).map_err(|_| ("URL_INVALID".into(), "Invalid episode URL.".into()))?;
        let id = material_id_of(&parsed_url);
        let mut transcripts = Vec::new();
        let mut chapters_url = None;
        let mut chapters = Vec::new();
        let mut shownotes_content = None;
        let mut page_url = None;

        if let Some(ref feed_url) = ep.feed_url {
            if let Ok(u) = assert_public_http_url(feed_url) {
                if let Ok(feed_page) = fetch_page(&self.http, &u, FEED_ACCEPT).await {
                    if let Ok(parsed) = self
                        .normalizer
                        .parse_feed(&feed_page.bytes, &feed_page.media_type, feed_url, false)
                        .await
                    {
                        if let Some(matched) = parsed.items.into_iter().find(|it| {
                            podcast_episode_matches(
                                it.signals.enclosure_url.as_deref(),
                                &it.title,
                                &ep.stream_url,
                                &ep.title,
                            )
                        }) {
                            transcripts = matched.signals.transcripts.unwrap_or_default();
                            chapters_url = matched.signals.chapters_url;
                            chapters = matched.signals.chapters.unwrap_or_default();
                            shownotes_content = matched.content;
                            if !matched.link.is_empty() {
                                page_url = Some(matched.link);
                            }
                        }
                    }
                }
            }
        }

        let mut base_meta = MaterialMeta {
            kind: Some("podcastEpisode".into()),
            title: Some(ep.title.clone()),
            publication: ep.show_title,
            date: ep.published_at.clone(),
            creators: ep.author.map(|name| {
                vec![Creator {
                    role: "host".into(),
                    name,
                    given: None,
                    family: None,
                }]
            }),
            ..Default::default()
        };
        if let Some(ref ov) = override_meta {
            base_meta = apply_overrides(&base_meta, Some(ov));
        }

        let rec = self
            .materialize_podcast_episode(
                PodcastEpisodeInput {
                    id,
                    url: ep.url,
                    page_url,
                    stream_url: ep.stream_url,
                    title: ep.title,
                    published_at: ep.published_at,
                    duration_sec: ep.duration_sec,
                    lang: None,
                    transcripts,
                    chapters_url,
                    chapters,
                    shownotes_content,
                    shownotes_markdown: ep.description,
                    meta: Some(base_meta),
                },
                origin,
            )
            .await?;
        let saved = self.save_stored(rec).map_err(|e| ("NORMALIZE_FAILED".into(), e))?;
        Ok(OpenUrlResult::success(
            self.decorate(&saved).map_err(|e| ("NORMALIZE_FAILED".into(), e))?,
            false,
        ))
    }

    pub async fn materialize_podcast_episode(
        &self,
        input: PodcastEpisodeInput,
        origin: &str,
    ) -> Result<StoredRecord, (String, String)> {
        let valid_stream = assert_public_http_url(&input.stream_url)
            .map_err(|e| (e.code, e.message))?
            .to_string();
        let fetched_at = now_iso();

        let mut chapters = input.chapters;
        if chapters.is_empty() {
            if let Some(ref cu) = input.chapters_url {
                if let Some(fetched_ch) = self.fetch_podcast_chapters(cu).await {
                    chapters = fetched_ch;
                }
            }
        }

        // 1. Build Show notes view content (always stored as `<id>.shownotes.json`)
        let mut notes_reader: Option<ReaderPayload> = None;
        let mut notes_md: Option<String> = None;
        let mut notes_plain: Option<String> = None;

        if let Some(sc) = input.shownotes_content {
            notes_reader = sc.reader;
            notes_md = sc.markdown;
            notes_plain = sc.plain;
            if notes_reader.is_none() || is_single_paragraph_reader(&notes_reader) {
                if let Some(md) = notes_md.clone().or_else(|| notes_plain.clone()) {
                    if let Ok(parts) = self.normalizer.normalize_shownotes(&md, &input.url).await {
                        if parts.reader.is_some() {
                            notes_reader = parts.reader;
                        }
                        if let Some(formatted) = parts.markdown {
                            notes_md = Some(formatted);
                        }
                        if chapters.is_empty() {
                            if let Some(ch) = parts.chapters {
                                chapters = ch;
                            }
                        }
                    }
                }
            }
        } else if let Some(desc) = input.shownotes_markdown.filter(|s| !s.trim().is_empty()) {
            let mut formatted_md = desc.clone();
            if let Ok(parts) = self.normalizer.normalize_shownotes(&desc, &input.url).await {
                notes_reader = parts.reader;
                if let Some(formatted) = parts.markdown {
                    formatted_md = formatted;
                }
                if chapters.is_empty() {
                    if let Some(ch) = parts.chapters {
                        chapters = ch;
                    }
                }
            }
            notes_plain = Some(desc);
            notes_md = Some(formatted_md);
        } else if let Some(ref page_u) = input.page_url {
            if let Ok(u) = assert_public_http_url(page_u) {
                if !is_audio_stream_url(&u) {
                    if let Ok(page) = fetch_page(&self.http, &u, PAGE_ACCEPT).await {
                        if is_html_media(&page.media_type) {
                            if let Ok(norm) = self
                                .normalizer
                                .normalize_html(&page.bytes, &page.media_type, &page.final_url, origin, &fetched_at, input.meta.as_ref())
                                .await
                            {
                                notes_reader = norm.reader;
                                notes_md = norm.markdown;
                                notes_plain = norm.plain;
                            }
                        }
                    }
                }
            }
        }

        if notes_plain.as_deref().unwrap_or("").trim().is_empty() && notes_md.as_deref().unwrap_or("").trim().is_empty() {
            let fallback = "No show notes were provided for this episode.".to_string();
            if let Ok(parts) = self.normalizer.normalize_markdown(&fallback, &input.url).await {
                notes_reader = parts.reader;
            }
            notes_md = Some(fallback.clone());
            notes_plain = Some(fallback);
        }

        let notes_mins = input
            .duration_sec
            .filter(|&d| d > 0)
            .map(|d| ((d as f64) / 60.0).round().max(1.0) as u32)
            .unwrap_or_else(|| reading_minutes(notes_plain.as_deref().unwrap_or("")));

        let shownotes_content = MaterialViewContent {
            view: "shownotes".into(),
            media_type: SHOWNOTES_VIEW_MEDIA_TYPE.into(),
            pdf: None,
            reader: notes_reader,
            markdown: notes_md,
            plain: notes_plain,
            reading_minutes: notes_mins,
            quality: ContentNormalizationQuality::default(),
            problems: Vec::new(),
            anchors: None,
            time_anchors: None,
            artifact_body: None,
            report: None,
        };
        let shownotes_bytes = serde_json::to_string(&shownotes_content)
            .map(|s| s.len() as u64)
            .unwrap_or(0);
        self.write_view_content(&input.id, &shownotes_content, None)
            .map_err(|e| ("NORMALIZE_FAILED".into(), e))?;

        let shownotes_view = MaterialView {
            id: "shownotes".into(),
            label: view_label("shownotes").into(),
            url: input.page_url.clone().unwrap_or_else(|| input.url.clone()),
            media_type: SHOWNOTES_VIEW_MEDIA_TYPE.into(),
            status: "ready".into(),
            fetched_at: Some(fetched_at.clone()),
            byte_length: Some(shownotes_bytes),
            pdf: None,
            error: None,
        };

        // 2. Try declared `<podcast:transcript>` candidates in ranked order
        let mut normalized_tx = None;
        let mut transcript_source_url = input.url.clone();
        for cand in &input.transcripts {
            let Ok(tu) = assert_public_http_url(&cand.url) else {
                continue;
            };
            let Ok(page) = fetch_page(&self.http, &tu, "*/*").await else {
                continue;
            };
            let raw_text = String::from_utf8_lossy(&page.bytes).to_string();
            let eff_type = if cand.media_type.is_empty() {
                page.media_type.clone()
            } else {
                cand.media_type.clone()
            };
            if let Ok(tx) = self
                .normalizer
                .normalize_transcript(NormalizeTranscriptInput {
                    raw_text: Some(raw_text),
                    media_type: Some(eff_type),
                    cues: None,
                    chapters: if chapters.is_empty() { None } else { Some(chapters.clone()) },
                    keyframes: None,
                    title: Some(input.title.clone()),
                })
                .await
            {
                if !tx.time_anchors.is_empty() {
                    transcript_source_url = cand.url.clone();
                    normalized_tx = Some(tx);
                    break;
                }
            }
        }

        let (
            primary_view,
            media_type,
            reader,
            markdown,
            plain,
            time_anchors,
            reading_mins,
            transcript_origin,
            views,
        ) = if let Some(tx) = normalized_tx {
            fs::create_dir_all(self.dir()).map_err(|e| ("NORMALIZE_FAILED".into(), e.to_string()))?;
            if let Ok(raw_json) = serde_json::to_string(&tx.cues) {
                let _ = fs::write(self.dir().join(format!("{}.transcript.raw.json", input.id)), raw_json);
            }
            let tx_content = MaterialViewContent {
                view: "transcript".into(),
                media_type: TRANSCRIPT_VIEW_MEDIA_TYPE.into(),
                pdf: None,
                reader: Some(tx.reader.clone()),
                markdown: Some(tx.markdown.clone()),
                plain: Some(tx.plain.clone()),
                reading_minutes: tx.reading_minutes,
                quality: ContentNormalizationQuality::default(),
                problems: Vec::new(),
                anchors: None,
                time_anchors: Some(tx.time_anchors.clone()),
                artifact_body: None,
                report: None,
            };
            let tx_len = serde_json::to_string(&tx_content)
                .map(|s| s.len() as u64)
                .unwrap_or(0);
            self.write_view_content(&input.id, &tx_content, None)
                .map_err(|e| ("NORMALIZE_FAILED".into(), e))?;
            let tx_view = MaterialView {
                id: "transcript".into(),
                label: view_label("transcript").into(),
                url: transcript_source_url,
                media_type: TRANSCRIPT_VIEW_MEDIA_TYPE.into(),
                status: "ready".into(),
                fetched_at: Some(fetched_at.clone()),
                byte_length: Some(tx_len),
                pdf: None,
                error: None,
            };
            (
                "transcript".to_string(),
                TRANSCRIPT_VIEW_MEDIA_TYPE.to_string(),
                Some(tx.reader),
                Some(tx.markdown),
                Some(tx.plain),
                Some(tx.time_anchors),
                tx.reading_minutes,
                "official".to_string(),
                vec![tx_view, shownotes_view],
            )
        } else {
            (
                "shownotes".to_string(),
                SHOWNOTES_VIEW_MEDIA_TYPE.to_string(),
                shownotes_content.reader,
                shownotes_content.markdown,
                shownotes_content.plain,
                None,
                shownotes_content.reading_minutes,
                "absent".to_string(),
                vec![shownotes_view],
            )
        };

        let mut item_meta = input.meta.unwrap_or_default();
        if item_meta.kind.is_none() {
            item_meta.kind = Some("podcastEpisode".into());
        }

        let mut rec = StoredRecord {
            id: input.id,
            url: input.url.clone(),
            final_url: input.page_url.unwrap_or(input.url),
            title: input.title,
            byline: byline_of(item_meta.creators.as_deref()),
            published_at: input.published_at,
            fetched_at,
            reading_minutes: reading_mins,
            origin: origin.to_string(),
            media_type,
            quality: ContentNormalizationQuality::default(),
            lineage: None,
            rebuilt_as: None,
            artifact: None,
            aliases: None,
            canonical_url: None,
            pdf: None,
            media: Some(MediaInfo {
                kind: "audio".into(),
                provider: "podcast".into(),
                stream_url: valid_stream,
                video_id: None,
                duration_sec: input.duration_sec,
                cached_bytes: None,
                transcript_origin,
                chapters: if chapters.is_empty() { None } else { Some(chapters) },
            }),
            capture: None,
            arxiv_version: None,
            extracted: None,
            item_meta: Some(item_meta),
            views: Some(views),
            primary_view: Some(primary_view),
            lang: input.lang,
            dir: None,
            reader,
            markdown,
            plain,
            time_anchors,
            problems: Vec::new(),
            artifact_source: None,
        };
        rec.extracted = Some(fallback_extracted_for(&rec));
        Ok(rec)
    }

    pub async fn materialize_podcast_item(
        &self,
        item: &ItemRecord,
        content: Option<ItemContent>,
        meta: Option<MaterialMeta>,
    ) -> OpenUrlResult {
        let Some(ref stream_url) = item.signals.enclosure_url else {
            return OpenUrlResult::failure("EPISODE_NO_STREAM", "This podcast item has no enclosure stream URL.");
        };
        let locator = if !item.link.is_empty() { &item.link } else { stream_url.as_str() };
        let parsed = Url::parse(locator).ok();
        let known = match &parsed {
            Some(u) => self.find_by_url(u).ok().flatten(),
            None => self.read_stored(&id_for(locator)).ok().flatten(),
        };
        if let Some(existing) = known {
            if existing.media.is_some() {
                return match self.decorate(&existing) {
                    Ok(mat) => OpenUrlResult::success(mat, true),
                    Err(e) => OpenUrlResult::failure("NORMALIZE_FAILED", e),
                };
            }
        }
        let id = parsed
            .as_ref()
            .map(material_id_of)
            .unwrap_or_else(|| id_for(locator));
        let page_url = parsed
            .as_ref()
            .filter(|u| !is_audio_stream_url(u))
            .map(|u| u.to_string());

        match self
            .materialize_podcast_episode(
                PodcastEpisodeInput {
                    id,
                    url: locator.to_string(),
                    page_url,
                    stream_url: stream_url.clone(),
                    title: item.title.clone(),
                    published_at: Some(item.published_at.clone()),
                    duration_sec: item.signals.duration_sec,
                    lang: item.signals.lang.clone(),
                    transcripts: item.signals.transcripts.clone().unwrap_or_default(),
                    chapters_url: item.signals.chapters_url.clone(),
                    chapters: item.signals.chapters.clone().unwrap_or_default(),
                    shownotes_content: content,
                    shownotes_markdown: if item.gist.is_empty() { None } else { Some(item.gist.clone()) },
                    meta,
                },
                "feed",
            )
            .await
        {
            Ok(rec) => match self.save_stored(rec).and_then(|s| self.decorate(&s)) {
                Ok(mat) => OpenUrlResult::success(mat, false),
                Err(e) => OpenUrlResult::failure("NORMALIZE_FAILED", e),
            },
            Err((code, msg)) => OpenUrlResult::failure(code, msg),
        }
    }

    pub async fn open_youtube_video(
        &self,
        video_id: &str,
        requested_url: &str,
        origin: &str,
        fallback_content: Option<ItemContent>,
        override_meta: Option<MaterialMeta>,
    ) -> Result<OpenUrlResult, (String, String)> {
        let watch_url = crate::youtube::canonical_youtube_watch_url(video_id);
        let parsed_watch = Url::parse(&watch_url).map_err(|_| ("URL_INVALID".into(), "Invalid YouTube URL.".into()))?;
        let yt_cookies = (self.youtube_cookies)();
        let yt_cookie_hdr = yt_cookies
            .as_deref()
            .and_then(crate::youtube::cookie_header_for_youtube);
        let previous = self.find_by_url(&parsed_watch).map_err(|e| ("NORMALIZE_FAILED".into(), e))?;
        if let Some(ref existing) = previous {
            let needs_cookie_upgrade = yt_cookie_hdr.is_some()
                && existing.media.as_ref().is_some_and(|m| {
                    m.provider == "youtube"
                        && m.transcript_origin == "absent"
                        && m.duration_sec.is_none()
                });
            if existing.media.is_some() && !is_legacy_collapsed_shownotes(existing) && !needs_cookie_upgrade {
                return self
                    .existing_result(existing.clone(), override_meta.as_ref(), &[requested_url.to_string(), watch_url])
                    .await
                    .map_err(|e| ("NORMALIZE_FAILED".into(), e));
            }
        }

        let id = previous
            .as_ref()
            .map(|p| p.id.clone())
            .unwrap_or_else(|| material_id_of(&parsed_watch));
        let fetched_at = now_iso();
        let mut yt = crate::youtube::fetch_youtube_watch_metadata_with_cookies(
            &self.http,
            video_id,
            yt_cookies.as_deref(),
        )
        .await
        .map_err(|e| (e.code, e.message))?;

        // 1. Build video Show notes view from video description (or Atom feed content)
        let mut notes_reader: Option<ReaderPayload> = None;
        let mut notes_md: Option<String> = None;
        let mut notes_plain: Option<String> = None;

        if let Some(ref desc) = yt.description {
            let mut formatted_md = desc.clone();
            if let Ok(parts) = self.normalizer.normalize_shownotes(desc, &watch_url).await {
                notes_reader = parts.reader;
                if let Some(formatted) = parts.markdown {
                    formatted_md = formatted;
                }
                if yt.chapters.is_empty() {
                    if let Some(ch) = parts.chapters {
                        yt.chapters = ch;
                    }
                }
            }
            notes_plain = Some(desc.clone());
            notes_md = Some(formatted_md);
        } else if let Some(fc) = fallback_content {
            notes_reader = fc.reader;
            notes_md = fc.markdown;
            notes_plain = fc.plain;
        }

        if notes_plain.as_deref().unwrap_or("").trim().is_empty() {
            let fallback = "No video description was provided.".to_string();
            if let Ok(parts) = self.normalizer.normalize_markdown(&fallback, &watch_url).await {
                notes_reader = parts.reader;
            }
            notes_md = Some(fallback.clone());
            notes_plain = Some(fallback);
        }

        let notes_mins = yt
            .duration_sec
            .filter(|&d| d > 0)
            .map(|d| ((d as f64) / 60.0).round().max(1.0) as u32)
            .unwrap_or_else(|| reading_minutes(notes_plain.as_deref().unwrap_or("")));

        let shownotes_content = MaterialViewContent {
            view: "shownotes".into(),
            media_type: SHOWNOTES_VIEW_MEDIA_TYPE.into(),
            pdf: None,
            reader: notes_reader,
            markdown: notes_md,
            plain: notes_plain,
            reading_minutes: notes_mins,
            quality: ContentNormalizationQuality::default(),
            problems: Vec::new(),
            anchors: None,
            time_anchors: None,
            artifact_body: None,
            report: None,
        };
        let shownotes_bytes = serde_json::to_string(&shownotes_content)
            .map(|s| s.len() as u64)
            .unwrap_or(0);
        self.write_view_content(&id, &shownotes_content, None)
            .map_err(|e| ("NORMALIZE_FAILED".into(), e))?;
        let shownotes_view = MaterialView {
            id: "shownotes".into(),
            label: view_label("shownotes").into(),
            url: watch_url.clone(),
            media_type: SHOWNOTES_VIEW_MEDIA_TYPE.into(),
            status: "ready".into(),
            fetched_at: Some(fetched_at.clone()),
            byte_length: Some(shownotes_bytes),
            pdf: None,
            error: None,
        };

        // 2. Crop Storyboard keyframes into `figures/<id>/<index>.png` -> `quire-figure://<id>/<index>.png`
        let mut keyframes: Vec<TranscriptKeyframeDto> = Vec::new();
        if let Some(ref sb) = yt.storyboard {
            let batches = crate::youtube::plan_storyboard_crops(sb, &yt.chapters, yt.duration_sec);
            for batch in batches {
                let Ok(sheet_u) = assert_public_http_url(&batch.sheet_url) else {
                    continue;
                };
                let Ok(sheet_page) = fetch_page(&self.http, &sheet_u, "image/jpeg,image/webp,image/*,*/*;q=0.5").await else {
                    continue;
                };
                let req_regions: Vec<StoryboardCropInputRegion> = batch
                    .regions
                    .iter()
                    .map(|r| StoryboardCropInputRegion {
                        index: r.index,
                        x: r.x,
                        y: r.y,
                        width: r.width,
                        height: r.height,
                    })
                    .collect();
                let Ok(cropped) = self
                    .normalizer
                    .crop_storyboard_sheet(&sheet_page.bytes, &sheet_page.media_type, &req_regions)
                    .await
                else {
                    continue;
                };
                for frame in cropped {
                    let Some(meta_region) = batch.regions.iter().find(|r| r.index == frame.index) else {
                        continue;
                    };
                    let Ok(png_bytes) = base64::engine::general_purpose::STANDARD.decode(&frame.png_base64) else {
                        continue;
                    };
                    if let Ok(fig_url) = self.figures.write(&id, frame.index, &png_bytes) {
                        keyframes.push(TranscriptKeyframeDto {
                            time_sec: meta_region.time_sec,
                            url: fig_url,
                            caption: Some(meta_region.caption.clone()),
                            width: Some(frame.width),
                            height: Some(frame.height),
                        });
                    }
                }
            }
            keyframes.sort_by(|a, b| a.time_sec.partial_cmp(&b.time_sec).unwrap_or(std::cmp::Ordering::Equal));
        }

        // 3. Fetch ranked caption track (`srv3` preferred, raw XML/VTT fallback)
        let mut normalized_tx = None;
        let mut transcript_origin = "absent".to_string();
        let mut caption_url_used = watch_url.clone();

        for track in &yt.captions {
            let sep = if track.base_url.contains('?') { '&' } else { '?' };
            let srv3_url = format!("{}{}fmt=srv3", track.base_url, sep);
            for candidate_url in [srv3_url.as_str(), track.base_url.as_str()] {
                let Ok(cu) = assert_public_http_url(candidate_url) else {
                    continue;
                };
                let Ok(cap_page) = crate::youtube::fetch_youtube_page_with_cookies(
                    &self.http,
                    &cu,
                    "*/*",
                    yt_cookie_hdr.as_deref(),
                )
                .await
                else {
                    continue;
                };
                let raw_text = String::from_utf8_lossy(&cap_page.bytes).to_string();
                if raw_text.trim().is_empty() {
                    continue;
                }
                if let Ok(tx) = self
                    .normalizer
                    .normalize_transcript(NormalizeTranscriptInput {
                        raw_text: Some(raw_text),
                        media_type: Some(cap_page.media_type),
                        cues: None,
                        chapters: if yt.chapters.is_empty() { None } else { Some(yt.chapters.clone()) },
                        keyframes: if keyframes.is_empty() { None } else { Some(keyframes.clone()) },
                        title: Some(yt.title.clone()),
                    })
                    .await
                {
                    if !tx.time_anchors.is_empty() {
                        caption_url_used = candidate_url.to_string();
                        transcript_origin = if track.is_auto {
                            "auto_captions".into()
                        } else {
                            "captions".into()
                        };
                        normalized_tx = Some(tx);
                        break;
                    }
                }
            }
            if normalized_tx.is_some() {
                break;
            }
        }

        let (
            primary_view,
            media_type,
            reader,
            markdown,
            plain,
            time_anchors,
            reading_mins,
            views,
        ) = if let Some(tx) = normalized_tx {
            fs::create_dir_all(self.dir()).map_err(|e| ("NORMALIZE_FAILED".into(), e.to_string()))?;
            if let Ok(raw_json) = serde_json::to_string(&tx.cues) {
                let _ = fs::write(self.dir().join(format!("{id}.transcript.raw.json")), raw_json);
            }
            let tx_content = MaterialViewContent {
                view: "transcript".into(),
                media_type: TRANSCRIPT_VIEW_MEDIA_TYPE.into(),
                pdf: None,
                reader: Some(tx.reader.clone()),
                markdown: Some(tx.markdown.clone()),
                plain: Some(tx.plain.clone()),
                reading_minutes: tx.reading_minutes,
                quality: ContentNormalizationQuality::default(),
                problems: Vec::new(),
                anchors: None,
                time_anchors: Some(tx.time_anchors.clone()),
                artifact_body: None,
                report: None,
            };
            let tx_len = serde_json::to_string(&tx_content)
                .map(|s| s.len() as u64)
                .unwrap_or(0);
            self.write_view_content(&id, &tx_content, None)
                .map_err(|e| ("NORMALIZE_FAILED".into(), e))?;
            let tx_view = MaterialView {
                id: "transcript".into(),
                label: view_label("transcript").into(),
                url: caption_url_used,
                media_type: TRANSCRIPT_VIEW_MEDIA_TYPE.into(),
                status: "ready".into(),
                fetched_at: Some(fetched_at.clone()),
                byte_length: Some(tx_len),
                pdf: None,
                error: None,
            };
            (
                "transcript".to_string(),
                TRANSCRIPT_VIEW_MEDIA_TYPE.to_string(),
                Some(tx.reader),
                Some(tx.markdown),
                Some(tx.plain),
                Some(tx.time_anchors),
                tx.reading_minutes,
                vec![tx_view, shownotes_view],
            )
        } else {
            (
                "shownotes".to_string(),
                SHOWNOTES_VIEW_MEDIA_TYPE.to_string(),
                shownotes_content.reader,
                shownotes_content.markdown,
                shownotes_content.plain,
                None,
                shownotes_content.reading_minutes,
                vec![shownotes_view],
            )
        };

        let mut base_meta = MaterialMeta {
            kind: Some("videoRecording".into()),
            title: Some(yt.title.clone()),
            publication: yt.author.clone(),
            date: yt.published_at.clone(),
            creators: yt.author.map(|name| {
                vec![Creator {
                    role: "author".into(),
                    name,
                    given: None,
                    family: None,
                }]
            }),
            ..Default::default()
        };
        if let Some(ref ov) = override_meta {
            base_meta = apply_overrides(&base_meta, Some(ov));
        }

        let mut rec = StoredRecord {
            id,
            url: watch_url.clone(),
            final_url: watch_url.clone(),
            title: yt.title,
            byline: byline_of(base_meta.creators.as_deref()),
            published_at: yt.published_at,
            fetched_at,
            reading_minutes: reading_mins,
            origin: origin.to_string(),
            media_type,
            quality: ContentNormalizationQuality::default(),
            lineage: previous.as_ref().and_then(|p| p.lineage.clone()),
            rebuilt_as: previous.as_ref().and_then(|p| p.rebuilt_as.clone()),
            artifact: None,
            aliases: None,
            canonical_url: None,
            pdf: None,
            media: Some(MediaInfo {
                kind: "video".into(),
                provider: "youtube".into(),
                stream_url: watch_url,
                video_id: Some(yt.video_id),
                duration_sec: yt.duration_sec,
                cached_bytes: previous.as_ref().and_then(|p| p.media.as_ref()).and_then(|m| m.cached_bytes),
                transcript_origin,
                chapters: if yt.chapters.is_empty() { None } else { Some(yt.chapters) },
            }),
            capture: None,
            arxiv_version: None,
            extracted: None,
            item_meta: Some(base_meta),
            views: Some(views),
            primary_view: Some(primary_view),
            lang: yt.captions.first().map(|c| c.language_code.clone()),
            dir: None,
            reader,
            markdown,
            plain,
            time_anchors,
            problems: Vec::new(),
            artifact_source: None,
        };
        rec.extracted = Some(fallback_extracted_for(&rec));
        if let Some(ref prev) = previous {
            rec = with_names_of(prev, rec);
        }
        rec = with_aliases(rec, &[requested_url.to_string()]);
        let saved = self.save_stored(rec).map_err(|e| ("NORMALIZE_FAILED".into(), e))?;
        Ok(OpenUrlResult::success(
            self.decorate(&saved).map_err(|e| ("NORMALIZE_FAILED".into(), e))?,
            false,
        ))
    }

    pub async fn materialize_youtube_item(
        &self,
        item: &ItemRecord,
        content: Option<ItemContent>,
        meta: Option<MaterialMeta>,
    ) -> OpenUrlResult {
        let video_id = item
            .signals
            .video_id
            .clone()
            .or_else(|| crate::youtube::parse_youtube_video_id(&item.link));
        let Some(vid) = video_id else {
            return OpenUrlResult::failure("YOUTUBE_ID_INVALID", format!("Not a YouTube video link: {}", item.link));
        };
        match self.open_youtube_video(&vid, &item.link, "feed", content, meta).await {
            Ok(res) => res,
            Err((code, msg)) => OpenUrlResult::failure(code, msg),
        }
    }

    pub fn read_raw_transcript(&self, id: &str) -> Result<Option<Vec<TranscriptCueDto>>, String> {
        if !valid_hex_16(id) {
            return Ok(None);
        }
        let path = self.dir().join(format!("{id}.transcript.raw.json"));
        let Some(bytes) = self.read_optional(&path)? else {
            return Ok(None);
        };
        serde_json::from_slice(&bytes).map(Some).map_err(|e| e.to_string())
    }

    pub fn save_transcribed_view(
        &self,
        id: &str,
        tx: NormalizedTranscriptResult,
        origin: &str,
        overwrite_raw: bool,
    ) -> Result<MaterialRecord, String> {
        let mut record = self.require_stored(id)?;
        fs::create_dir_all(self.dir()).map_err(|e| e.to_string())?;
        if overwrite_raw {
            if let Ok(raw_json) = serde_json::to_string(&tx.cues) {
                let _ = fs::write(self.dir().join(format!("{id}.transcript.raw.json")), raw_json);
            }
        }
        let tx_content = MaterialViewContent {
            view: "transcript".into(),
            media_type: TRANSCRIPT_VIEW_MEDIA_TYPE.into(),
            pdf: None,
            reader: Some(tx.reader.clone()),
            markdown: Some(tx.markdown.clone()),
            plain: Some(tx.plain.clone()),
            reading_minutes: tx.reading_minutes,
            quality: ContentNormalizationQuality::default(),
            problems: Vec::new(),
            anchors: None,
            time_anchors: Some(tx.time_anchors.clone()),
            artifact_body: None,
            report: None,
        };
        let tx_len = serde_json::to_string(&tx_content)
            .map(|s| s.len() as u64)
            .unwrap_or(0);
        self.write_view_content(id, &tx_content, None)?;

        let tx_view = MaterialView {
            id: "transcript".into(),
            label: view_label("transcript").into(),
            url: record.url.clone(),
            media_type: TRANSCRIPT_VIEW_MEDIA_TYPE.into(),
            status: "ready".into(),
            fetched_at: Some(now_iso()),
            byte_length: Some(tx_len),
            pdf: None,
            error: None,
        };

        let existing_views = views_of(&record);
        record.views = Some(upsert_view(&existing_views, tx_view));
        record.primary_view = Some("transcript".into());
        record.media_type = TRANSCRIPT_VIEW_MEDIA_TYPE.into();
        record.reader = Some(tx.reader);
        record.markdown = Some(tx.markdown);
        record.plain = Some(tx.plain);
        record.time_anchors = Some(tx.time_anchors);
        record.reading_minutes = tx.reading_minutes;
        if let Some(ref mut media) = record.media {
            media.transcript_origin = origin.to_string();
        }
        let saved = self.save_stored(record)?;
        self.decorate(&saved)
    }

    pub async fn refine_material_transcript(
        &self,
        id: &str,
        refined_markdown: &str,
    ) -> Result<MaterialRecord, String> {
        let record = self.require_stored(id)?;
        let raw_cues = self.read_raw_transcript(id)?.ok_or_else(|| {
            format!(
                "Material {id} ({}) has no raw transcript cues stored (`{id}.transcript.raw.json`).",
                record.title
            )
        })?;
        let tx = self
            .normalizer
            .refine_transcript(RefineTranscriptInput {
                markdown: refined_markdown.to_string(),
                raw_cues,
                keyframes: None,
                title: Some(record.title.clone()),
            })
            .await?;
        self.save_transcribed_view(id, tx, "agent_refined", false)
    }

    pub async fn import_snapshots(&self, corpus_dir: &Path) -> Result<CorpusImportResult, String> {
        let mut result = CorpusImportResult {
            imported: 0,
            skipped: 0,
            failed: Vec::new(),
        };
        let entries = fs::read_dir(corpus_dir)
            .map_err(|e| format!("Corpus directory not readable: {} ({e})", corpus_dir.display()))?;
        let mut slugs: Vec<String> = entries
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        slugs.sort();

        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct SnapMeta {
            url: String,
            final_url: String,
            fetched_at: String,
        }

        for slug in slugs {
            let step: Result<bool, String> = async {
                let meta_raw = fs::read_to_string(corpus_dir.join(&slug).join("meta.json"))
                    .map_err(|e| e.to_string())?;
                let meta: SnapMeta = serde_json::from_str(&meta_raw).map_err(|e| e.to_string())?;
                let final_u = Url::parse(&meta.final_url).map_err(|e| e.to_string())?;
                if self.find_by_url(&final_u)?.is_some() {
                    return Ok(false);
                }
                let gz_bytes = fs::read(corpus_dir.join(&slug).join("page.html.gz"))
                    .map_err(|e| e.to_string())?;
                let mut decoder = GzDecoder::new(&gz_bytes[..]);
                let mut html_bytes = Vec::new();
                decoder.read_to_end(&mut html_bytes).map_err(|e| e.to_string())?;
                let id = material_id_of(&final_u);
                let mut rec = self
                    .materialize_any(&html_bytes, "text/html", &meta.final_url, &meta.url, "web", &id, None)
                    .await
                    .map_err(|(_, m)| m)?;
                rec.fetched_at = meta.fetched_at.clone();
                if let Some(ref mut cap) = rec.capture {
                    cap.fetched_at = Some(meta.fetched_at);
                }
                self.save_stored(rec)?;
                Ok(true)
            }
            .await;

            match step {
                Ok(true) => result.imported += 1,
                Ok(false) => result.skipped += 1,
                Err(message) => result.failed.push(CorpusFailure { slug, message }),
            }
        }
        Ok(result)
    }

    pub fn bytes(&self, id: &str, view: Option<&str>) -> Result<Option<Vec<u8>>, String> {
        if !valid_hex_16(id) {
            return Ok(None);
        }
        let Some(v) = view else {
            return self.read_optional(&self.pdf_path(id));
        };
        let Some(record) = self.read_stored(id)? else {
            return Ok(None);
        };
        if v == primary_view_of(&record) {
            self.read_optional(&self.pdf_path(id))
        } else {
            self.read_optional(&self.view_pdf_path(id, v))
        }
    }

    pub fn capture_bytes(&self, id: &str) -> Result<Option<Vec<u8>>, String> {
        if !valid_hex_16(id) {
            return Ok(None);
        }
        self.read_optional(&self.html_path(id))
    }

    pub async fn capture_text(&self, id: &str) -> Result<Option<String>, String> {
        let Some(bytes) = self.capture_bytes(id)? else {
            return Ok(None);
        };
        let html = String::from_utf8_lossy(&bytes);
        self.normalizer.capture_text(&html).await.map(Some)
    }

    pub fn delete(&self, ids: &[String]) -> Result<usize, String> {
        if let Some(bad) = ids.iter().find(|id| !valid_hex_16(id)) {
            return Err(format!("Not a material id: {bad}"));
        }
        let mut deleted = 0;
        for id in ids {
            let record = self.read_stored(id)?;
            if record.is_some() {
                deleted += 1;
            }
            let max_rev = record
                .as_ref()
                .and_then(|r| r.artifact.as_ref().map(|a| a.version))
                .unwrap_or(1)
                .saturating_sub(1);
            let _ = fs::remove_file(self.pdf_path(id));
            let _ = fs::remove_file(self.html_path(id));
            let _ = fs::remove_file(self.dir().join(format!("{id}.json")));
            let _ = fs::remove_file(self.dir().join(format!("{id}.transcript.raw.json")));
            for v in MATERIAL_VIEW_IDS {
                let _ = fs::remove_file(self.view_content_path(id, v));
                let _ = fs::remove_file(self.view_pdf_path(id, v));
            }
            for rev in 1..=max_rev {
                let _ = fs::remove_file(self.revision_path(id, rev));
            }
            let _ = self.figures.remove(id);
            let _ = remove_cached_media_files(&self.root, id);
            let _ = self.meta.remove(id);
            if let Ok(mut idx) = self.identities.lock() {
                idx.remove(id);
            }
        }
        Ok(deleted)
    }

    pub async fn image_references(&self, ids: Option<&[String]>) -> Result<HashSet<String>, String> {
        if let Some(list) = ids {
            if let Some(bad) = list.iter().find(|id| !valid_hex_16(id)) {
                return Err(format!("Not a material id: {bad}"));
            }
        }
        fs::create_dir_all(self.dir()).map_err(|e| e.to_string())?;
        let names: HashSet<String> = fs::read_dir(self.dir())
            .map_err(|e| e.to_string())?
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();

        let target_ids: Vec<String> = match ids {
            Some(list) => list.iter().cloned().collect::<HashSet<_>>().into_iter().collect(),
            None => names
                .iter()
                .filter(|n| n.len() == 21 && n.ends_with(".json") && valid_hex_16(&n[..16]))
                .map(|n| n[..16].to_string())
                .collect(),
        };

        let mut urls = HashSet::new();
        for id in target_ids {
            let Some(record) = self.read_stored(&id)? else {
                continue;
            };
            if let Some(u) = reader_image_urls(record.reader.as_ref(), usize::MAX) {
                urls.extend(u);
            } else if let Some(md) = &record.markdown {
                if let Ok(parts) = self.normalizer.normalize_markdown(md, &record.final_url).await {
                    if let Some(u) = reader_image_urls(parts.reader.as_ref(), usize::MAX) {
                        urls.extend(u);
                    }
                }
            }
            for view in MATERIAL_VIEW_IDS {
                if names.contains(&format!("{id}.{view}.json")) {
                    if let Some(vc) = self.read_view_content(&id, view)? {
                        if let Some(u) = reader_image_urls(vc.reader.as_ref(), usize::MAX) {
                            urls.extend(u);
                        }
                    }
                }
            }
            if let Some(info) = artifact_info_of(&record) {
                for rev_num in 1..info.version {
                    if names.contains(&format!("{id}.rev{rev_num}.json")) {
                        if let Some(rev) = self.artifact_revision(&id, rev_num)? {
                            if info.artifact_type == "markdown" {
                                if let Ok(parts) = self.normalizer.normalize_markdown(&rev.source, &record.url).await {
                                    if let Some(u) = reader_image_urls(parts.reader.as_ref(), usize::MAX) {
                                        urls.extend(u);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        Ok(urls)
    }

    pub fn list(&self) -> Result<Vec<MaterialSummary>, String> {
        fs::create_dir_all(self.dir()).map_err(|e| e.to_string())?;
        let metas = self.meta.all()?;
        let mut summaries = Vec::new();
        for entry in fs::read_dir(self.dir()).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let name = entry.file_name().to_string_lossy().to_string();
            if name.len() == 21 && name.ends_with(".json") && valid_hex_16(&name[..16]) {
                let bytes = fs::read(entry.path()).map_err(|e| e.to_string())?;
                let stored: StoredRecord = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
                let ov = metas.get(&stored.id).cloned();
                summaries.push(summary_of(&effective_of(&stored, ov)));
            }
        }
        summaries.sort_by(|a, b| b.fetched_at.cmp(&a.fetched_at));
        Ok(summaries)
    }

    pub fn search(&self, query: &str) -> Result<Vec<MaterialSummary>, String> {
        let words: Vec<String> = query
            .to_lowercase()
            .split_whitespace()
            .filter(|w| !w.is_empty())
            .take(8)
            .map(String::from)
            .collect();
        if words.is_empty() {
            return Ok(Vec::new());
        }
        fs::create_dir_all(self.dir()).map_err(|e| e.to_string())?;
        let metas = self.meta.all()?;
        let mut hits = Vec::new();
        for entry in fs::read_dir(self.dir()).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let name = entry.file_name().to_string_lossy().to_string();
            if name.len() == 21 && name.ends_with(".json") && valid_hex_16(&name[..16]) {
                let bytes = fs::read(entry.path()).map_err(|e| e.to_string())?;
                let stored: StoredRecord = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
                let ov = metas.get(&stored.id).cloned();
                let record = effective_of(&stored, ov);
                let body = record
                    .plain
                    .as_deref()
                    .or(record.markdown.as_deref())
                    .unwrap_or("");
                let body_prefix: String = body.chars().take(200_000).collect();
                let haystack = format!("{}\n{body_prefix}", search_fields_of(&record)).to_lowercase();
                if words.iter().all(|w| haystack.contains(w)) {
                    hits.push(summary_of(&record));
                }
            }
        }
        hits.sort_by(|a, b| b.fetched_at.cmp(&a.fetched_at));
        Ok(hits)
    }

    pub fn export_bibtex(&self, ids: &[String]) -> Result<String, String> {
        let mut found = Vec::new();
        for id in ids {
            if let Some(rec) = self.get(id)? {
                found.push(bibtex_of(&rec.meta, &rec.id));
            }
        }
        if found.is_empty() {
            return Err(format!("None of these materials is in the library: {}.", ids.join(", ")));
        }
        Ok(found.join("\n\n"))
    }
}

// ---------------------------------------------------------------------------
// Library filter, Search hits, Storage usage, BibTeX
// ---------------------------------------------------------------------------

pub fn query_library(summaries: Vec<MaterialSummary>, filter: &LibraryFilter) -> Vec<MaterialSummary> {
    let kind = filter.kind.as_deref().unwrap_or("all");
    let tag = filter.tag.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(str::to_lowercase);
    let words: Vec<String> = filter
        .query
        .as_deref()
        .unwrap_or("")
        .to_lowercase()
        .split_whitespace()
        .filter(|w| !w.is_empty())
        .take(8)
        .map(String::from)
        .collect();

    let mut out: Vec<MaterialSummary> = summaries
        .into_iter()
        .filter(|m| match kind {
            "articles" => m.media_type != "application/pdf" && m.origin != "agent",
            "pdf" => m.media_type == "application/pdf",
            "artifact" => m.origin == "agent",
            "feed" => m.origin == "feed",
            _ => true,
        })
        .filter(|m| filter.material_kind.as_deref().is_none_or(|mk| m.kind == mk))
        .filter(|m| {
            tag.as_deref()
                .is_none_or(|t| m.tags.iter().any(|cand| cand.to_lowercase() == t))
        })
        .filter(|m| {
            if words.is_empty() {
                return true;
            }
            let haystack = format!("{} {} {}", m.title, m.byline.as_deref().unwrap_or(""), m.tags.join(" ")).to_lowercase();
            words.iter().all(|w| haystack.contains(w))
        })
        .collect();

    match filter.sort.as_deref().unwrap_or("fetched") {
        "published" => out.sort_by(|a, b| match (&a.published_at, &b.published_at) {
            (Some(pa), Some(pb)) => pb.cmp(pa).then_with(|| b.fetched_at.cmp(&a.fetched_at)),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => b.fetched_at.cmp(&a.fetched_at),
        }),
        "title" => out.sort_by(|a, b| {
            a.title
                .to_lowercase()
                .cmp(&b.title.to_lowercase())
                .then_with(|| b.fetched_at.cmp(&a.fetched_at))
        }),
        _ => out.sort_by(|a, b| b.fetched_at.cmp(&a.fetched_at)),
    }
    out
}

pub async fn delete_materials(
    ids: &[String],
    store: &MaterialStore,
    annotations: &AnnotationStore,
    items: &ItemStore,
    images: &crate::images::ImageCache,
) -> Result<(usize, usize, DeleteMaterialsResult), String> {
    let pictures = store.image_references(Some(ids)).await;
    let deleted = store.delete(ids)?;
    for id in ids {
        let _ = annotations.delete_all(id);
    }
    let mut unlinked = 0usize;
    for id in ids {
        unlinked += items.unlink_material(id).unwrap_or(0);
    }
    let pictures_kept = match pictures {
        Ok(urls) if !urls.is_empty() => match store.image_references(None).await {
            Ok(kept) => {
                let to_forget: Vec<String> = urls.into_iter().filter(|u| !kept.contains(u)).collect();
                if let Err(e) = images.forget(&to_forget).await {
                    Some(format!("The materials were deleted, but their cached pictures were kept: {e}"))
                } else {
                    None
                }
            }
            Err(e) => Some(format!("The materials were deleted, but their cached pictures were kept: {e}")),
        },
        Ok(_) => None,
        Err(e) => Some(format!("The materials were deleted, but their cached pictures were kept: {e}")),
    };
    Ok((deleted, unlinked, DeleteMaterialsResult { pictures_kept }))
}

pub fn search_hits(query: &str, materials: &[MaterialSummary], items: &[ItemRecord]) -> Vec<SearchHit> {
    if query.split_whitespace().next().is_none() {
        return Vec::new();
    }
    let date_of = |iso: &str| iso.get(0..10).unwrap_or("").to_string();
    let host_of = |raw: &str| {
        Url::parse(raw)
            .ok()
            .and_then(|u| u.host_str().map(|h| h.trim_start_matches("www.").to_string()))
            .unwrap_or_else(|| raw.to_string())
    };
    let join_sub = |a: String, b: String| match (a.is_empty(), b.is_empty()) {
        (false, false) => format!("{a} · {b}"),
        (false, true) => a,
        (true, false) => b,
        (true, true) => String::new(),
    };

    let mut out: Vec<SearchHit> = materials
        .iter()
        .map(|m| SearchHit {
            kind: "material".into(),
            id: m.id.clone(),
            title: m.title.clone(),
            subtitle: join_sub(
                m.byline.clone().unwrap_or_else(|| host_of(&m.url)),
                date_of(m.published_at.as_deref().unwrap_or(&m.fetched_at)),
            ),
        })
        .collect();

    out.extend(items.iter().map(|i| SearchHit {
        kind: "item".into(),
        id: i.id.clone(),
        title: i.title.clone(),
        subtitle: join_sub(i.source_title.clone(), date_of(&i.published_at)),
    }));
    out.truncate(50);
    out
}

fn dir_bytes(path: &Path) -> u64 {
    let Ok(entries) = fs::read_dir(path) else {
        return 0;
    };
    let mut sum = 0u64;
    for entry in entries.flatten() {
        let p = entry.path();
        if let Ok(ft) = entry.file_type() {
            if ft.is_dir() {
                sum += dir_bytes(&p);
            } else if ft.is_file() {
                sum += fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
            }
        }
    }
    sum
}

pub fn storage_usage(data_dir: &Path) -> StorageUsage {
    let db_files = [
        DATABASE_FILE.to_string(),
        format!("{DATABASE_FILE}-wal"),
        format!("{DATABASE_FILE}-shm"),
    ];
    let database = db_files
        .iter()
        .map(|name| fs::metadata(data_dir.join(name)).map(|m| m.len()).unwrap_or(0))
        .sum();
    let media = dir_bytes(&data_dir.join("media"));
    let models = dir_bytes(&data_dir.join("models"));
    StorageUsage {
        materials: dir_bytes(&data_dir.join("materials")),
        images: dir_bytes(&data_dir.join("images")),
        figures: dir_bytes(&data_dir.join("figures")),
        database,
        media: (media > 0).then_some(media),
        models: (models > 0).then_some(models),
    }
}

// ---------------------------------------------------------------------------
// BibTeX export (matching shared/bibtex.ts)
// ---------------------------------------------------------------------------

fn fold_ascii(s: &str) -> String {
    let mut out = String::new();
    for c in s.chars() {
        let folded = match c {
            'À'..='Å' | 'à'..='å' => Some('a'),
            'Ç' | 'ç' => Some('c'),
            'È'..='Ë' | 'è'..='ë' => Some('e'),
            'Ì'..='Ï' | 'ì'..='ï' => Some('i'),
            'Ñ' | 'ñ' => Some('n'),
            'Ò'..='Ö' | 'Ø' | 'ò'..='ö' | 'ø' => Some('o'),
            'Ù'..='Ü' | 'ù'..='ü' => Some('u'),
            'Ý' | 'ý' | 'ÿ' => Some('y'),
            'Ł' | 'ł' => Some('l'),
            _ if c.is_ascii_alphanumeric() => Some(c.to_ascii_lowercase()),
            _ => None,
        };
        if let Some(ch) = folded {
            out.push(ch);
        }
    }
    out
}

pub fn escape_bibtex(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for c in value.chars() {
        if matches!(c, '{' | '}' | '&' | '%' | '#' | '_' | '$') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

pub fn bibtex_of(meta: &MaterialMeta, fallback_key: &str) -> String {
    let kind = meta.kind.as_deref().unwrap_or("webpage");
    let entry_type = match kind {
        "journalArticle" => "article",
        "conferencePaper" => "inproceedings",
        "book" => "book",
        "bookSection" => "incollection",
        "report" => "techreport",
        "thesis" => "phdthesis",
        _ => "misc",
    };

    let authors: Vec<&Creator> = meta
        .creators
        .as_deref()
        .unwrap_or(&[])
        .iter()
        .filter(|c| c.role == "author")
        .collect();
    let first_word = meta
        .title
        .as_deref()
        .unwrap_or("")
        .split_whitespace()
        .next()
        .unwrap_or("");
    let head = if let Some(first_author) = authors.first() {
        let fam = first_author
            .family
            .as_deref()
            .or_else(|| first_author.name.split_whitespace().last())
            .unwrap_or(&first_author.name);
        fold_ascii(fam)
    } else {
        fold_ascii(first_word)
    };
    let year = meta.date.as_deref().and_then(|d| d.get(0..4)).unwrap_or("");
    let key = if head.is_empty() {
        let fb = fold_ascii(fallback_key);
        format!("{}{year}", if fb.is_empty() { "quire" } else { fb.as_str() })
    } else if !authors.is_empty() {
        format!("{head}{year}{}", fold_ascii(first_word))
    } else {
        format!("{head}{year}")
    };

    let fmt_names = |role: &str| -> Option<String> {
        let matching: Vec<String> = meta
            .creators
            .as_deref()
            .unwrap_or(&[])
            .iter()
            .filter(|c| c.role == role)
            .map(|c| match (&c.family, &c.given) {
                (Some(f), Some(g)) if !f.is_empty() && !g.is_empty() => format!("{f}, {g}"),
                _ => c.name.clone(),
            })
            .collect();
        if matching.is_empty() {
            None
        } else {
            Some(matching.join(" and "))
        }
    };

    let pages = meta.pages.as_deref().map(|p| {
        Regex::new(r"(\d)\s*[-–]\s*(\d)")
            .unwrap()
            .replace(p, "$1--$2")
            .to_string()
    });

    let mut fields: Vec<(&str, Option<String>, bool)> = vec![
        ("author", fmt_names("author"), false),
        ("editor", fmt_names("editor"), false),
        (
            "title",
            meta.title.as_deref().filter(|s| !s.is_empty()).map(|t| format!("{{{}}}", escape_bibtex(t))),
            true,
        ),
    ];

    match entry_type {
        "article" => fields.extend([
            ("journal", meta.publication.clone(), false),
            ("volume", meta.volume.clone(), false),
            ("number", meta.issue.clone(), false),
            ("pages", pages, false),
            ("issn", meta.issn.clone(), false),
        ]),
        "inproceedings" => fields.extend([
            ("booktitle", meta.publication.clone(), false),
            ("pages", pages, false),
            ("publisher", meta.publisher.clone(), false),
            ("address", meta.place.clone(), false),
            ("isbn", meta.isbn.clone(), false),
        ]),
        "book" => fields.extend([
            ("publisher", meta.publisher.clone(), false),
            ("address", meta.place.clone(), false),
            ("edition", meta.edition.clone(), false),
            ("series", meta.series.clone(), false),
            ("isbn", meta.isbn.clone(), false),
        ]),
        "incollection" => fields.extend([
            ("booktitle", meta.publication.clone(), false),
            ("pages", pages, false),
            ("publisher", meta.publisher.clone(), false),
            ("address", meta.place.clone(), false),
            ("edition", meta.edition.clone(), false),
            ("isbn", meta.isbn.clone(), false),
        ]),
        "techreport" => fields.extend([
            ("institution", meta.publisher.clone(), false),
            ("address", meta.place.clone(), false),
            ("number", meta.series.clone(), false),
        ]),
        "phdthesis" => fields.extend([
            ("school", meta.publisher.clone(), false),
            ("address", meta.place.clone(), false),
        ]),
        _ => {
            if kind == "preprint" {
                let primary_class = meta.extra.as_deref().and_then(|ex| {
                    Regex::new(r"(?i)arxiv:[^\n]*\[([\w.-]+)\]")
                        .unwrap()
                        .captures(ex)
                        .and_then(|c| c.get(1).map(|m| m.as_str().to_string()))
                });
                fields.extend([
                    ("eprint", meta.arxiv_id.clone(), false),
                    ("archivePrefix", meta.arxiv_id.as_ref().map(|_| "arXiv".to_string()), false),
                    ("primaryClass", primary_class, false),
                    ("publisher", meta.publisher.clone(), false),
                ]);
            } else {
                fields.extend([
                    (
                        "howpublished",
                        meta.url.as_deref().filter(|s| !s.is_empty()).map(|u| format!("\\url{{{u}}}")),
                        true,
                    ),
                    ("publisher", meta.publisher.clone(), false),
                ]);
            }
        }
    }

    let months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    let month = meta
        .date
        .as_deref()
        .and_then(|d| d.get(5..7))
        .and_then(|m| m.parse::<usize>().ok())
        .filter(|m| (1..=12).contains(m))
        .map(|m| months[m - 1].to_string());
    let accessed = meta.accessed.as_deref().and_then(|a| a.get(0..10)).map(String::from);
    let is_web_kind = matches!(
        kind,
        "webpage" | "blogPost" | "newsletter" | "newsArticle" | "document" | "note"
    );

    fields.extend([
        ("year", if year.is_empty() { None } else { Some(year.to_string()) }, false),
        ("month", month, true),
        ("doi", meta.doi.clone(), false),
        ("url", meta.url.clone(), false),
        ("urldate", accessed.clone(), false),
        (
            "note",
            if is_web_kind {
                accessed.map(|a| format!("Accessed {a}"))
            } else {
                None
            },
            false,
        ),
    ]);

    let lines: Vec<String> = fields
        .into_iter()
        .filter_map(|(name, val, raw)| {
            let v = val.filter(|s| !s.is_empty())?;
            if name == "month" {
                Some(format!("  {name} = {v}"))
            } else if raw {
                Some(format!("  {name} = {{{v}}}"))
            } else {
                Some(format!("  {name} = {{{}}}", escape_bibtex(&v)))
            }
        })
        .collect();

    format!("@{entry_type}{{{key},\n{}\n}}", lines.join(",\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bibtex_and_reading_time_match_spec() {
        assert_eq!(reading_minutes("hello world"), 1);
        assert_eq!(reading_minutes(&"word ".repeat(480)), 2);

        let meta = MaterialMeta {
            kind: Some("preprint".into()),
            title: Some("Retrieval & Generation".into()),
            creators: Some(vec![Creator {
                role: "author".into(),
                name: "Eva Lindqvist".into(),
                given: Some("Eva".into()),
                family: Some("Lindqvist".into()),
            }]),
            date: Some("2026-09-12".into()),
            arxiv_id: Some("2609.12345".into()),
            extra: Some("arXiv: 2609.12345 [cs.CL]".into()),
            ..Default::default()
        };
        let bib = bibtex_of(&meta, "0123456789abcdef");
        assert!(bib.starts_with("@misc{lindqvist2026retrieval,"));
        assert!(bib.contains("eprint = {2609.12345}"));
        assert!(bib.contains("primaryClass = {cs.CL}"));
        assert!(bib.contains("month = sep"));
    }

    #[test]
    fn annotations_crud_roundtrips() {
        let tmp = tempfile::tempdir().unwrap();
        let store = AnnotationStore::new(tmp.path());
        let saved = store
            .save(Annotation {
                id: "0123456789abcdef".into(),
                material_id: "fedcba9876543210".into(),
                locator: "text-quote:v1:hello".into(),
                quote: "hello".into(),
                note: Some("note".into()),
                kind: "highlight".into(),
                view: Some("web".into()),
                time_range: None,
                color: "#ffd400".into(),
                created_at: String::new(),
                updated_at: String::new(),
            })
            .unwrap();
        assert!(!saved.created_at.is_empty());
        assert_eq!(store.list("fedcba9876543210").unwrap().len(), 1);
        store.delete("fedcba9876543210", "0123456789abcdef").unwrap();
        assert_eq!(store.list("fedcba9876543210").unwrap().len(), 0);
    }

    #[test]
    fn podcast_episode_matching_handles_redirects_and_cjk_titles() {
        assert!(podcast_episode_matches(
            Some("https://dts.podtrac.com/redirect.m4a/media.xyzcdn.net/65a1b2c3d4e5f6071890abcd.m4a?source=rss"),
            "Other Title",
            "https://media.xyzcdn.net/65a1b2c3d4e5f6071890abcd.m4a?token=apple",
            "Episode Title",
        ));
        assert!(podcast_episode_matches(
            Some("https://cdn.example.com/a.mp3"),
            "vol.62 ｜ 播客到底怎么赚钱？  这次把问题问到了苹果副总裁面前",
            "https://cdn.example.com/b.mp3",
            "vol.62 | 播客到底怎么赚钱？ 这次把问题问到了苹果副总裁面前 ",
        ));
        assert!(!podcast_episode_matches(
            Some("https://cdn.example.com/episode1.mp3"),
            "Episode 1",
            "https://other.example.com/episode1.mp3",
            "Episode 2",
        ));
    }
}
