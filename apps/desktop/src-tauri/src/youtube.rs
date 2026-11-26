use crate::http::{assert_public_http_url, fetch_page, is_private_host, FetchError, FetchedPage, PAGE_ACCEPT};
use crate::settings::SettingsStore;
use crate::types::{MediaChapter, Settings, SourceDetection};
use futures_util::StreamExt;
use rand::RngCore;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::http::{header, Response, StatusCode};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use tokio::process::Command;
use url::Url;

const SAFARI_MACOS_UA: &str =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15";
const YOUTUBE_AUTH_WINDOW_LABEL: &str = "youtube-auth";
const YOUTUBE_LOGIN_URL: &str = "https://accounts.google.com/ServiceLogin?service=youtube&uilel=3&passive=true&hl=en&continue=https%3A%2F%2Fwww.youtube.com%2F";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StoredYoutubeCookie {
    pub name: String,
    pub value: String,
    pub domain: String,
    pub path: String,
    pub secure: bool,
    pub http_only: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_unix: Option<i64>,
}

pub fn is_youtube_cookie_domain(domain: &str) -> bool {
    let bare = domain.trim().trim_start_matches('.').to_ascii_lowercase();
    bare == "youtube.com" || bare.ends_with(".youtube.com")
}

pub fn is_youtube_or_google_cookie_domain(domain: &str) -> bool {
    let bare = domain.trim().trim_start_matches('.').to_ascii_lowercase();
    is_youtube_cookie_domain(&bare) || bare == "google.com" || bare.ends_with(".google.com")
}

pub fn has_youtube_auth_cookies(cookies: &[StoredYoutubeCookie]) -> bool {
    let yt_only: Vec<&StoredYoutubeCookie> = cookies
        .iter()
        .filter(|c| is_youtube_cookie_domain(&c.domain) && !c.value.trim().is_empty())
        .collect();
    let has_primary = yt_only.iter().any(|c| {
        matches!(
            c.name.as_str(),
            "SAPISID" | "__Secure-1PSID" | "__Secure-3PSID" | "__Secure-1PAPISID" | "__Secure-3PAPISID"
        )
    });
    let has_session = yt_only.iter().any(|c| {
        matches!(
            c.name.as_str(),
            "LOGIN_INFO" | "SID" | "HSID" | "SSID" | "__Secure-1PSIDTS" | "__Secure-3PSIDTS"
        )
    });
    has_primary && has_session
}

fn current_unix_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

pub fn cookie_header_for_youtube(cookies_json: &str) -> Option<String> {
    let parsed: Vec<StoredYoutubeCookie> = serde_json::from_str(cookies_json).ok()?;
    let now = current_unix_seconds();
    let mut seen = std::collections::HashSet::new();
    let mut pairs = Vec::new();
    for c in parsed {
        if !is_youtube_cookie_domain(&c.domain) {
            continue;
        }
        let bare = c.domain.trim().trim_start_matches('.').to_ascii_lowercase();
        if bare != "youtube.com" && bare != "www.youtube.com" {
            continue;
        }
        if let Some(exp) = c.expires_unix {
            if exp > 0 && exp + 60 < now {
                continue;
            }
        }
        let name = c.name.trim();
        let value = c.value.trim();
        if name.is_empty()
            || name.contains([';', '\r', '\n', ' ', '\t'])
            || value.contains([';', '\r', '\n'])
        {
            continue;
        }
        if seen.insert(name.to_string()) {
            pairs.push(format!("{name}={value}"));
        }
    }
    if pairs.is_empty() {
        None
    } else {
        Some(pairs.join("; "))
    }
}

pub fn format_netscape_cookies_txt(cookies_json: &str, now_unix: i64) -> Option<String> {
    let parsed: Vec<StoredYoutubeCookie> = serde_json::from_str(cookies_json).ok()?;
    let mut lines = Vec::new();
    for c in parsed {
        if !is_youtube_or_google_cookie_domain(&c.domain) {
            continue;
        }
        if let Some(exp) = c.expires_unix {
            if exp > 0 && exp + 60 < now_unix {
                continue;
            }
        }
        let raw_dom = c.domain.trim().to_ascii_lowercase();
        if raw_dom.is_empty() || raw_dom.contains(['\t', '\r', '\n']) {
            continue;
        }
        // MozillaCookieJar requires `domain.startswith('.') == (include_subdomains == 'TRUE')`.
        let domain = if raw_dom == "youtube.com" || raw_dom == "google.com" {
            format!(".{raw_dom}")
        } else {
            raw_dom
        };
        let include_subdomains = if domain.starts_with('.') { "TRUE" } else { "FALSE" };
        let path = if c.path.trim().is_empty() || c.path.contains(['\t', '\r', '\n']) {
            "/"
        } else {
            c.path.trim()
        };
        let secure = if c.secure { "TRUE" } else { "FALSE" };
        let expires = c
            .expires_unix
            .filter(|&ts| ts > now_unix)
            .unwrap_or(now_unix + 86_400);
        let name = c.name.trim();
        let value = c.value.trim();
        if name.is_empty()
            || name.contains(['\t', '\r', '\n'])
            || value.contains(['\t', '\r', '\n'])
        {
            continue;
        }
        lines.push(format!(
            "{domain}\t{include_subdomains}\t{path}\t{secure}\t{expires}\t{name}\t{value}"
        ));
    }
    if lines.is_empty() {
        return None;
    }
    let mut out = String::from("# Netscape HTTP Cookie File\n# Ephemeral Quire YouTube cookie file\n\n");
    for l in lines {
        out.push_str(&l);
        out.push('\n');
    }
    Some(out)
}

fn write_temp_netscape_cookies(work_dir: &Path, cookies_json: &str) -> Option<PathBuf> {
    let body = format_netscape_cookies_txt(cookies_json, current_unix_seconds())?;
    fs::create_dir_all(work_dir).ok()?;
    let mut rnd = [0u8; 8];
    rand::thread_rng().fill_bytes(&mut rnd);
    let hex: String = rnd.iter().map(|b| format!("{b:02x}")).collect();
    let path = work_dir.join(format!("yt-cookies-{hex}.txt"));
    let mut opts = OpenOptions::new();
    opts.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut file = opts.open(&path).ok()?;
    if file.write_all(body.as_bytes()).is_err() {
        let _ = fs::remove_file(&path);
        return None;
    }
    let _ = file.flush();
    Some(path)
}

fn youtube_cookie_http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        let policy = reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 8 {
                return attempt.error("Too many redirects");
            }
            let next = attempt.url();
            if next.scheme() != "https" {
                return attempt.error("Refusing non-HTTPS redirect with YouTube session");
            }
            let host = next.host_str().unwrap_or("").to_ascii_lowercase();
            let allowed = host == "youtube.com"
                || host.ends_with(".youtube.com")
                || host.ends_with(".googlevideo.com");
            if !allowed || is_private_host(&host) {
                return attempt.error("Refusing cross-domain redirect with YouTube session");
            }
            attempt.follow()
        });
        reqwest::Client::builder()
            .timeout(Duration::from_secs(20))
            .redirect(policy)
            .build()
            .expect("youtube cookie reqwest client")
    })
}

pub async fn fetch_youtube_page_with_cookies(
    default_client: &reqwest::Client,
    url: &Url,
    accept: &str,
    cookie_header: Option<&str>,
) -> Result<FetchedPage, FetchError> {
    let host = url.host_str().unwrap_or("").to_ascii_lowercase();
    let can_attach = cookie_header.is_some()
        && url.scheme() == "https"
        && (host == "www.youtube.com" || host == "youtube.com" || host == "m.youtube.com");
    let Some(hdr) = cookie_header.filter(|_| can_attach) else {
        return fetch_page(default_client, url, accept).await;
    };

    let response = youtube_cookie_http_client()
        .get(url.clone())
        .header(reqwest::header::ACCEPT, accept)
        .header(reqwest::header::ACCEPT_LANGUAGE, "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7")
        .header(reqwest::header::USER_AGENT, SAFARI_MACOS_UA)
        .header(reqwest::header::REFERER, "https://www.youtube.com/")
        .header(reqwest::header::ORIGIN, "https://www.youtube.com")
        .header(reqwest::header::COOKIE, hdr)
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                FetchError::new("TIMEOUT", "The page took longer than 20 seconds.")
            } else {
                FetchError::new("NETWORK", e.to_string())
            }
        })?;

    if !response.status().is_success() {
        let code = response.status().as_u16();
        return Err(FetchError::new(format!("HTTP_{code}"), format!("The page answered {code}.")));
    }
    let final_url = response.url().clone();
    if let Some(h) = final_url.host_str() {
        if is_private_host(h) {
            return Err(FetchError::new("URL_PRIVATE", "The page redirected to a private address."));
        }
    }
    let media_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .split(';')
        .next()
        .unwrap_or("application/octet-stream")
        .trim()
        .to_lowercase();

    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let data = chunk.map_err(|e| FetchError::new("NETWORK", e.to_string()))?;
        if bytes.len() + data.len() > crate::http::MAX_BYTES {
            return Err(FetchError::new("PAGE_TOO_LARGE", "The page is larger than 32 MB."));
        }
        bytes.extend_from_slice(&data);
    }
    Ok(FetchedPage {
        bytes,
        media_type,
        final_url: final_url.to_string(),
    })
}

fn collect_stored_cookies(win: &tauri::WebviewWindow) -> Vec<StoredYoutubeCookie> {
    let Ok(raw_cookies) = win.cookies() else {
        return Vec::new();
    };
    raw_cookies
        .into_iter()
        .filter_map(|c| {
            let domain = c.domain().unwrap_or("").trim().to_string();
            if domain.is_empty() || !is_youtube_or_google_cookie_domain(&domain) {
                return None;
            }
            let name = c.name().trim().to_string();
            if name.is_empty() {
                return None;
            }
            let expires_unix = c.expires_datetime().map(|dt| dt.unix_timestamp());
            Some(StoredYoutubeCookie {
                name,
                value: c.value().to_string(),
                domain,
                path: c.path().unwrap_or("/").to_string(),
                secure: c.secure().unwrap_or(true),
                http_only: c.http_only().unwrap_or(false),
                expires_unix,
            })
        })
        .collect()
}

pub async fn sign_in_youtube_window(
    app: &AppHandle,
    settings: &SettingsStore,
) -> Result<Settings, String> {
    let login_url = Url::parse(YOUTUBE_LOGIN_URL).map_err(|e| e.to_string())?;
    let auth_win = if let Some(existing) = app.get_webview_window(YOUTUBE_AUTH_WINDOW_LABEL) {
        let _ = existing.show();
        let _ = existing.set_focus();
        existing
    } else {
        WebviewWindowBuilder::new(app, YOUTUBE_AUTH_WINDOW_LABEL, WebviewUrl::External(login_url))
            .title("Sign in to YouTube — Quire")
            .inner_size(520.0, 680.0)
            .min_inner_size(420.0, 520.0)
            .resizable(true)
            .center()
            .build()
            .map_err(|e| format!("Could not open YouTube sign-in window: {e}"))?
    };
    let _ = auth_win.set_focus();

    let started = Instant::now();
    let timeout = Duration::from_secs(300);

    while started.elapsed() < timeout {
        tokio::time::sleep(Duration::from_millis(750)).await;

        let Some(win) = app.get_webview_window(YOUTUBE_AUTH_WINDOW_LABEL) else {
            // Window was closed by the user — check shared WKWebsiteDataStore via main window once
            // in case they closed right after finishing login.
            if let Some(main_win) = app.get_webview_window("main") {
                let captured = tokio::task::spawn_blocking(move || collect_stored_cookies(&main_win))
                    .await
                    .unwrap_or_default();
                if has_youtube_auth_cookies(&captured) {
                    let json = serde_json::to_string(&captured).map_err(|e| e.to_string())?;
                    return settings.set_youtube_cookies(Some(&json));
                }
            }
            return Err("YouTube sign-in was cancelled.".into());
        };

        let on_youtube_home = win
            .url()
            .ok()
            .and_then(|u| u.host_str().map(|h| h.to_ascii_lowercase()))
            .is_some_and(|h| {
                (h == "www.youtube.com" || h == "youtube.com" || h == "m.youtube.com")
                    && h != "accounts.youtube.com"
            });

        let win_probe = win.clone();
        let captured = tokio::task::spawn_blocking(move || collect_stored_cookies(&win_probe))
            .await
            .unwrap_or_default();

        if has_youtube_auth_cookies(&captured) && on_youtube_home {
            // Give YouTube 900ms to finish setting __Secure-1PSIDTS / LOGIN_INFO cookies after redirect.
            tokio::time::sleep(Duration::from_millis(900)).await;
            let final_cookies = if let Some(w2) = app.get_webview_window(YOUTUBE_AUTH_WINDOW_LABEL) {
                let w2_probe = w2.clone();
                let latest = tokio::task::spawn_blocking(move || collect_stored_cookies(&w2_probe))
                    .await
                    .unwrap_or_default();
                let _ = w2.close();
                if has_youtube_auth_cookies(&latest) {
                    latest
                } else {
                    captured
                }
            } else {
                captured
            };
            let json = serde_json::to_string(&final_cookies).map_err(|e| e.to_string())?;
            return settings.set_youtube_cookies(Some(&json));
        }
    }

    if let Some(win) = app.get_webview_window(YOUTUBE_AUTH_WINDOW_LABEL) {
        let _ = win.close();
    }
    Err("YouTube sign-in timed out after 5 minutes.".into())
}

pub async fn disconnect_youtube_session(
    app: &AppHandle,
    settings: &SettingsStore,
) -> Result<Settings, String> {
    if let Some(auth_win) = app.get_webview_window(YOUTUBE_AUTH_WINDOW_LABEL) {
        let _ = auth_win.close();
    }
    if let Some(main_win) = app.get_webview_window("main") {
        let _ = tokio::task::spawn_blocking(move || {
            if let Ok(cookies) = main_win.cookies() {
                for c in cookies {
                    let dom = c.domain().unwrap_or("");
                    if is_youtube_or_google_cookie_domain(dom) {
                        let _ = main_win.delete_cookie(c);
                    }
                }
            }
        })
        .await;
    }
    settings.set_youtube_cookies(None)
}

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
    let stripped = trimmed
        .strip_suffix(" - YouTube")
        .unwrap_or(trimmed)
        .trim();
    if stripped.eq_ignore_ascii_case("- youtube") || stripped.eq_ignore_ascii_case("youtube") {
        String::new()
    } else {
        stripped.to_string()
    }
}

fn decode_basic_xml_entities(raw: &str) -> String {
    raw.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
}

#[derive(Default)]
struct InitialVideoInfo {
    title: Option<String>,
    author: Option<String>,
    channel_id: Option<String>,
    description: Option<String>,
    published_at: Option<String>,
}

fn collect_initial_video_info(node: &serde_json::Value, out: &mut InitialVideoInfo) {
    match node {
        serde_json::Value::Array(arr) => {
            for item in arr {
                collect_initial_video_info(item, out);
            }
        }
        serde_json::Value::Object(map) => {
            if let Some(primary) = map.get("videoPrimaryInfoRenderer") {
                if out.title.is_none() {
                    out.title = primary.get("title").and_then(text_of_yt_value);
                }
                if out.published_at.is_none() {
                    out.published_at = primary.get("dateText").and_then(text_of_yt_value);
                }
            }
            if let Some(secondary) = map.get("videoSecondaryInfoRenderer") {
                if out.author.is_none() {
                    out.author = secondary
                        .pointer("/owner/videoOwnerRenderer/title")
                        .and_then(text_of_yt_value);
                }
                if out.channel_id.is_none() {
                    out.channel_id = secondary
                        .pointer("/owner/videoOwnerRenderer/navigationEndpoint/browseEndpoint/browseId")
                        .and_then(|v| v.as_str())
                        .filter(|s| s.starts_with("UC"))
                        .map(String::from);
                }
                if out.description.is_none() {
                    out.description = secondary
                        .pointer("/attributedDescription/content")
                        .and_then(|v| v.as_str())
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .map(String::from)
                        .or_else(|| secondary.get("description").and_then(text_of_yt_value));
                }
            }
            for val in map.values() {
                collect_initial_video_info(val, out);
            }
        }
        _ => {}
    }
}

pub fn parse_youtube_atom_entry_for_video(
    xml: &str,
    video_id: &str,
) -> Option<(Option<String>, Option<String>, Option<String>, Option<String>)> {
    let entry_re = Regex::new(r"(?s)<entry\b[^>]*>(.*?)</entry>").unwrap();
    let vid_re = Regex::new(r"<yt:videoId>\s*([^<\s]+)\s*</yt:videoId>").unwrap();
    let title_re = Regex::new(r"(?s)<title[^>]*>(.*?)</title>").unwrap();
    let author_re = Regex::new(r"(?s)<author>\s*<name[^>]*>(.*?)</name>").unwrap();
    let pub_re = Regex::new(r"<published>\s*([^<\s]+)\s*</published>").unwrap();
    let desc_re = Regex::new(r"(?s)<media:description[^>]*>(.*?)</media:description>").unwrap();

    for caps in entry_re.captures_iter(xml) {
        let block = caps.get(1)?.as_str();
        let Some(found_vid) = vid_re.captures(block).and_then(|c| c.get(1)).map(|m| m.as_str()) else {
            continue;
        };
        if found_vid != video_id {
            continue;
        }
        let title = title_re
            .captures(block)
            .and_then(|c| c.get(1))
            .map(|m| decode_basic_xml_entities(m.as_str().trim()))
            .filter(|s| !s.is_empty());
        let author = author_re
            .captures(block)
            .and_then(|c| c.get(1))
            .map(|m| decode_basic_xml_entities(m.as_str().trim()))
            .filter(|s| !s.is_empty());
        let published = pub_re
            .captures(block)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().trim().to_string())
            .filter(|s| !s.is_empty());
        let description = desc_re
            .captures(block)
            .and_then(|c| c.get(1))
            .map(|m| decode_basic_xml_entities(m.as_str().trim()))
            .filter(|s| !s.is_empty());
        return Some((title, author, published, description));
    }
    None
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
    let mut init_info = InitialVideoInfo::default();
    if let Some(ref data) = initial_data {
        collect_initial_video_info(data, &mut init_info);
    }

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
        .map(|m| clean_youtube_title(&decode_basic_xml_entities(m.as_str())))
        .filter(|s| !s.is_empty());

    let title = details
        .and_then(|d| d.get("title"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
        .or(init_info.title)
        .or(fallback_title)
        .unwrap_or_else(|| format!("YouTube video {video_id}"));

    let author = details
        .and_then(|d| d.get("author"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
        .or(init_info.author);

    let channel_id = details
        .and_then(|d| d.get("channelId"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| s.starts_with("UC"))
        .map(String::from)
        .or(init_info.channel_id);

    let duration_sec = details
        .and_then(|d| d.get("lengthSeconds"))
        .and_then(|v| v.as_str().and_then(|s| s.parse::<u32>().ok()).or_else(|| v.as_u64().map(|n| n as u32)))
        .filter(|&d| d > 0);

    let description = details
        .and_then(|d| d.get("shortDescription"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
        .or(init_info.description);

    let published_at = micro
        .and_then(|m| m.get("publishDate").or_else(|| m.get("uploadDate")))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
        .or(init_info.published_at);

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

#[derive(Deserialize)]
struct YoutubeOembedResponse {
    title: Option<String>,
    author_name: Option<String>,
    author_url: Option<String>,
}

/// Fetches YouTube watch metadata, automatically enriching from YouTube's public oEmbed API
/// and public Atom syndication feed (`feeds/videos.xml`) whenever the watch HTML omits
/// `videoDetails` (for example on unauthenticated datacenter/proxy exit IPs).
pub async fn fetch_youtube_watch_metadata(
    client: &reqwest::Client,
    video_id: &str,
) -> Result<YoutubeWatchMetadata, FetchError> {
    fetch_youtube_watch_metadata_with_cookies(client, video_id, None).await
}

pub async fn fetch_youtube_watch_metadata_with_cookies(
    client: &reqwest::Client,
    video_id: &str,
    youtube_cookies_json: Option<&str>,
) -> Result<YoutubeWatchMetadata, FetchError> {
    let cookie_hdr = youtube_cookies_json.and_then(cookie_header_for_youtube);
    let watch_url = canonical_youtube_watch_url(video_id);
    let parsed_watch = assert_public_http_url(&watch_url)?;
    let mut meta = match fetch_youtube_page_with_cookies(
        client,
        &parsed_watch,
        PAGE_ACCEPT,
        cookie_hdr.as_deref(),
    )
    .await
    {
        Ok(page) => {
            let html = String::from_utf8_lossy(&page.bytes);
            parse_youtube_watch_html(&html, video_id)
        }
        Err(err) => {
            // Still try public oEmbed before failing completely
            YoutubeWatchMetadata {
                video_id: video_id.to_string(),
                title: format!("YouTube video {video_id}"),
                author: None,
                channel_id: None,
                duration_sec: None,
                description: None,
                published_at: None,
                captions: Vec::new(),
                chapters: Vec::new(),
                storyboard: None,
            }
            .tap_err_check(err)?
        }
    };

    let placeholder_title = format!("YouTube video {video_id}");
    let mut author_url: Option<String> = None;

    if meta.title == placeholder_title || meta.author.is_none() || meta.channel_id.is_none() {
        let encoded_watch: String = url::form_urlencoded::byte_serialize(watch_url.as_bytes()).collect();
        if let Ok(oembed_u) = assert_public_http_url(&format!(
            "https://www.youtube.com/oembed?url={encoded_watch}&format=json"
        )) {
            if let Ok(oe_page) = fetch_page(client, &oembed_u, "application/json").await {
                if let Ok(oe) = serde_json::from_slice::<YoutubeOembedResponse>(&oe_page.bytes) {
                    if meta.title == placeholder_title {
                        if let Some(t) = oe.title.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
                            meta.title = t;
                        }
                    }
                    if meta.author.is_none() {
                        meta.author = oe.author_name.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
                    }
                    author_url = oe.author_url.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
                }
            }
        }
    }

    if meta.channel_id.is_none() {
        if let Some(ref au) = author_url {
            if let Ok(parsed_au) = assert_public_http_url(au) {
                if let Some(YoutubeTarget::ChannelId { channel_id, .. }) = classify_youtube_url(&parsed_au) {
                    meta.channel_id = Some(channel_id);
                } else if let Ok(ch_page) = fetch_youtube_page_with_cookies(
                    client,
                    &parsed_au,
                    PAGE_ACCEPT,
                    cookie_hdr.as_deref(),
                )
                .await
                {
                    let ch_html = String::from_utf8_lossy(&ch_page.bytes);
                    if let Some((cid, _)) = extract_channel_id_from_html(&ch_html) {
                        meta.channel_id = Some(cid);
                    }
                }
            }
        }
    }

    if (meta.description.is_none() || meta.published_at.is_none()) && meta.channel_id.is_some() {
        let feed_url = youtube_channel_feed_url(meta.channel_id.as_deref().unwrap_or(""));
        if let Ok(parsed_feed) = assert_public_http_url(&feed_url) {
            if let Ok(feed_page) = fetch_page(client, &parsed_feed, "application/atom+xml,text/xml,*/*").await {
                let xml = String::from_utf8_lossy(&feed_page.bytes);
                if let Some((f_title, f_author, f_pub, f_desc)) = parse_youtube_atom_entry_for_video(&xml, video_id) {
                    if meta.title == placeholder_title {
                        if let Some(t) = f_title {
                            meta.title = t;
                        }
                    }
                    if meta.author.is_none() {
                        meta.author = f_author;
                    }
                    if meta.published_at.is_none() {
                        meta.published_at = f_pub;
                    }
                    if meta.description.is_none() {
                        if let Some(desc) = f_desc {
                            if meta.chapters.len() < 2 {
                                let ch = extract_chapters_from_description(&desc);
                                if ch.len() >= 2 {
                                    meta.chapters = ch;
                                }
                            }
                            meta.description = Some(desc);
                        }
                    }
                }
            }
        }
    }

    Ok(meta)
}

impl YoutubeWatchMetadata {
    fn tap_err_check(self, _err: FetchError) -> Result<Self, FetchError> {
        Ok(self)
    }
}

pub async fn detect_youtube_target(
    client: &reqwest::Client,
    target: YoutubeTarget,
) -> Result<SourceDetection, FetchError> {
    detect_youtube_target_with_cookies(client, target, None).await
}

pub async fn detect_youtube_target_with_cookies(
    client: &reqwest::Client,
    target: YoutubeTarget,
    youtube_cookies_json: Option<&str>,
) -> Result<SourceDetection, FetchError> {
    let cookie_hdr = youtube_cookies_json.and_then(cookie_header_for_youtube);
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
            let page = fetch_youtube_page_with_cookies(client, &u, PAGE_ACCEPT, cookie_hdr.as_deref()).await?;
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
            let placeholder = format!("YouTube video {video_id}");
            let (title, duration_sec, feed, feed_title) =
                match fetch_youtube_watch_metadata_with_cookies(client, &video_id, youtube_cookies_json).await {
                    Ok(meta) => {
                        let feed = meta.channel_id.as_deref().map(youtube_channel_feed_url);
                        let clean_title = if meta.title == placeholder { None } else { Some(meta.title) };
                        (clean_title, meta.duration_sec, feed, meta.author)
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

const YTDLP_AUTHED_EXTRACTOR_ARGS: &str =
    "youtube:player_client=web_safari,mweb,tv,web_creator,web,-tv_downgraded";
const YTDLP_ANON_EXTRACTOR_ARGS: &str =
    "youtube:player_client=visionos,android_vr,web_safari,mweb,-tv_downgraded";

fn push_unique_dir(parts: &mut Vec<String>, candidate: &Path) {
    if candidate.is_dir() {
        let s = candidate.to_string_lossy().to_string();
        if !s.is_empty() && !parts.iter().any(|x| x == &s) {
            parts.push(s);
        }
    }
}

fn augmented_gui_path() -> String {
    let mut parts: Vec<String> = vec!["/opt/homebrew/bin".into(), "/usr/local/bin".into()];
    if let Ok(home) = std::env::var("HOME") {
        let home_p = Path::new(&home);
        push_unique_dir(&mut parts, &home_p.join(".deno/bin"));
        push_unique_dir(&mut parts, &home_p.join(".bun/bin"));
        push_unique_dir(&mut parts, &home_p.join(".volta/bin"));
        let nvm_nodes = home_p.join(".nvm/versions/node");
        if let Ok(entries) = fs::read_dir(&nvm_nodes) {
            let mut vers: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
            vers.sort();
            vers.reverse();
            for v in vers {
                push_unique_dir(&mut parts, &v.join("bin"));
            }
        }
    }
    if let Ok(existing) = std::env::var("PATH") {
        for p in existing.split(':').filter(|s| !s.is_empty()) {
            if !parts.iter().any(|x| x == p) {
                parts.push(p.to_string());
            }
        }
    } else {
        parts.extend(["/usr/bin".into(), "/bin".into(), "/usr/sbin".into(), "/sbin".into()]);
    }
    parts.join(":")
}

fn ytdlp_candidates(custom_path: Option<&str>) -> Vec<String> {
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
    candidates
}

fn configure_ytdlp_base_args(cmd: &mut Command, gui_path: &str) {
    cmd.env("PATH", gui_path).args([
        "--no-playlist",
        "--no-warnings",
        "--js-runtimes",
        "deno",
        "--js-runtimes",
        "node",
        "--js-runtimes",
        "bun",
    ]);
}

fn format_ytdlp_error(last_error: &str, had_cookies: bool) -> String {
    let lower = last_error.to_ascii_lowercase();
    if lower.contains("sign in to confirm") || lower.contains("not a bot") {
        if had_cookies {
            return "YouTube rejected the stored session (\"Sign in to confirm you're not a bot\"). Reconnect your YouTube account in Settings › Sources.".into();
        }
        return "YouTube blocked anonymous audio extraction on your current network/proxy (\"Sign in to confirm you're not a bot\"). Click \"Sign in to YouTube…\" or connect your YouTube account in Settings › Sources.".into();
    }
    if lower.contains("page needs to be reloaded") {
        return "YouTube rejected yt-dlp's player session (\"The page needs to be reloaded\"). Run `brew upgrade yt-dlp` or reconnect your YouTube account in Settings › Sources.".into();
    }
    if last_error.trim().is_empty() {
        return "yt-dlp could not extract media from this YouTube video.".into();
    }
    let clean_err = last_error
        .lines()
        .rfind(|l| l.contains("ERROR:"))
        .unwrap_or(last_error)
        .trim_start_matches("ERROR:")
        .trim();
    format!(
        "yt-dlp failed to extract YouTube audio: {}",
        clean_err.chars().take(240).collect::<String>()
    )
}

/// Optional Tier-2 local enhancement: uses local `yt-dlp` when present on the machine
/// to resolve a direct audio/MP4 stream URL for live Range streaming.
pub async fn resolve_ytdlp_stream(video_id: &str, custom_path: Option<&str>) -> Result<String, String> {
    resolve_ytdlp_stream_with_cookies(video_id, custom_path, None, None).await
}

pub async fn resolve_ytdlp_stream_with_cookies(
    video_id: &str,
    custom_path: Option<&str>,
    youtube_cookies_json: Option<&str>,
    work_dir: Option<&Path>,
) -> Result<String, String> {
    if !valid_youtube_video_id(video_id) {
        return Err("Invalid YouTube video ID.".into());
    }
    let candidates = ytdlp_candidates(custom_path);
    let fallback_tmp = std::env::temp_dir().join("quire-yt");
    let cookie_dir = work_dir.unwrap_or(&fallback_tmp);
    let temp_cookie_file = youtube_cookies_json
        .and_then(|raw| write_temp_netscape_cookies(cookie_dir, raw));

    let watch_url = canonical_youtube_watch_url(video_id);
    let gui_path = augmented_gui_path();
    let mut ran_binary = false;
    let mut last_error = String::new();
    let mut resolved_url: Option<String> = None;

    let mut passes: Vec<(Option<&Path>, &str)> = Vec::new();
    if let Some(ref cookie_path) = temp_cookie_file {
        passes.push((Some(cookie_path.as_path()), YTDLP_AUTHED_EXTRACTOR_ARGS));
    }
    passes.push((None, YTDLP_ANON_EXTRACTOR_ARGS));

    'outer: for (cookie_opt, extractor_args) in passes {
        for bin in &candidates {
            let mut cmd = Command::new(bin);
            configure_ytdlp_base_args(&mut cmd, &gui_path);
            cmd.args(["--extractor-args", extractor_args]);
            if let Some(cookie_path) = cookie_opt {
                cmd.arg("--cookies").arg(cookie_path);
            }
            cmd.args([
                "-f",
                "bestaudio[ext=m4a]/bestaudio/best[ext=mp4]/best",
                "-g",
                &watch_url,
            ]);

            match tokio::time::timeout(Duration::from_secs(30), cmd.output()).await {
                Ok(Ok(out)) => {
                    ran_binary = true;
                    if out.status.success() {
                        let stdout = String::from_utf8_lossy(&out.stdout);
                        for line in stdout.lines() {
                            let trimmed = line.trim();
                            if let Ok(u) = assert_public_http_url(trimmed) {
                                resolved_url = Some(u.to_string());
                                break 'outer;
                            }
                        }
                    } else {
                        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
                        if !stderr.is_empty() {
                            last_error = stderr;
                        }
                    }
                    break;
                }
                Ok(Err(e)) if e.kind() == std::io::ErrorKind::NotFound => {
                    continue;
                }
                Ok(Err(e)) => {
                    ran_binary = true;
                    last_error = e.to_string();
                    break;
                }
                Err(_) => {
                    ran_binary = true;
                    last_error = "yt-dlp timed out after 30s while contacting YouTube.".into();
                    break;
                }
            }
        }
    }

    if let Some(ref cookie_path) = temp_cookie_file {
        let _ = fs::remove_file(cookie_path);
    }

    if let Some(url) = resolved_url {
        return Ok(url);
    }

    if !ran_binary {
        return Err(
            "Install yt-dlp (`brew install yt-dlp`) to extract audio from YouTube videos without public captions."
                .into(),
        );
    }

    Err(format_ytdlp_error(&last_error, youtube_cookies_json.is_some()))
}

fn find_downloaded_media_file(dest_dir: &Path, file_stem: &str) -> Option<(PathBuf, u64)> {
    let prefix = format!("{file_stem}.");
    let entries = fs::read_dir(dest_dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if !name.starts_with(&prefix) {
            continue;
        }
        let lower = name.to_ascii_lowercase();
        if lower.ends_with(".part")
            || lower.ends_with(".ytdl")
            || lower.ends_with(".temp")
            || lower.ends_with(".txt")
            || lower.ends_with(".vtt")
            || lower.ends_with(".srv3")
        {
            continue;
        }
        if let Ok(meta) = entry.metadata() {
            if meta.is_file() && meta.len() > 0 {
                return Some((path, meta.len()));
            }
        }
    }
    None
}

fn cleanup_partial_stem_files(dest_dir: &Path, file_stem: &str) {
    let prefix = format!("{file_stem}.");
    if let Ok(entries) = fs::read_dir(dest_dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with(&prefix))
            {
                let _ = fs::remove_file(p);
            }
        }
    }
}

/// Downloads YouTube audio/video directly to disk through `yt-dlp`, supporting HLS (`m3u8_native`
/// from `web_safari` / `mweb`, which do not require GVS PO tokens), `tv`, and `visionos` fallback.
pub async fn download_ytdlp_media(
    video_id: &str,
    dest_dir: &Path,
    file_stem: &str,
    youtube_cookies_json: Option<&str>,
    work_dir: &Path,
    audio_only: bool,
    cancelled: Option<&std::sync::atomic::AtomicBool>,
) -> Result<(PathBuf, u64), String> {
    if !valid_youtube_video_id(video_id) {
        return Err("Invalid YouTube video ID.".into());
    }
    fs::create_dir_all(dest_dir).map_err(|e| e.to_string())?;
    fs::create_dir_all(work_dir).map_err(|e| e.to_string())?;
    cleanup_partial_stem_files(dest_dir, file_stem);

    let temp_cookie_file = youtube_cookies_json
        .and_then(|raw| write_temp_netscape_cookies(work_dir, raw));
    let candidates = ytdlp_candidates(None);
    let gui_path = augmented_gui_path();
    let watch_url = canonical_youtube_watch_url(video_id);
    let out_template = dest_dir
        .join(format!("{file_stem}.%(ext)s"))
        .to_string_lossy()
        .to_string();
    let fmt_selector = if audio_only {
        "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best[height<=360]/best[height<=480]/best"
    } else {
        "best[ext=mp4][height<=720]/best[ext=webm][height<=720]/best[height<=720]/best"
    };

    let mut passes: Vec<(Option<&Path>, &str)> = Vec::new();
    if let Some(ref cookie_path) = temp_cookie_file {
        passes.push((Some(cookie_path.as_path()), YTDLP_AUTHED_EXTRACTOR_ARGS));
    }
    passes.push((None, YTDLP_ANON_EXTRACTOR_ARGS));

    let mut ran_binary = false;
    let mut last_error = String::new();

    'passes: for (cookie_opt, extractor_args) in passes {
        cleanup_partial_stem_files(dest_dir, file_stem);
        for bin in &candidates {
            let mut cmd = Command::new(bin);
            configure_ytdlp_base_args(&mut cmd, &gui_path);
            cmd.args([
                "--no-part",
                "--extractor-args",
                extractor_args,
                "-f",
                fmt_selector,
                "-o",
                &out_template,
            ]);
            if let Some(cookie_path) = cookie_opt {
                cmd.arg("--cookies").arg(cookie_path);
            }
            cmd.arg(&watch_url);
            cmd.stdout(std::process::Stdio::null());
            cmd.stderr(std::process::Stdio::piped());
            cmd.kill_on_drop(true);

            let mut child = match cmd.spawn() {
                Ok(c) => {
                    ran_binary = true;
                    c
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => {
                    ran_binary = true;
                    last_error = e.to_string();
                    break;
                }
            };

            let started = Instant::now();
            let timeout = Duration::from_secs(600);
            loop {
                if cancelled.is_some_and(|c| c.load(std::sync::atomic::Ordering::Relaxed)) {
                    let _ = child.kill().await;
                    cleanup_partial_stem_files(dest_dir, file_stem);
                    if let Some(ref cp) = temp_cookie_file {
                        let _ = fs::remove_file(cp);
                    }
                    return Err("Cancelled.".into());
                }
                if started.elapsed() > timeout {
                    let _ = child.kill().await;
                    last_error = "yt-dlp timed out while downloading YouTube audio.".into();
                    break;
                }
                match child.try_wait() {
                    Ok(Some(status)) => {
                        if let Some(mut stderr_pipe) = child.stderr.take() {
                            use tokio::io::AsyncReadExt;
                            let mut buf = Vec::new();
                            let _ = stderr_pipe.read_to_end(&mut buf).await;
                            let err_txt = String::from_utf8_lossy(&buf).trim().to_string();
                            if !err_txt.is_empty() {
                                last_error = err_txt;
                            }
                        }
                        if status.success() {
                            if let Some(found) = find_downloaded_media_file(dest_dir, file_stem) {
                                if let Some(ref cp) = temp_cookie_file {
                                    let _ = fs::remove_file(cp);
                                }
                                return Ok(found);
                            }
                        }
                        break;
                    }
                    Ok(None) => {
                        tokio::time::sleep(Duration::from_millis(200)).await;
                    }
                    Err(e) => {
                        last_error = e.to_string();
                        break;
                    }
                }
            }
            // Binary existed and ran for this pass; move to next pass if it failed
            continue 'passes;
        }
    }

    cleanup_partial_stem_files(dest_dir, file_stem);
    if let Some(ref cp) = temp_cookie_file {
        let _ = fs::remove_file(cp);
    }

    if !ran_binary {
        return Err(
            "Install yt-dlp (`brew install yt-dlp`) to extract audio from YouTube videos without public captions."
                .into(),
        );
    }

    Err(format_ytdlp_error(&last_error, youtube_cookies_json.is_some()))
}

fn is_likely_auto_subtitle(lower_filename: &str, content: &str) -> bool {
    lower_filename.contains("-orig.")
        || lower_filename.contains(".orig.")
        || content.contains("<s ac=\"")
        || content.contains("<c>")
}

/// Fallback subtitle extraction via `yt-dlp` (`mweb`/`tv`/`web_safari`) when YouTube's `WEB`
/// `captionTracks` URLs carry `exp=xpe` PO-token experiments and answer empty over direct HTTP.
pub async fn fetch_ytdlp_subtitles(
    video_id: &str,
    youtube_cookies_json: Option<&str>,
    work_dir: &Path,
) -> Option<(String, String, bool)> {
    if !valid_youtube_video_id(video_id) {
        return None;
    }
    let mut rnd = [0u8; 6];
    rand::thread_rng().fill_bytes(&mut rnd);
    let hex: String = rnd.iter().map(|b| format!("{b:02x}")).collect();
    let sub_dir = work_dir.join(format!("yt-subs-{hex}"));
    fs::create_dir_all(&sub_dir).ok()?;

    let temp_cookie_file = youtube_cookies_json
        .and_then(|raw| write_temp_netscape_cookies(work_dir, raw));
    let candidates = ytdlp_candidates(None);
    let gui_path = augmented_gui_path();
    let watch_url = canonical_youtube_watch_url(video_id);
    let out_template = sub_dir.join("sub").to_string_lossy().to_string();
    let extractor_args = if temp_cookie_file.is_some() {
        YTDLP_AUTHED_EXTRACTOR_ARGS
    } else {
        YTDLP_ANON_EXTRACTOR_ARGS
    };

    for bin in &candidates {
        let mut cmd = Command::new(bin);
        configure_ytdlp_base_args(&mut cmd, &gui_path);
        cmd.args([
            "--skip-download",
            "--write-subs",
            "--write-auto-subs",
            "--sub-langs",
            "en.*,zh.*,en,zh",
            "--sub-format",
            "srv3/vtt",
            "--extractor-args",
            extractor_args,
            "-o",
            &out_template,
        ]);
        if let Some(ref cp) = temp_cookie_file {
            cmd.arg("--cookies").arg(cp);
        }
        cmd.arg(&watch_url);

        match tokio::time::timeout(Duration::from_secs(22), cmd.output()).await {
            Ok(Ok(_)) => break,
            Ok(Err(e)) if e.kind() == std::io::ErrorKind::NotFound => continue,
            _ => break,
        }
    }

    if let Some(ref cp) = temp_cookie_file {
        let _ = fs::remove_file(cp);
    }

    let mut best: Option<(usize, String, String, bool)> = None;
    if let Ok(entries) = fs::read_dir(&sub_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            let lower = name.to_ascii_lowercase();
            let media_type = if lower.ends_with(".srv3") {
                "text/xml"
            } else if lower.ends_with(".vtt") {
                "text/vtt"
            } else {
                continue;
            };
            let Ok(text) = fs::read_to_string(&path) else {
                continue;
            };
            if text.trim().is_empty() {
                continue;
            }
            let is_auto = is_likely_auto_subtitle(&lower, &text);
            let rank = match (is_auto, lower.ends_with(".srv3")) {
                (false, true) => 0,
                (false, false) => 1,
                (true, true) => 2,
                (true, false) => 3,
            };
            if best.as_ref().is_none_or(|b| rank < b.0) {
                best = Some((rank, text, media_type.to_string(), is_auto));
            }
        }
    }

    let _ = fs::remove_dir_all(&sub_dir);
    best.map(|(_, txt, mt, is_auto)| (txt, mt, is_auto))
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

pub fn youtube_player_html(video_id: &str, youtube_connected: bool) -> String {
    let embed_host = if youtube_connected {
        "https://www.youtube.com"
    } else {
        "https://www.youtube-nocookie.com"
    };
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
  const embedHost = {embed_host:?};
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
      host: embedHost,
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

pub fn player_protocol_response(raw_url: &str, youtube_connected: bool) -> Response<Vec<u8>> {
    let Some(video_id) = parse_player_youtube_id(raw_url) else {
        return Response::builder()
            .status(StatusCode::NOT_FOUND)
            .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
            .header("x-content-type-options", "nosniff")
            .body(b"Not found".to_vec())
            .unwrap();
    };
    let html = youtube_player_html(&video_id, youtube_connected);
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
        let resp = player_protocol_response("quire-player://youtube/zjkBMFhNj_g", false);
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(
            resp.headers().get(header::CONTENT_SECURITY_POLICY).unwrap().to_str().unwrap(),
            PLAYER_CSP
        );
        let body = String::from_utf8_lossy(resp.body());
        assert!(body.contains("youtube-nocookie.com"));
        assert!(body.contains("zjkBMFhNj_g"));

        let signed_in_resp = player_protocol_response("quire-player://youtube/zjkBMFhNj_g", true);
        let signed_in_body = String::from_utf8_lossy(signed_in_resp.body());
        assert!(signed_in_body.contains("https://www.youtube.com"));
        assert!(!signed_in_body.contains("youtube-nocookie.com"));

        let bad = player_protocol_response("quire-player://youtube/../../etc/passwd", false);
        assert_eq!(bad.status(), StatusCode::NOT_FOUND);
    }

    #[test]
    fn formats_youtube_cookie_headers_and_mozilla_netscape_file() {
        let cookies = vec![
            StoredYoutubeCookie {
                name: "SAPISID".into(),
                value: "sapi_val".into(),
                domain: ".youtube.com".into(),
                path: "/".into(),
                secure: true,
                http_only: false,
                expires_unix: Some(4_102_444_800),
            },
            StoredYoutubeCookie {
                name: "LOGIN_INFO".into(),
                value: "login_tok".into(),
                domain: "youtube.com".into(),
                path: "/".into(),
                secure: true,
                http_only: true,
                expires_unix: None,
            },
            StoredYoutubeCookie {
                name: "SID".into(),
                value: "google_sid".into(),
                domain: ".google.com".into(),
                path: "/".into(),
                secure: true,
                http_only: true,
                expires_unix: Some(4_102_444_800),
            },
        ];
        assert!(has_youtube_auth_cookies(&cookies));
        let json = serde_json::to_string(&cookies).unwrap();

        let hdr = cookie_header_for_youtube(&json).expect("cookie header");
        assert!(hdr.contains("SAPISID=sapi_val"));
        assert!(hdr.contains("LOGIN_INFO=login_tok"));
        assert!(!hdr.contains("google_sid"));

        let netscape = format_netscape_cookies_txt(&json, 1_800_000_000).expect("netscape");
        assert!(netscape.starts_with("# Netscape HTTP Cookie File\n"));
        for line in netscape.lines().filter(|l| !l.is_empty() && !l.starts_with('#')) {
            let cols: Vec<&str> = line.split('\t').collect();
            assert_eq!(cols.len(), 7);
            assert_eq!(cols[0].starts_with('.'), cols[1] == "TRUE");
        }
    }

    #[test]
    fn rejects_dash_youtube_placeholder_and_parses_atom_entry_fallback() {
        let login_gated_html = r#"<!doctype html><html><head><title> - YouTube</title></head><body>
        <script>var ytInitialPlayerResponse = {"playabilityStatus":{"status":"LOGIN_REQUIRED","reason":"Sign in to confirm you’re not a bot"}};</script>
        </body></html>"#;
        let meta = parse_youtube_watch_html(login_gated_html, "zjkBMFhNj_g");
        assert_eq!(meta.title, "YouTube video zjkBMFhNj_g");
        assert_ne!(meta.title, "- YouTube");

        let atom_xml = r#"<?xml version="1.0" encoding="UTF-8"?>
        <feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
          <entry>
            <yt:videoId>zjkBMFhNj_g</yt:videoId>
            <title>[1hr Talk] Intro to Large Language Models</title>
            <author><name>Andrej Karpathy</name></author>
            <published>2023-11-23T02:27:48+00:00</published>
            <media:group>
              <media:description>00:00 Intro &amp; Motivation
05:10 LLM Inference</media:description>
            </media:group>
          </entry>
        </feed>"#;
        let parsed = parse_youtube_atom_entry_for_video(atom_xml, "zjkBMFhNj_g").expect("matched entry");
        assert_eq!(parsed.0.as_deref(), Some("[1hr Talk] Intro to Large Language Models"));
        assert_eq!(parsed.1.as_deref(), Some("Andrej Karpathy"));
        assert_eq!(parsed.2.as_deref(), Some("2023-11-23T02:27:48+00:00"));
        assert_eq!(parsed.3.as_deref(), Some("00:00 Intro & Motivation\n05:10 LLM Inference"));
    }

    #[test]
    fn excludes_deprecated_tv_downgraded_and_formats_ytdlp_diagnostics() {
        assert!(YTDLP_AUTHED_EXTRACTOR_ARGS.contains("web_safari"));
        assert!(YTDLP_AUTHED_EXTRACTOR_ARGS.contains("-tv_downgraded"));
        assert!(YTDLP_ANON_EXTRACTOR_ARGS.contains("visionos"));
        assert!(YTDLP_ANON_EXTRACTOR_ARGS.contains("-tv_downgraded"));

        let reload_msg = format_ytdlp_error(
            "ERROR: [youtube] nqEwi-DU2oo: The page needs to be reloaded.",
            true,
        );
        assert!(reload_msg.contains("brew upgrade yt-dlp"));

        let bot_anon = format_ytdlp_error(
            "ERROR: [youtube] nqEwi-DU2oo: Sign in to confirm you're not a bot",
            false,
        );
        assert!(bot_anon.contains("Sign in to YouTube"));

        let bot_authed = format_ytdlp_error(
            "ERROR: [youtube] nqEwi-DU2oo: Sign in to confirm you're not a bot",
            true,
        );
        assert!(bot_authed.contains("Reconnect your YouTube account"));

        assert!(is_likely_auto_subtitle(
            "sub.en.srv3",
            r#"<timedtext format="3"><body><p t="0" d="2000"><s ac="252">hello</s></p></body></timedtext>"#
        ));
        assert!(!is_likely_auto_subtitle(
            "sub.en.srv3",
            r#"<timedtext format="3"><body><p t="0" d="2000">Hello world.</p></body></timedtext>"#
        ));

        let tmp = tempfile::tempdir().unwrap();
        fs::write(tmp.path().join("yt-job.m4a.part"), b"partial").unwrap();
        fs::write(tmp.path().join("yt-job.en.srv3"), b"<timedtext/>").unwrap();
        assert!(find_downloaded_media_file(tmp.path(), "yt-job").is_none());

        fs::write(tmp.path().join("yt-job.m4a"), b"audio-bytes").unwrap();
        let (found_path, len) = find_downloaded_media_file(tmp.path(), "yt-job").expect("media file");
        assert_eq!(found_path.file_name().and_then(|s| s.to_str()), Some("yt-job.m4a"));
        assert_eq!(len, 11);

        cleanup_partial_stem_files(tmp.path(), "yt-job");
        assert!(find_downloaded_media_file(tmp.path(), "yt-job").is_none());
    }
}
