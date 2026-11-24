use crate::materials::{is_material_view_id, valid_hex_16, MaterialStore};
use crate::sqlite_stores::{now_iso, random_hex_16, sha256_hex};
use crate::types::{
    FeedbackAppInfo, FeedbackCaptureMeta, FeedbackProgress, FeedbackReaderState,
    FeedbackSelectionSaved, MaterialRecord, MaterialViewContent, RenderingFeedback,
    RenderingFeedbackDraft, RenderingFeedbackPackage,
};
use flate2::write::GzEncoder;
use flate2::Compression;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::io::{Cursor, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use url::Url;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

pub const RENDERING_PROBLEM_KINDS: &[&str] = &[
    "missing_content",
    "extra_content",
    "wrong_order",
    "code_or_math",
    "tables",
    "images",
    "metadata",
    "layout",
    "other",
];
pub const MAX_FEEDBACK_NOTE: usize = 20_000;
pub const MAX_ZIP_BYTES: usize = 24 * 1024 * 1024;
const MAX_ISSUE_URL_LENGTH: usize = 6_000;

pub fn slug_for_url(raw_url: &str, fallback: &str) -> String {
    let Ok(parsed) = Url::parse(raw_url) else {
        return fallback.to_string();
    };
    let host = parsed
        .host_str()
        .map(|h| h.trim_start_matches("www."))
        .filter(|h| !h.is_empty())
        .unwrap_or_else(|| parsed.scheme());
    let combined = format!("{host}{}", parsed.path()).to_lowercase();
    let slug = Regex::new(r"[^a-z0-9]+")
        .unwrap()
        .replace_all(&combined, "-")
        .trim_matches('-')
        .chars()
        .take(80)
        .collect::<String>()
        .trim_end_matches('-')
        .to_string();
    if slug.is_empty() {
        fallback.to_string()
    } else {
        slug
    }
}

pub fn valid_issue_url(value: &str) -> Result<String, String> {
    let parsed = Url::parse(value).map_err(|_| format!("Not a URL: {value}"))?;
    if parsed.scheme() != "https" || parsed.host_str() != Some("github.com") {
        return Err(format!("The issue link must be an https://github.com/… URL, not {value}"));
    }
    Ok(parsed.to_string())
}

fn validate_kinds(kinds: &[String], require_one: bool) -> Result<Vec<String>, String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for k in kinds {
        if !RENDERING_PROBLEM_KINDS.contains(&k.as_str()) {
            return Err(format!("Unknown problem kind: {k}"));
        }
        if seen.insert(k.clone()) {
            out.push(k.clone());
        }
    }
    if require_one && out.is_empty() {
        return Err("Pick at least one thing that went wrong.".into());
    }
    Ok(out)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CorpusMeta {
    slug: String,
    url: String,
    final_url: String,
    status: u16,
    content_type: String,
    bytes: u64,
    generator: String,
    fetched_at: String,
    framework: String,
    tags: Vec<String>,
}

pub struct FeedbackSubmission {
    pub record: RenderingFeedback,
    pub slug: String,
    pub warnings: Vec<String>,
}

pub struct FeedbackStore {
    root: PathBuf,
    materials: Arc<MaterialStore>,
    app_info: FeedbackAppInfo,
    submitting: tokio::sync::Mutex<()>,
}

impl FeedbackStore {
    pub fn new(root: impl Into<PathBuf>, materials: Arc<MaterialStore>, app_info: FeedbackAppInfo) -> Self {
        Self {
            root: root.into(),
            materials,
            app_info,
            submitting: tokio::sync::Mutex::new(()),
        }
    }

    pub fn bundle_dir(&self, id: &str) -> Result<PathBuf, String> {
        if !valid_hex_16(id) {
            return Err(format!("Not a feedback id: {id}"));
        }
        Ok(self.root.join(id))
    }

    fn report_path(&self, id: &str) -> Result<PathBuf, String> {
        Ok(self.bundle_dir(id)?.join("report.json"))
    }

    pub fn create(&self, draft: &RenderingFeedbackDraft) -> Result<RenderingFeedback, String> {
        Ok(self.build(draft, true, false)?.record)
    }

    pub fn create_submission(&self, draft: &RenderingFeedbackDraft) -> Result<FeedbackSubmission, String> {
        if draft.prefs.is_none() {
            return Err("prefs must be an object of reading settings.".into());
        }
        self.build(draft, false, true)
    }

    fn build(
        &self,
        draft: &RenderingFeedbackDraft,
        require_kind: bool,
        include_extras: bool,
    ) -> Result<FeedbackSubmission, String> {
        if !valid_hex_16(&draft.material_id) {
            return Err(format!("Not a material id: {}", draft.material_id));
        }
        if !is_material_view_id(&draft.view) {
            return Err(format!("Not a view: {}", draft.view));
        }
        if draft.note.chars().count() > MAX_FEEDBACK_NOTE {
            return Err(format!("The note must be at most {MAX_FEEDBACK_NOTE} characters."));
        }
        let kinds = validate_kinds(&draft.kinds, require_kind)?;

        let material: MaterialRecord = self
            .materials
            .get(&draft.material_id)?
            .ok_or_else(|| format!("Material {} is not in the library.", draft.material_id))?;
        let content: MaterialViewContent = self
            .materials
            .get_view(&draft.material_id, &draft.view)?
            .ok_or_else(|| {
                format!(
                    "The {} view of {:?} is not stored, so there is nothing to report on; open it first.",
                    draft.view, material.title
                )
            })?;

        let is_pdf_view = draft.view == "pdf" || draft.view == "text";
        let original: Option<(bool, Vec<u8>)> = if draft.include_capture {
            if is_pdf_view {
                let bytes = self.materials.bytes(&material.id, Some("pdf"))?.ok_or_else(|| {
                    format!(
                        "The PDF of {:?} is not stored; fetch the PDF view first, or report it without the original.",
                        material.title
                    )
                })?;
                Some((true, bytes))
            } else {
                if material.capture.is_none() {
                    return Err(format!(
                        "{:?} has no saved original page (captures are off in Settings, or it was opened from a file or a feed); report it without the page.",
                        material.title
                    ));
                }
                let bytes = self.materials.capture_bytes(&material.id)?.ok_or_else(|| {
                    format!(
                        "The saved page of {:?} is listed but its file is missing; reopen the page or report it without the page.",
                        material.title
                    )
                })?;
                Some((false, bytes))
            }
        } else {
            None
        };

        let created_at = now_iso();
        let id = sha256_hex(format!("{}\n{created_at}\n{}", material.id, random_hex_16()).as_bytes())[..16].to_string();
        let bundle_dir = self.bundle_dir(&id)?;

        let capture_meta = match &original {
            Some((true, bytes)) => FeedbackCaptureMeta {
                included: true,
                byte_length: Some(bytes.len() as u64),
                media_type: Some("application/pdf".into()),
            },
            Some((false, _)) => FeedbackCaptureMeta {
                included: true,
                byte_length: material.capture.as_ref().map(|c| c.byte_length),
                media_type: material.capture.as_ref().map(|c| c.media_type.clone()),
            },
            None => FeedbackCaptureMeta {
                included: false,
                byte_length: material.capture.as_ref().map(|c| c.byte_length),
                media_type: material.capture.as_ref().map(|c| c.media_type.clone()),
            },
        };

        let record = RenderingFeedback {
            id: id.clone(),
            created_at,
            material_id: material.id.clone(),
            url: material.url.clone(),
            title: material.title.clone(),
            view: draft.view.clone(),
            kinds: kinds.clone(),
            note: draft.note.clone(),
            app: self.app_info.clone(),
            quality: content.quality.clone(),
            problems: content.problems.clone(),
            report: if draft.view == "text" { content.report.clone() } else { None },
            capture: capture_meta,
            bundle_dir: bundle_dir.to_string_lossy().to_string(),
            issue_url: None,
            package: None,
            selection: if include_extras {
                draft.selection.as_ref().map(|s| FeedbackSelectionSaved {
                    quote: s.quote.clone(),
                    prefix: s.prefix.clone(),
                    suffix: s.suffix.clone(),
                })
            } else {
                None
            },
            reader_state: if include_extras {
                Some(FeedbackReaderState {
                    scroll_fraction: draft.viewport.as_ref().map(|v| v.scroll_fraction).unwrap_or(0.0),
                    prefs: draft.prefs.clone().unwrap_or_default(),
                })
            } else {
                None
            },
        };

        let slug = slug_for_url(&material.final_url, &record.id);
        let meta = CorpusMeta {
            slug: slug.clone(),
            url: material.url.clone(),
            final_url: material.final_url.clone(),
            status: 200,
            content_type: if original.as_ref().is_some_and(|(pdf, _)| *pdf) {
                "application/pdf".into()
            } else {
                material
                    .capture
                    .as_ref()
                    .map(|c| c.media_type.clone())
                    .unwrap_or_else(|| material.media_type.clone())
            },
            bytes: if let Some((true, ref b)) = original {
                b.len() as u64
            } else {
                material
                    .capture
                    .as_ref()
                    .map(|c| c.byte_length)
                    .or_else(|| material.pdf.as_ref().map(|p| p.byte_length))
                    .unwrap_or(0)
            },
            generator: String::new(),
            fetched_at: material.fetched_at.clone(),
            framework: "unknown".into(),
            tags: kinds,
        };

        let mut warnings = Vec::new();
        let staging = self.root.join(format!(".{id}.partial"));
        fs::create_dir_all(&staging).map_err(|e| e.to_string())?;

        let write_res: Result<(), String> = (|| {
            fs::write(
                staging.join("meta.json"),
                serde_json::to_string_pretty(&meta).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
            let extracted = content
                .markdown
                .as_deref()
                .or(content.plain.as_deref())
                .unwrap_or("");
            fs::write(staging.join("extracted.md"), extracted).map_err(|e| e.to_string())?;

            if let Some((is_pdf, ref bytes)) = original {
                if is_pdf {
                    fs::write(staging.join("original.pdf"), bytes).map_err(|e| e.to_string())?;
                } else {
                    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
                    encoder.write_all(bytes).map_err(|e| e.to_string())?;
                    let gz = encoder.finish().map_err(|e| e.to_string())?;
                    fs::write(staging.join("page.html.gz"), gz).map_err(|e| e.to_string())?;
                }
            }

            if include_extras {
                if let Some(ref reader) = content.reader {
                    let text = match serde_json::from_str::<serde_json::Value>(&reader.payload) {
                        Ok(doc) => serde_json::to_string_pretty(&serde_json::json!({
                            "schema": reader.schema,
                            "document": doc,
                        }))
                        .unwrap(),
                        Err(e) => {
                            warnings.push(format!(
                                "The reader document is not valid JSON ({e}); it is kept as text in reader-document.json."
                            ));
                            serde_json::to_string_pretty(&serde_json::json!({
                                "schema": reader.schema,
                                "payload": reader.payload,
                            }))
                            .unwrap()
                        }
                    };
                    fs::write(staging.join("reader-document.json"), text).map_err(|e| e.to_string())?;
                }
            }

            fs::write(
                staging.join("report.json"),
                serde_json::to_string_pretty(&record).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
            fs::rename(&staging, &bundle_dir).map_err(|e| e.to_string())?;
            Ok(())
        })();

        if let Err(e) = write_res {
            let _ = fs::remove_dir_all(&staging);
            return Err(e);
        }

        Ok(FeedbackSubmission {
            record,
            slug,
            warnings,
        })
    }

    pub fn save(&self, record: &RenderingFeedback) -> Result<RenderingFeedback, String> {
        let current = self
            .get(&record.id)?
            .ok_or_else(|| format!("Feedback {} does not exist.", record.id))?;
        if current.bundle_dir != record.bundle_dir {
            return Err(format!(
                "Feedback {} lives in {}, not {}.",
                record.id, current.bundle_dir, record.bundle_dir
            ));
        }
        fs::write(
            self.report_path(&record.id)?,
            serde_json::to_string_pretty(record).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        Ok(record.clone())
    }

    pub fn list(&self) -> Result<Vec<RenderingFeedback>, String> {
        fs::create_dir_all(&self.root).map_err(|e| e.to_string())?;
        let mut records = Vec::new();
        for entry in fs::read_dir(&self.root).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            if !entry.file_type().is_ok_and(|t| t.is_dir()) {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if !valid_hex_16(&name) {
                continue;
            }
            if let Ok(raw) = fs::read_to_string(entry.path().join("report.json")) {
                if let Ok(rec) = serde_json::from_str::<RenderingFeedback>(&raw) {
                    records.push(rec);
                }
            }
        }
        records.sort_by(|a, b| b.created_at.cmp(&a.created_at).then_with(|| b.id.cmp(&a.id)));
        Ok(records)
    }

    pub fn get(&self, id: &str) -> Result<Option<RenderingFeedback>, String> {
        let path = self.report_path(id)?;
        match fs::read_to_string(path) {
            Ok(raw) => serde_json::from_str(&raw).map(Some).map_err(|e| e.to_string()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    pub fn delete(&self, id: &str) -> Result<(), String> {
        if self.get(id)?.is_none() {
            return Err(format!("Feedback {id} does not exist."));
        }
        fs::remove_dir_all(self.bundle_dir(id)?).map_err(|e| e.to_string())
    }

    pub fn set_issue_url(&self, id: &str, issue_url: &str) -> Result<RenderingFeedback, String> {
        let mut rec = self
            .get(id)?
            .ok_or_else(|| format!("Feedback {id} does not exist."))?;
        rec.issue_url = Some(valid_issue_url(issue_url)?);
        self.save(&rec)
    }

    pub async fn submit(
        &self,
        draft: &RenderingFeedbackDraft,
        owner: &str,
        repo: &str,
        on_progress: &(dyn Fn(FeedbackProgress) + Send + Sync),
        open_external: &(dyn Fn(&str) -> Result<(), String> + Send + Sync),
        show_in_folder: &(dyn Fn(&Path) -> Result<(), String> + Send + Sync),
    ) -> Result<RenderingFeedback, String> {
        let Ok(_guard) = self.submitting.try_lock() else {
            return Err("A report is already being made; wait for it to finish.".into());
        };
        let submission = self.create_submission(draft)?;
        let mut record = submission.record;
        let mut warnings = submission.warnings;
        let dir = PathBuf::from(&record.bundle_dir);

        on_progress(FeedbackProgress {
            id: record.id.clone(),
            step: "packaging".into(),
            message: "Packaging the report…".into(),
        });

        let entries = collect_bundle_entries(&dir, "")?;
        let zip_bytes = zip_entries(&entries)?;
        let zip_name = format!("quire-report-{}-{}.zip", submission.slug, record.id);
        let zip_path = dir.join(&zip_name);
        if zip_bytes.len() > MAX_ZIP_BYTES {
            warnings.push(format!(
                "Packaging: the zip is {:.1} MB, over the 24 MB that fits GitHub's attachment limit.",
                zip_bytes.len() as f64 / (1024.0 * 1024.0)
            ));
        }
        fs::write(&zip_path, &zip_bytes).map_err(|e| e.to_string())?;

        on_progress(FeedbackProgress {
            id: record.id.clone(),
            step: "opening".into(),
            message: "Opening the issue…".into(),
        });

        let mut pack = RenderingFeedbackPackage {
            zip_path: zip_path.to_string_lossy().to_string(),
            zip_bytes: zip_bytes.len() as u64,
            screenshots: Vec::new(),
            composite: None,
            issue_opened: false,
            revealed: false,
            copied_to_clipboard: false,
            warnings: warnings.clone(),
        };
        record.package = Some(pack.clone());

        let url = issue_url_for(&record, owner, repo);
        match open_external(&url) {
            Ok(()) => pack.issue_opened = true,
            Err(e) => warnings.push(format!("Issue page: {e}")),
        }
        match show_in_folder(&zip_path) {
            Ok(()) => pack.revealed = true,
            Err(e) => warnings.push(format!("Finder: {e}")),
        }
        pack.warnings = warnings;
        record.package = Some(pack);
        self.save(&record)
    }
}

fn collect_bundle_entries(dir: &Path, prefix: &str) -> Result<Vec<(String, Vec<u8>)>, String> {
    let target = if prefix.is_empty() {
        dir.to_path_buf()
    } else {
        dir.join(prefix)
    };
    let mut names: Vec<_> = fs::read_dir(&target)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .collect();
    names.sort_by_key(|e| e.file_name());
    let mut out = Vec::new();
    for entry in names {
        let fname = entry.file_name().to_string_lossy().to_string();
        let rel = if prefix.is_empty() {
            fname.clone()
        } else {
            format!("{prefix}/{fname}")
        };
        let ft = entry.file_type().map_err(|e| e.to_string())?;
        if ft.is_dir() {
            out.extend(collect_bundle_entries(dir, &rel)?);
        } else if ft.is_file() && !fname.ends_with(".zip") {
            let bytes = fs::read(entry.path()).map_err(|e| e.to_string())?;
            out.push((rel, bytes));
        }
    }
    Ok(out)
}

fn zip_entries(entries: &[(String, Vec<u8>)]) -> Result<Vec<u8>, String> {
    let stored_re = Regex::new(r"(?i)\.(png|jpe?g|gz|zip|pdf)$").unwrap();
    let mut cursor = Cursor::new(Vec::new());
    {
        let mut writer = ZipWriter::new(&mut cursor);
        for (path, bytes) in entries {
            let method = if stored_re.is_match(path) {
                CompressionMethod::Stored
            } else {
                CompressionMethod::Deflated
            };
            let opts = SimpleFileOptions::default().compression_method(method);
            writer.start_file(path, opts).map_err(|e| e.to_string())?;
            writer.write_all(bytes).map_err(|e| e.to_string())?;
        }
        writer.finish().map_err(|e| e.to_string())?;
    }
    Ok(cursor.into_inner())
}

// ---------------------------------------------------------------------------
// Prefilled GitHub Issue URL (matching feedback-issue.ts)
// ---------------------------------------------------------------------------

fn kind_label(kind: &str) -> &'static str {
    match kind {
        "missing_content" => "Body text, sections or the ending are missing",
        "extra_content" => "Navigation, related posts, comments, share or subscribe blocks kept as body",
        "wrong_order" => "Paragraphs or sections out of order",
        "code_or_math" => "Code blocks or formulas broken",
        "tables" => "Tables mangled or dropped",
        "images" => "Figures missing, duplicated or wrong",
        "metadata" => "Wrong or missing title, author or date",
        "layout" => "Headings, lists, quotes or footnotes wrong",
        _ => "Other",
    }
}

pub fn issue_url_for(feedback: &RenderingFeedback, owner: &str, repo: &str) -> String {
    let host = Url::parse(&feedback.url)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.trim_start_matches("www.").to_string()))
        .unwrap_or_else(|| "unknown site".into());
    let single_title = feedback.title.split_whitespace().collect::<Vec<_>>().join(" ");
    let title_chars: Vec<char> = single_title.chars().collect();
    let trunc_title = if title_chars.len() > 60 {
        format!("{}…", title_chars[..59].iter().collect::<String>().trim_end())
    } else {
        single_title
    };
    let issue_title = format!("Rendering: {host} — {trunc_title}");

    let codes: Vec<&str> = feedback.problems.iter().map(|p| p.code.as_str()).collect();
    let cap_str = if feedback.capture.included {
        match feedback.capture.byte_length {
            Some(b) => format!(
                "included in the bundle ({b} bytes, {})",
                feedback.capture.media_type.as_deref().unwrap_or("unknown type")
            ),
            None => "included in the bundle".into(),
        }
    } else {
        "not included".into()
    };
    let versions = [
        format!("Quire {} ({})", feedback.app.version, feedback.app.platform),
        format!("normalize {}", feedback.app.normalize),
        format!("view: {}", feedback.view),
        format!(
            "quality: completeness={}, conformance={}, safety={}",
            feedback.quality.completeness, feedback.quality.conformance, feedback.quality.safety
        ),
        format!(
            "problems: {}",
            if codes.is_empty() { "none".into() } else { codes.join(", ") }
        ),
        format!("capture: {cap_str}"),
    ]
    .join("\n");

    let build_with_note = |note_body: &str| -> String {
        let kinds_block: String = feedback
            .kinds
            .iter()
            .map(|k| format!("- {}", kind_label(k)))
            .collect::<Vec<_>>()
            .join("\n");
        let attach_block = feedback.package.as_ref().map(|pack| {
            let zip_base = Path::new(&pack.zip_path)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| pack.zip_path.clone());
            let mac = feedback.app.platform == "darwin";
            let paste = if mac { "⌘V" } else { "Ctrl+V" };
            let shown = if mac { "shown in Finder" } else { "shown in your file manager" };
            let steps = if pack.copied_to_clipboard {
                format!("The screenshot is on your clipboard: press {paste} here. Then drag {zip_base} ({shown}) into this box.")
            } else {
                format!("Drag {zip_base} ({shown}) into this box.")
            };
            format!("**Attachments**\n{steps}")
        });

        let note_sections: Vec<&str> = [
            if kinds_block.is_empty() { None } else { Some(kinds_block.as_str()) },
            if note_body.trim().is_empty() { None } else { Some(note_body) },
            attach_block.as_deref(),
        ]
        .into_iter()
        .flatten()
        .collect();
        let full_note = note_sections.join("\n\n");

        let mut ser = url::form_urlencoded::Serializer::new(String::new());
        ser.append_pair("template", "rendering.yml");
        ser.append_pair("title", &issue_title);
        ser.append_pair("url", &feedback.url);
        ser.append_pair("note", &full_note);
        ser.append_pair("versions", &versions);
        format!("https://github.com/{owner}/{repo}/issues/new?{}", ser.finish())
    };

    let mut note = feedback.note.clone();
    let mut url = build_with_note(&note);
    while url.len() > MAX_ISSUE_URL_LENGTH && !note.is_empty() {
        let chars: Vec<char> = feedback.note.chars().collect();
        let ratio = (MAX_ISSUE_URL_LENGTH as f64 / url.len() as f64) * 0.9;
        let keep = ((note.chars().count() as f64) * ratio).floor() as usize;
        note = if keep > 0 && keep < chars.len() {
            format!("{}…", chars[..keep].iter().collect::<String>().trim_end())
        } else {
            String::new()
        };
        url = build_with_note(&note);
    }
    url
}

#[derive(Deserialize)]
struct PngCheck;

pub fn copy_png_to_clipboard(path: &Path) -> Result<(), String> {
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    if bytes.len() < 24 || &bytes[0..8] != b"\x89PNG\r\n\x1a\n" {
        return Err(format!("{} is not a valid PNG image.", path.display()));
    }
    let _ = PngCheck;
    // On macOS, osascript sets clipboard to «class PNGf» natively without needing a PNG decoder crate!
    #[cfg(target_os = "macos")]
    {
        let status = std::process::Command::new("/usr/bin/osascript")
            .arg("-e")
            .arg(format!("set the clipboard to (read (POSIX file {:?}) as «class PNGf»)", path.to_string_lossy()))
            .status()
            .map_err(|e| e.to_string())?;
        if status.success() {
            return Ok(());
        }
        return Err("osascript could not copy the PNG to the clipboard.".into());
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("Image clipboard copy is only supported on macOS in this build.".into())
    }
}
