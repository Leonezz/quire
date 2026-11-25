use crate::http::{assert_public_http_url, fetch_page, FetchError, PAGE_ACCEPT};
use crate::types::{MediaChapter, SourceDetection};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;
use std::time::Duration;
use tauri::http::{header, Response, StatusCode};
use tokio::process::Command;
use url::Url;

pub const PLAYER_CSP: &str = "default-src 'none'; script-src 'unsafe-inline' https://www.youtube.com https://www.youtube-nocookie.com https://s.ytimg.com; frame-src https://www.youtube-nocookie.com https://www.youtube.com; style-src 'unsafe-inline'; img-src https://i.ytimg.com data:; connect-src https://www.youtube.com https://www.youtube-nocookie.com";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum YoutubeTarget {
    DirectFeed {
        feed_url: String,
        channel_id: Option<String>,
    },
    ChannelId {
        channel_id: String,
        feed_url: String,
    },
    Playlist {
        playlist_id: String,
        feed_url: String,
    },
    ChannelPage {
        page_url: String,
    },
    Video {
        video_id: String,
        watch_url: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct YoutubeCaptionTrack {
    pub base_url: String,
    pub language_code: String,
    pub is_auto: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoryboardLevel {
    pub base_template: String,
    pub level_index: usize,
    pub frame_width: u32,
    pub frame_height: u32,
    pub total_count: u32,
    pub cols: u32,
    pub rows: u32,
    pub interval_ms: u64,
    pub name_pattern: String,
    pub sigh: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StoryboardCropRegion {
    pub index: u32,
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
    pub time_sec: f64,
    pub caption: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct StoryboardSheetBatch {
    pub sheet_url: String,
    pub regions: Vec<StoryboardCropRegion>,
}

#[derive(Debug, Clone)]
pub struct YoutubeWatchMetadata {
    pub video_id: String,
    pub title: String,
    pub author: Option<String>,
    pub channel_id: Option<String>,
    pub duration_sec: Option<u32>,
    pub description: Option<String>,
    pub published_at: Option<String>,
    pub captions: Vec<YoutubeCaptionTrack>,
    pub chapters: Vec<MediaChapter>,
    pub storyboard: Option<StoryboardLevel>,
}

pub fn valid_youtube_video_id(id: &str) -> bool {
    id.len() == 11
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

pub fn canonical_youtube_watch_url(video_id: &str) -> String {
    format!("https://www.youtube.com/watch?v={video_id}")
}

pub fn youtube_channel_feed_url(channel_id: &str) -> String {
    format!("https://www.youtube.com/feeds/videos.xml?channel_id={channel_id}")
}

pub fn youtube_playlist_feed_url(playlist_id: &str) -> String {
    format!("https://www.youtube.com/feeds/videos.xml?playlist_id={playlist_id}")
}

fn is_youtube_host(host: &str) -> bool {
    let lower = host.to_ascii_lowercase();
    lower == "youtu.be"
        || lower == "youtube.com"
        || lower.ends_with(".youtube.com")
        || lower == "youtube-nocookie.com"
        || lower.ends_with(".youtube-nocookie.com")
}

pub fn parse_youtube_video_id(raw: &str) -> Option<String> {
    let url = Url::parse(raw.trim()).ok()?;
    let host = url.host_str()?.to_ascii_lowercase();
    if !is_youtube_host(&host) {
        return None;
    }
    if host == "youtu.be" {
        let seg = url.path_segments()?.next()?;
        return valid_youtube_video_id(seg).then(|| seg.to_string());
    }
    let path = url.path();
    if path == "/watch" {
        for (k, v) in url.query_pairs() {
            if k == "v" && valid_youtube_video_id(&v) {
                return Some(v.into_owned());
            }
        }
        return None;
    }
    for prefix in ["/live/", "/shorts/", "/embed/", "/v/"] {
        if let Some(rest) = path.strip_prefix(prefix) {
            let seg = rest.split('/').next().unwrap_or("");
            if valid_youtube_video_id(seg) {
                return Some(seg.to_string());
            }
        }
    }
    None
}

pub fn classify_youtube_url(url: &Url) -> Option<YoutubeTarget> {
    let host = url.host_str()?.to_ascii_lowercase();
    if !is_youtube_host(&host) {
        return None;
    }
    if let Some(video_id) = parse_youtube_video_id(url.as_str()) {
        return Some(YoutubeTarget::Video {
            watch_url: canonical_youtube_watch_url(&video_id),
            video_id,
        });
    }
    if host == "youtu.be" {
        return None;
    }
    let path = url.path();
    if path == "/feeds/videos.xml" {
        let mut channel_id = None;
        let mut has_playlist = false;
        for (k, v) in url.query_pairs() {
            if k == "channel_id" && !v.is_empty() {
                channel_id = Some(v.into_owned());
            } else if k == "playlist_id" && !v.is_empty() {
                has_playlist = true;
            }
        }
        if channel_id.is_some() || has_playlist {
            return Some(YoutubeTarget::DirectFeed {
                feed_url: url.to_string(),
                channel_id,
            });
        }
    }
    if path == "/playlist" {
        for (k, v) in url.query_pairs() {
            if k == "list" && v.len() >= 10 && v.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') {
                let pid = v.into_owned();
                return Some(YoutubeTarget::Playlist {
                    feed_url: youtube_playlist_feed_url(&pid),
                    playlist_id: pid,
                });
            }
        }
    }
    if let Some(rest) = path.strip_prefix("/channel/") {
        let cid = rest.split('/').next().unwrap_or("");
        if cid.starts_with("UC")
            && cid.len() >= 16
            && cid.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        {
            return Some(YoutubeTarget::ChannelId {
                feed_url: youtube_channel_feed_url(cid),
                channel_id: cid.to_string(),
            });
        }
    }
    if path.starts_with("/@") || path.starts_with("/c/") || path.starts_with("/user/") {
        return Some(YoutubeTarget::ChannelPage {
            page_url: url.to_string(),
        });
    }
    None
}

pub fn is_youtube_short_item(link: &str, title: &str, duration_sec: Option<u32>) -> bool {
    if link.to_ascii_lowercase().contains("/shorts/") {
        return true;
    }
    if let Some(d) = duration_sec {
        if d > 0 && d <= 60 {
            return true;
        }
    }
    let lower = title.to_ascii_lowercase();
    lower.contains("#shorts") || lower.ends_with("#short")
}

/// Extracts a balanced `{ ... }` JSON object assigned right after `marker` inside HTML/JS.
pub fn extract_json_after(html: &str, marker: &str) -> Option<serde_json::Value> {
    let start_marker = html.find(marker)?;
    let after = &html[start_marker + marker.len()..];
    let brace_offset = after.find('{')?;
    let slice = &after[brace_offset..];

    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    let mut end_byte = None;

    for (idx, ch) in slice.char_indices() {
        if in_string {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }
        match ch {
            '"' => in_string = true,
            '{' => depth += 1,
            '}' => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    end_byte = Some(idx + ch.len_utf8());
                    break;
                }
            }
            _ => {}
        }
    }

    let end = end_byte?;
    serde_json::from_str(&slice[..end]).ok()
}

fn parse_clock_str(raw: &str) -> Option<f64> {
    let parts: Vec<&str> = raw.trim().split(':').collect();
    match parts.as_slice() {
        [m, s] => {
            let mins = m.parse::<u32>().ok()?;
            let secs = s.parse::<u32>().ok()?;
            if secs >= 60 {
                return None;
            }
            Some((mins * 60 + secs) as f64)
        }
        [h, m, s] => {
            let hours = h.parse::<u32>().ok()?;
            let mins = m.parse::<u32>().ok()?;
            let secs = s.parse::<u32>().ok()?;
            if mins >= 60 || secs >= 60 {
                return None;
            }
            Some((hours * 3600 + mins * 60 + secs) as f64)
        }
        _ => None,
    }
}

pub fn format_clock(seconds: f64) -> String {
    let whole = seconds.max(0.0).floor() as u64;
    let h = whole / 3600;
    let m = (whole % 3600) / 60;
    let s = whole % 60;
    if h > 0 {
        format!("{h}:{m:02}:{s:02}")
    } else {
        format!("{m:02}:{s:02}")
    }
}

pub fn extract_chapters_from_description(description: &str) -> Vec<MediaChapter> {
    let line_re = Regex::new(
        r"^\s*(?:[-*•]\s*)?(?:\(|\[)?(\d{1,2}:\d{2}(?::\d{2})?)(?:\)|\])?(?:\s*[-–—:|·]\s*|\s+)(.+?)\s*$",
    )
    .unwrap();
    let mut chapters: Vec<MediaChapter> = Vec::new();
    let mut last_sec = -1.0_f64;

    for line in description.lines() {
        let Some(caps) = line_re.captures(line) else {
            continue;
        };
        let Some(sec) = parse_clock_str(caps.get(1).map(|m| m.as_str()).unwrap_or("")) else {
            continue;
        };
        let title = caps
            .get(2)
            .map(|m| m.as_str().trim().trim_matches(&['-', '–', '—', ':'][..]).trim())
            .unwrap_or("");
        if title.is_empty() || title.len() > 140 || sec < last_sec {
            continue;
        }
        if chapters.iter().any(|c| (c.start_sec - sec).abs() < 0.5) {
            continue;
        }
        last_sec = sec;
        chapters.push(MediaChapter {
            start_sec: sec,
            title: title.to_string(),
        });
    }
    if chapters.len() >= 2 {
        chapters
    } else {
        Vec::new()
    }
}

fn text_of_yt_value(val: &serde_json::Value) -> Option<String> {
    if let Some(s) = val.get("simpleText").and_then(|v| v.as_str()) {
        let trimmed = s.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    if let Some(runs) = val.get("runs").and_then(|v| v.as_array()) {
        let joined: String = runs
            .iter()
            .filter_map(|r| r.get("text").and_then(|t| t.as_str()))
            .collect();
        let trimmed = joined.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    None
}

fn collect_macro_markers(node: &serde_json::Value, out: &mut Vec<MediaChapter>) {
    match node {
        serde_json::Value::Array(arr) => {
            for item in arr {
                collect_macro_markers(item, out);
            }
        }
        serde_json::Value::Object(map) => {
            if let Some(renderer) = map.get("macroMarkersListItemRenderer") {
                let title = renderer.get("title").and_then(text_of_yt_value);
                let start_sec = renderer
                    .pointer("/onTap/watchEndpoint/startTimeSeconds")
                    .and_then(|v| v.as_f64().or_else(|| v.as_str()?.parse::<f64>().ok()))
                    .or_else(|| {
                        let clock = renderer.get("timeDescription").and_then(text_of_yt_value)?;
                        parse_clock_str(&clock)
                    });
                if let (Some(title), Some(sec)) = (title, start_sec) {
                    if sec >= 0.0 && !out.iter().any(|c| (c.start_sec - sec).abs() < 0.5) {
                        out.push(MediaChapter { start_sec: sec, title });
                    }
                }
            }
            for val in map.values() {
                collect_macro_markers(val, out);
            }
        }
        _ => {}
    }
}

pub fn parse_storyboard_spec(spec: &str, duration_sec: Option<u32>) -> Option<StoryboardLevel> {
    let parts: Vec<&str> = spec.split('|').collect();
    if parts.len() < 2 {
        return None;
    }
    let base_template = parts[0].trim();
    if !base_template.starts_with("https://") && !base_template.starts_with("http://") {
        return None;
    }

    let mut best: Option<StoryboardLevel> = None;
    for (idx, raw_level) in parts[1..].iter().enumerate() {
        let fields: Vec<&str> = raw_level.split('#').collect();
        if fields.len() < 8 {
            continue;
        }
        let Ok(frame_width) = fields[0].parse::<u32>() else { continue };
        let Ok(frame_height) = fields[1].parse::<u32>() else { continue };
        let Ok(total_count) = fields[2].parse::<u32>() else { continue };
        let Ok(cols) = fields[3].parse::<u32>() else { continue };
        let Ok(rows) = fields[4].parse::<u32>() else { continue };
        let raw_interval = fields[5].parse::<u64>().unwrap_or(0);
        if frame_width == 0 || frame_height == 0 || total_count == 0 || cols == 0 || rows == 0 {
            continue;
        }
        let interval_ms = if raw_interval > 0 {
            raw_interval
        } else if let Some(dur) = duration_sec.filter(|&d| d > 0) {
            ((dur as u64) * 1000 / (total_count as u64)).max(1000)
        } else {
            5000
        };
        let candidate = StoryboardLevel {
            base_template: base_template.to_string(),
            level_index: idx,
            frame_width,
            frame_height,
            total_count,
            cols,
            rows,
            interval_ms,
            name_pattern: fields[6].to_string(),
            sigh: fields[7].to_string(),
        };
        let replace = match &best {
            None => true,
            Some(prev) => candidate.frame_width * candidate.frame_height >= prev.frame_width * prev.frame_height,
        };
        if replace {
            best = Some(candidate);
        }
    }
    best
}

impl StoryboardLevel {
    pub fn sheet_url(&self, sheet_idx: u32) -> String {
        let sheet_name = self.name_pattern.replace("$M", &sheet_idx.to_string());
        let mut u = self
            .base_template
            .replace("$L", &self.level_index.to_string())
            .replace("$N", &sheet_name);
        if !self.sigh.is_empty() {
            let sep = if u.contains('?') { '&' } else { '?' };
            let encoded_sigh: String = url::form_urlencoded::byte_serialize(self.sigh.as_bytes()).collect();
            u.push(sep);
            u.push_str("sigh=");
            u.push_str(&encoded_sigh);
        }
        u
    }
}

pub fn plan_storyboard_crops(
    level: &StoryboardLevel,
    chapters: &[MediaChapter],
    duration_sec: Option<u32>,
) -> Vec<StoryboardSheetBatch> {
    let per_sheet = level.cols * level.rows;
    if per_sheet == 0 || level.total_count == 0 || level.interval_ms == 0 {
        return Vec::new();
    }
    let max_sec = duration_sec.map(|d| d as f64).unwrap_or_else(|| {
        ((level.total_count as u64 * level.interval_ms) as f64) / 1000.0
    });

    let targets: Vec<(f64, String)> = if !chapters.is_empty() {
        chapters
            .iter()
            .take(14)
            .map(|ch| (ch.start_sec, format!("{} · {}", format_clock(ch.start_sec), ch.title)))
            .collect()
    } else if max_sec >= 180.0 {
        let step = (max_sec / 6.0).clamp(180.0, 480.0);
        let mut pts = Vec::new();
        let mut t = 15.0;
        while t < max_sec - 10.0 && pts.len() < 8 {
            pts.push((t, format_clock(t)));
            t += step;
        }
        pts
    } else {
        Vec::new()
    };

    let mut seen_frames = std::collections::HashSet::new();
    let mut by_sheet: BTreeMap<u32, (String, Vec<StoryboardCropRegion>)> = BTreeMap::new();
    let mut next_index = 1u32;

    for (time_sec, caption) in targets {
        // Sample 2s after chapter start to avoid black transition fades on slides
        let sample_sec = (time_sec + 2.0).min((max_sec - 1.0).max(0.0));
        let frame_idx = (((sample_sec * 1000.0) / (level.interval_ms as f64)).floor() as u32)
            .min(level.total_count.saturating_sub(1));
        if !seen_frames.insert(frame_idx) {
            continue;
        }
        let sheet_idx = frame_idx / per_sheet;
        let in_sheet = frame_idx % per_sheet;
        let row = in_sheet / level.cols;
        let col = in_sheet % level.cols;
        let region = StoryboardCropRegion {
            index: next_index,
            x: col * level.frame_width,
            y: row * level.frame_height,
            width: level.frame_width,
            height: level.frame_height,
            time_sec,
            caption,
        };
        next_index += 1;
        by_sheet
            .entry(sheet_idx)
            .or_insert_with(|| (level.sheet_url(sheet_idx), Vec::new()))
            .1
            .push(region);
    }

    by_sheet
        .into_values()
        .map(|(sheet_url, regions)| StoryboardSheetBatch { sheet_url, regions })
        .collect()
}

fn clean_youtube_title(raw: &str) -> String {
    let trimmed = raw.trim();
    trimmed
        .strip_suffix(" - YouTube")
        .unwrap_or(trimmed)
        .trim()
        .to_string()
}

pub fn parse_youtube_watch_html(html: &str, fallback_video_id: &str) -> YoutubeWatchMetadata {
    let player = extract_json_after(html, "ytInitialPlayerResponse =")
        .or_else(|| extract_json_after(html, "ytInitialPlayerResponse="));
    let initial_data = extract_json_after(html, "ytInitialData =")
        .or_else(|| extract_json_after(html, "ytInitialData="));

    let details = player.as_ref().and_then(|p| p.get("videoDetails"));
    let micro = player
        .as_ref()
        .and_then(|p| p.pointer("/microformat/playerMicroformatRenderer"));

    let video_id = details
        .and_then(|d| d.get("videoId"))
        .and_then(|v| v.as_str())
        .filter(|s| valid_youtube_video_id(s))
        .unwrap_or(fallback_video_id)
        .to_string();

    let html_title_re = Regex::new(r"(?is)<title[^>]*>(.*?)</title>").unwrap();
    let fallback_title = html_title_re
        .captures(html)
        .and_then(|c| c.get(1))
        .map(|m| clean_youtube_title(&m.as_str().replace("&amp;", "&").replace("&#39;", "'").replace("&quot;", "\"")))
        .filter(|s| !s.is_empty());

    let title = details
        .and_then(|d| d.get("title"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
        .or(fallback_title)
        .unwrap_or_else(|| format!("YouTube video {video_id}"));

    let author = details
        .and_then(|d| d.get("author"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from);

    let channel_id = details
        .and_then(|d| d.get("channelId"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| s.starts_with("UC"))
        .map(String::from);

    let duration_sec = details
        .and_then(|d| d.get("lengthSeconds"))
        .and_then(|v| v.as_str().and_then(|s| s.parse::<u32>().ok()).or_else(|| v.as_u64().map(|n| n as u32)))
        .filter(|&d| d > 0);

    let description = details
        .and_then(|d| d.get("shortDescription"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from);

    let published_at = micro
        .and_then(|m| m.get("publishDate").or_else(|| m.get("uploadDate")))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from);

    // Captions ranking: human captions first, then auto ASR; prefer en / zh or video's primary track
    let mut captions: Vec<YoutubeCaptionTrack> = player
        .as_ref()
        .and_then(|p| p.pointer("/captions/playerCaptionsTracklistRenderer/captionTracks"))
        .and_then(|v| v.as_array())
        .map(|tracks| {
            tracks
                .iter()
                .filter_map(|t| {
                    let base_url = t.get("baseUrl")?.as_str()?.trim().to_string();
                    if base_url.is_empty() {
                        return None;
                    }
                    let language_code = t
                        .get("languageCode")
                        .and_then(|v| v.as_str())
                        .unwrap_or("en")
                        .to_string();
                    let is_auto = t.get("kind").and_then(|v| v.as_str()) == Some("asr");
                    Some(YoutubeCaptionTrack {
                        base_url,
                        language_code,
                        is_auto,
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    captions.sort_by_key(|track| {
        let lang = track.language_code.to_ascii_lowercase();
        let lang_rank = if lang.starts_with("en") || lang.starts_with("zh") {
            0
        } else {
            1
        };
        (if track.is_auto { 1 } else { 0 }, lang_rank)
    });

    // Chapters: official macroMarkers first, fallback to description timestamps
    let mut chapters = Vec::new();
    if let Some(ref data) = initial_data {
        collect_macro_markers(data, &mut chapters);
        chapters.sort_by(|a, b| a.start_sec.partial_cmp(&b.start_sec).unwrap_or(std::cmp::Ordering::Equal));
    }
    if chapters.len() < 2 {
        if let Some(ref desc) = description {
            let from_desc = extract_chapters_from_description(desc);
            if from_desc.len() >= 2 {
                chapters = from_desc;
            }
        }
    }

    let storyboard = player
        .as_ref()
        .and_then(|p| p.pointer("/storyboards/playerStoryboardSpecRenderer/spec"))
        .and_then(|v| v.as_str())
        .and_then(|spec| parse_storyboard_spec(spec, duration_sec));

    YoutubeWatchMetadata {
        video_id,
        title,
        author,
        channel_id,
        duration_sec,
        description,
        published_at,
        captions,
        chapters,
        storyboard,
    }
}

pub fn extract_channel_id_from_html(html: &str) -> Option<(String, Option<String>)> {
    let rss_re = Regex::new(
        r#"https://www\.youtube\.com/feeds/videos\.xml\?channel_id=(UC[A-Za-z0-9_-]{16,})"#,
    )
    .unwrap();
    let ext_re = Regex::new(r#""(?:externalId|channelId|browseId)"\s*:\s*"(UC[A-Za-z0-9_-]{16,})""#).unwrap();
    let cid = rss_re
        .captures(html)
        .and_then(|c| c.get(1))
        .or_else(|| ext_re.captures(html).and_then(|c| c.get(1)))
        .map(|m| m.as_str().to_string())?;

    let og_title_re = Regex::new(r#"(?i)<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']"#).unwrap();
    let title_re = Regex::new(r"(?is)<title[^>]*>([^<]{1,200})</title>").unwrap();
    let title = og_title_re
        .captures(html)
        .and_then(|c| c.get(1))
        .or_else(|| title_re.captures(html).and_then(|c| c.get(1)))
        .map(|m| clean_youtube_title(&m.as_str().replace("&amp;", "&").replace("&#39;", "'")))
        .filter(|s| !s.is_empty() && !s.eq_ignore_ascii_case("YouTube"));

    Some((cid, title))
}

pub async fn detect_youtube_target(
    client: &reqwest::Client,
    target: YoutubeTarget,
) -> Result<SourceDetection, FetchError> {
    match target {
        YoutubeTarget::DirectFeed { feed_url, channel_id } => {
            let u = assert_public_http_url(&feed_url)?;
            let title = if let Ok(page) = fetch_page(client, &u, "application/atom+xml,text/xml,*/*").await {
                let head = String::from_utf8_lossy(&page.bytes[..page.bytes.len().min(32 * 1024)]);
                Regex::new(r"(?s)<feed\b[^>]*>.*?<title[^>]*>([^<]{1,200})</title>")
                    .unwrap()
                    .captures(&head)
                    .and_then(|c| c.get(1))
                    .map(|m| m.as_str().trim().to_string())
                    .filter(|s| !s.is_empty())
            } else {
                None
            };
            Ok(SourceDetection::Youtube {
                url: feed_url,
                channel_id,
                title,
            })
        }
        YoutubeTarget::ChannelId { channel_id, feed_url } => {
            let u = assert_public_http_url(&feed_url)?;
            let title = if let Ok(page) = fetch_page(client, &u, "application/atom+xml,text/xml,*/*").await {
                let head = String::from_utf8_lossy(&page.bytes[..page.bytes.len().min(32 * 1024)]);
                Regex::new(r"(?s)<feed\b[^>]*>.*?<title[^>]*>([^<]{1,200})</title>")
                    .unwrap()
                    .captures(&head)
                    .and_then(|c| c.get(1))
                    .map(|m| m.as_str().trim().to_string())
                    .filter(|s| !s.is_empty())
            } else {
                None
            };
            Ok(SourceDetection::Youtube {
                url: feed_url,
                channel_id: Some(channel_id),
                title,
            })
        }
        YoutubeTarget::Playlist { feed_url, .. } => {
            let u = assert_public_http_url(&feed_url)?;
            let title = if let Ok(page) = fetch_page(client, &u, "application/atom+xml,text/xml,*/*").await {
                let head = String::from_utf8_lossy(&page.bytes[..page.bytes.len().min(32 * 1024)]);
                Regex::new(r"(?s)<feed\b[^>]*>.*?<title[^>]*>([^<]{1,200})</title>")
                    .unwrap()
                    .captures(&head)
                    .and_then(|c| c.get(1))
                    .map(|m| m.as_str().trim().to_string())
                    .filter(|s| !s.is_empty())
            } else {
                None
            };
            Ok(SourceDetection::Youtube {
                url: feed_url,
                channel_id: None,
                title,
            })
        }
        YoutubeTarget::ChannelPage { page_url } => {
            let u = assert_public_http_url(&page_url)?;
            let page = fetch_page(client, &u, PAGE_ACCEPT).await?;
            let html = String::from_utf8_lossy(&page.bytes);
            let Some((cid, title)) = extract_channel_id_from_html(&html) else {
                return Err(FetchError::new(
                    "YOUTUBE_CHANNEL_NOT_FOUND",
                    "Could not resolve a YouTube channel feed from that URL.",
                ));
            };
            Ok(SourceDetection::Youtube {
                url: youtube_channel_feed_url(&cid),
                channel_id: Some(cid),
                title,
            })
        }
        YoutubeTarget::Video { video_id, watch_url } => {
            let u = assert_public_http_url(&watch_url)?;
            let (title, duration_sec, feed, feed_title) = match fetch_page(client, &u, PAGE_ACCEPT).await {
                Ok(page) => {
                    let html = String::from_utf8_lossy(&page.bytes);
                    let meta = parse_youtube_watch_html(&html, &video_id);
                    let feed = meta.channel_id.as_deref().map(youtube_channel_feed_url);
                    (Some(meta.title), meta.duration_sec, feed, meta.author)
                }
                Err(_) => (None, None, None, None),
            };
            Ok(SourceDetection::Episode {
                url: watch_url,
                media_kind: "video".into(),
                title,
                duration_sec,
                feed,
                feed_title,
            })
        }
    }
}

/// Optional Tier-2 local enhancement: uses local `yt-dlp` when present on the machine
/// to resolve a direct MP4/audio stream URL for offline caching or native `<video>` playback.
pub async fn resolve_ytdlp_stream(video_id: &str, custom_path: Option<&str>) -> Option<String> {
    if !valid_youtube_video_id(video_id) {
        return None;
    }
    let mut candidates: Vec<String> = Vec::new();
    if let Some(p) = custom_path.map(str::trim).filter(|s| !s.is_empty()) {
        candidates.push(p.to_string());
    }
    for fixed in ["/opt/homebrew/bin/yt-dlp", "/usr/local/bin/yt-dlp"] {
        if Path::new(fixed).is_file() {
            candidates.push(fixed.to_string());
        }
    }
    candidates.push("yt-dlp".into());

    let watch_url = canonical_youtube_watch_url(video_id);
    for bin in candidates {
        let fut = Command::new(&bin)
            .args([
                "--no-playlist",
                "--no-warnings",
                "-f",
                "best[ext=mp4][height<=720]/best[ext=mp4]/bestaudio",
                "-g",
                &watch_url,
            ])
            .output();
        let Ok(Ok(out)) = tokio::time::timeout(Duration::from_secs(10), fut).await else {
            continue;
        };
        if !out.status.success() {
            continue;
        }
        let stdout = String::from_utf8_lossy(&out.stdout);
        for line in stdout.lines() {
            let trimmed = line.trim();
            if let Ok(u) = assert_public_http_url(trimmed) {
                return Some(u.to_string());
            }
        }
    }
    None
}

pub fn parse_player_youtube_id(raw: &str) -> Option<String> {
    let parsed = Url::parse(raw).ok()?;
    let id = if parsed.scheme() == "quire-player" && parsed.host_str() == Some("youtube") {
        parsed.path().trim_matches('/')
    } else if (parsed.scheme() == "http" || parsed.scheme() == "https")
        && parsed.host_str() == Some("quire-player.localhost")
    {
        parsed.path().strip_prefix("/youtube/")?.trim_matches('/')
    } else {
        return None;
    };
    valid_youtube_video_id(id).then(|| id.to_string())
}

pub fn youtube_player_html(video_id: &str) -> String {
    format!(
        r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  html, body, #player {{ margin: 0; width: 100%; height: 100%; background: #0b0c0f; overflow: hidden; }}
  iframe {{ border: 0; width: 100%; height: 100%; }}
</style>
</head>
<body>
<div id="player"></div>
<script>
(() => {{
  const videoId = {video_id:?};
  const post = (payload) => parent.postMessage({{ quirePlayer: 1, videoId, ...payload }}, "*");
  let player = null;
  let ready = false;
  let ticker = null;
  const queued = [];

  const startTicker = () => {{
    if (ticker) return;
    ticker = setInterval(() => {{
      if (!ready || !player || typeof player.getCurrentTime !== "function") return;
      post({{
        event: "time",
        currentTime: Number(player.getCurrentTime() || 0),
        duration: Number(player.getDuration() || 0),
      }});
    }}, 250);
  }};

  const stopTicker = () => {{
    if (ticker) {{ clearInterval(ticker); ticker = null; }}
  }};

  const runCmd = (msg) => {{
    if (!ready || !player) {{ queued.push(msg); return; }}
    if (msg.cmd === "play") player.playVideo();
    else if (msg.cmd === "pause") player.pauseVideo();
    else if (msg.cmd === "seek" && typeof msg.value === "number") player.seekTo(msg.value, true);
    else if (msg.cmd === "rate" && typeof msg.value === "number" && typeof player.setPlaybackRate === "function") player.setPlaybackRate(msg.value);
  }};

  window.addEventListener("message", (ev) => {{
    if (ev.source !== parent || !ev.data || ev.data.quirePlayer !== 1) return;
    runCmd(ev.data);
  }});

  window.onYouTubeIframeAPIReady = () => {{
    player = new window.YT.Player("player", {{
      host: "https://www.youtube-nocookie.com",
      videoId,
      playerVars: {{
        autoplay: 0,
        controls: 0,
        disablekb: 1,
        fs: 0,
        iv_load_policy: 3,
        modestbranding: 1,
        playsinline: 1,
        rel: 0,
      }},
      events: {{
        onReady: () => {{
          ready = true;
          post({{ event: "ready", duration: Number(player.getDuration() || 0) }});
          while (queued.length) runCmd(queued.shift());
        }},
        onStateChange: (e) => {{
          const playing = e.data === 1;
          const ended = e.data === 0;
          if (playing) startTicker(); else stopTicker();
          post({{
            event: "state",
            playing,
            ended,
            currentTime: Number(player.getCurrentTime() || 0),
            duration: Number(player.getDuration() || 0),
          }});
        }},
        onError: (e) => {{
          stopTicker();
          post({{ event: "error", code: e.data }});
        }},
      }},
    }});
  }};

  const tag = document.createElement("script");
  tag.src = "https://www.youtube.com/iframe_api";
  tag.onerror = () => post({{ event: "error", code: "NETWORK" }});
  document.head.appendChild(tag);
}})();
</script>
</body>
</html>"#
    )
}

pub fn player_protocol_response(raw_url: &str) -> Response<Vec<u8>> {
    let Some(video_id) = parse_player_youtube_id(raw_url) else {
        return Response::builder()
            .status(StatusCode::NOT_FOUND)
            .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
            .header("x-content-type-options", "nosniff")
            .body(b"Not found".to_vec())
            .unwrap();
    };
    let html = youtube_player_html(&video_id);
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .header(header::CONTENT_SECURITY_POLICY, PLAYER_CSP)
        .header(header::CACHE_CONTROL, "no-store")
        .header("x-content-type-options", "nosniff")
        .body(html.into_bytes())
        .unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_youtube_videos_channels_playlists_and_shorts() {
        assert_eq!(
            parse_youtube_video_id("https://youtu.be/zjkBMFhNj_g?si=abc"),
            Some("zjkBMFhNj_g".into())
        );
        assert_eq!(
            parse_youtube_video_id("https://www.youtube.com/watch?v=zjkBMFhNj_g&t=120s"),
            Some("zjkBMFhNj_g".into())
        );
        assert_eq!(
            parse_youtube_video_id("https://www.youtube.com/live/zjkBMFhNj_g"),
            Some("zjkBMFhNj_g".into())
        );

        let handle_u = Url::parse("https://www.youtube.com/@AndrejKarpathy").unwrap();
        assert_eq!(
            classify_youtube_url(&handle_u),
            Some(YoutubeTarget::ChannelPage {
                page_url: "https://www.youtube.com/@AndrejKarpathy".into()
            })
        );

        let pl_u = Url::parse("https://www.youtube.com/playlist?list=PLAqhIrjkxbuWI23v9cThsA9GvCAUhRvKZ").unwrap();
        assert_eq!(
            classify_youtube_url(&pl_u),
            Some(YoutubeTarget::Playlist {
                playlist_id: "PLAqhIrjkxbuWI23v9cThsA9GvCAUhRvKZ".into(),
                feed_url: "https://www.youtube.com/feeds/videos.xml?playlist_id=PLAqhIrjkxbuWI23v9cThsA9GvCAUhRvKZ".into(),
            })
        );

        assert!(is_youtube_short_item("https://www.youtube.com/shorts/abcdefghijk", "Quick tip", Some(120)));
        assert!(is_youtube_short_item("https://www.youtube.com/watch?v=abcdefghijk", "Clip", Some(48)));
        assert!(is_youtube_short_item("https://www.youtube.com/watch?v=abcdefghijk", "Demo #shorts", None));
        assert!(!is_youtube_short_item("https://www.youtube.com/watch?v=zjkBMFhNj_g", "Intro to LLMs", Some(3600)));
    }

    #[test]
    fn extracts_player_response_captions_chapters_and_storyboard_crops() {
        let html = r#"<!doctype html><html><head><title>Intro to Large Language Models - YouTube</title></head><body>
        <script>var ytInitialPlayerResponse = {"videoDetails":{"videoId":"zjkBMFhNj_g","title":"Intro to Large Language Models","lengthSeconds":"3600","channelId":"UCXUPKJO5MZQN11PqgIvyuvQ","author":"Andrej Karpathy","shortDescription":"00:00 Intro to {LLMs}\n05:00 Pretraining Stage\n15:30 Fine-tuning & RLHF"},"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":[{"baseUrl":"https://www.youtube.com/api/timedtext?v=zjkBMFhNj_g&kind=asr","languageCode":"en","kind":"asr"},{"baseUrl":"https://www.youtube.com/api/timedtext?v=zjkBMFhNj_g&lang=en","languageCode":"en"}]}},"storyboards":{"playerStoryboardSpecRenderer":{"spec":"https://i.ytimg.com/sb/zjkBMFhNj_g/storyboard3_L$L/$N.jpg?sqp=1|160#90#100#5#5#10000#M$M#rs$AOn1|320#180#100#3#3#10000#M$M#rs$AOn2"}}};</script>
        </body></html>"#;

        let meta = parse_youtube_watch_html(html, "zjkBMFhNj_g");
        assert_eq!(meta.title, "Intro to Large Language Models");
        assert_eq!(meta.author.as_deref(), Some("Andrej Karpathy"));
        assert_eq!(meta.channel_id.as_deref(), Some("UCXUPKJO5MZQN11PqgIvyuvQ"));
        assert_eq!(meta.duration_sec, Some(3600));
        // Human track ranked ahead of ASR track
        assert_eq!(meta.captions.len(), 2);
        assert!(!meta.captions[0].is_auto);
        assert!(meta.captions[1].is_auto);
        // Chapters parsed from description despite braces inside string literal
        assert_eq!(meta.chapters.len(), 3);
        assert_eq!(meta.chapters[1].start_sec, 300.0);
        assert_eq!(meta.chapters[1].title, "Pretraining Stage");

        let sb = meta.storyboard.expect("storyboard");
        assert_eq!(sb.frame_width, 320);
        assert_eq!(sb.frame_height, 180);
        assert_eq!(sb.cols, 3);
        assert_eq!(sb.rows, 3);

        let batches = plan_storyboard_crops(&sb, &meta.chapters, meta.duration_sec);
        assert!(!batches.is_empty());
        // Chapter 0 at 0s -> sample 2s -> frame 0 (sheet 0, x=0, y=0)
        // Chapter 1 at 300s -> sample 302s -> frame 30 (per_sheet=9 -> sheet 3, in_sheet=3 -> row 1, col 0 -> x=0, y=180)
        let all_regions: Vec<_> = batches.iter().flat_map(|b| b.regions.iter()).collect();
        assert_eq!(all_regions.len(), 3);
        assert_eq!((all_regions[1].x, all_regions[1].y), (0, 180));
        assert!(batches.iter().any(|b| b.sheet_url.contains("storyboard3_L1/M3.jpg") && b.sheet_url.contains("sigh=")));
    }

    #[test]
    fn serves_quire_player_html_with_strict_csp() {
        let resp = player_protocol_response("quire-player://youtube/zjkBMFhNj_g");
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(
            resp.headers().get(header::CONTENT_SECURITY_POLICY).unwrap().to_str().unwrap(),
            PLAYER_CSP
        );
        let body = String::from_utf8_lossy(resp.body());
        assert!(body.contains("youtube-nocookie.com"));
        assert!(body.contains("zjkBMFhNj_g"));

        let bad = player_protocol_response("quire-player://youtube/../../etc/passwd");
        assert_eq!(bad.status(), StatusCode::NOT_FOUND);
    }
}
