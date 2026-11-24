use crate::sqlite_stores::now_iso;
use crate::types::UpdateState;
use futures_util::StreamExt;
use regex::Regex;
use serde::Deserialize;
use std::cmp::Ordering;
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::Notify;

pub const UPDATE_INSTALL_UNAVAILABLE: &str = "UPDATE_INSTALL_UNAVAILABLE";
pub const UPDATE_NOT_AVAILABLE: &str = "UPDATE_NOT_AVAILABLE";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PreId {
    Num(u64),
    Str(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SemVer {
    pub major: u64,
    pub minor: u64,
    pub patch: u64,
    pub prerelease: Vec<PreId>,
}

pub fn parse_semver(text: &str) -> Option<SemVer> {
    let re = Regex::new(r"^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$").unwrap();
    let caps = re.captures(text.trim())?;
    let major = caps.get(1)?.as_str().parse::<u64>().ok()?;
    let minor = caps.get(2)?.as_str().parse::<u64>().ok()?;
    let patch = caps.get(3)?.as_str().parse::<u64>().ok()?;
    let mut prerelease = Vec::new();
    if let Some(tail) = caps.get(4).map(|m| m.as_str()) {
        for part in tail.split('.') {
            if part.is_empty() {
                return None;
            }
            if part.bytes().all(|b| b.is_ascii_digit()) {
                prerelease.push(PreId::Num(part.parse::<u64>().ok()?));
            } else {
                prerelease.push(PreId::Str(part.to_string()));
            }
        }
    }
    Some(SemVer {
        major,
        minor,
        patch,
        prerelease,
    })
}

pub fn compare_semver(a: &SemVer, b: &SemVer) -> Ordering {
    match a.major.cmp(&b.major) {
        Ordering::Equal => {}
        ord => return ord,
    }
    match a.minor.cmp(&b.minor) {
        Ordering::Equal => {}
        ord => return ord,
    }
    match a.patch.cmp(&b.patch) {
        Ordering::Equal => {}
        ord => return ord,
    }
    if a.prerelease.is_empty() && b.prerelease.is_empty() {
        return Ordering::Equal;
    }
    if a.prerelease.is_empty() {
        return Ordering::Greater;
    }
    if b.prerelease.is_empty() {
        return Ordering::Less;
    }
    for (left, right) in a.prerelease.iter().zip(b.prerelease.iter()) {
        let ord = match (left, right) {
            (PreId::Num(x), PreId::Num(y)) => x.cmp(y),
            (PreId::Num(_), PreId::Str(_)) => Ordering::Less,
            (PreId::Str(_), PreId::Num(_)) => Ordering::Greater,
            (PreId::Str(x), PreId::Str(y)) => x.cmp(y),
        };
        if ord != Ordering::Equal {
            return ord;
        }
    }
    a.prerelease.len().cmp(&b.prerelease.len())
}

pub fn format_semver(v: &SemVer) -> String {
    let base = format!("{}.{}.{}", v.major, v.minor, v.patch);
    if v.prerelease.is_empty() {
        base
    } else {
        let tail: Vec<String> = v
            .prerelease
            .iter()
            .map(|p| match p {
                PreId::Num(n) => n.to_string(),
                PreId::Str(s) => s.clone(),
            })
            .collect();
        format!("{base}-{}", tail.join("."))
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct GithubRelease {
    pub tag_name: String,
    pub html_url: String,
    pub body: Option<String>,
    pub draft: Option<bool>,
}

fn decode_entities(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&nbsp;", " ")
}

pub fn html_to_plain_text(html: &str) -> String {
    let strip_scripts = Regex::new(r"(?is)<(?:script|style)\b[^>]*>.*?</(?:script|style)>")
        .unwrap()
        .replace_all(html, "");
    let ws = strip_scripts.split_whitespace().collect::<Vec<_>>().join(" ");
    let br = Regex::new(r"(?i)<br\s*/?>").unwrap().replace_all(&ws, "\n");
    let li = Regex::new(r"(?i)<li\b[^>]*>").unwrap().replace_all(&br, "- ");
    let blocks = Regex::new(r"(?i)</(?:p|div|li|h[1-6]|ul|ol|blockquote|pre|tr)>")
        .unwrap()
        .replace_all(&li, "\n");
    let no_tags = Regex::new(r"<[^>]+>").unwrap().replace_all(&blocks, "");
    let decoded = decode_entities(&no_tags);
    let clean_lines = Regex::new(r"[ \t]*\n[ \t]*").unwrap().replace_all(&decoded, "\n");
    Regex::new(r"\n{3,}")
        .unwrap()
        .replace_all(&clean_lines, "\n\n")
        .trim()
        .to_string()
}

pub fn parse_release_feed(xml: &str) -> Result<Vec<GithubRelease>, String> {
    let root_re = Regex::new(r"(?s)^(?:\u{feff})?\s*(?:<\?xml[^>]*\?>\s*)?<feed\b").unwrap();
    if !root_re.is_match(xml) {
        return Err("The releases feed is not an Atom document.".into());
    }
    let entry_re = Regex::new(r"(?s)<entry\b[^>]*>(.*?)</entry>").unwrap();
    let id_re = Regex::new(r"(?s)<id\b[^>]*>(.*?)</id>").unwrap();
    let title_re = Regex::new(r"(?s)<title\b[^>]*>(.*?)</title>").unwrap();
    let content_re = Regex::new(r"(?s)<content\b[^>]*>(.*?)</content>").unwrap();
    let link_re = Regex::new(r"<link\b([^>]*?)/?>").unwrap();
    let rel_re = Regex::new(r#"\brel="([^"]*)""#).unwrap();
    let href_re = Regex::new(r#"\bhref="([^"]*)""#).unwrap();

    let mut entries_count = 0usize;
    let mut releases = Vec::new();
    for cap in entry_re.captures_iter(xml) {
        entries_count += 1;
        let entry = cap.get(1).map(|m| m.as_str()).unwrap_or("");
        let id_text = id_re.captures(entry).and_then(|c| c.get(1)).map(|m| m.as_str().trim());
        let tag = id_text
            .and_then(|id| id.rsplit('/').next().map(str::trim).filter(|s| !s.is_empty()))
            .map(decode_entities)
            .or_else(|| {
                title_re
                    .captures(entry)
                    .and_then(|c| c.get(1))
                    .map(|m| decode_entities(m.as_str().trim()))
                    .filter(|s| !s.is_empty())
            });
        let mut alt_url = None;
        for lcap in link_re.captures_iter(entry) {
            let attrs = lcap.get(1).map(|m| m.as_str()).unwrap_or("");
            let rel = rel_re.captures(attrs).and_then(|c| c.get(1)).map(|m| m.as_str());
            if rel.is_some() && rel != Some("alternate") {
                continue;
            }
            if let Some(h) = href_re.captures(attrs).and_then(|c| c.get(1)).map(|m| m.as_str()) {
                if !h.is_empty() {
                    alt_url = Some(decode_entities(h));
                    break;
                }
            }
        }
        let (Some(tag_name), Some(html_url)) = (tag, alt_url) else {
            continue;
        };
        let body = content_re
            .captures(entry)
            .and_then(|c| c.get(1))
            .map(|m| html_to_plain_text(&decode_entities(m.as_str().trim())));
        releases.push(GithubRelease {
            tag_name,
            html_url,
            body,
            draft: Some(false),
        });
    }
    if entries_count > 0 && releases.is_empty() {
        return Err("The releases feed has entries, but none names a release tag and page.".into());
    }
    Ok(releases)
}

pub fn pick_latest_release(releases: &[GithubRelease]) -> Option<(SemVer, GithubRelease)> {
    let mut best: Option<(SemVer, GithubRelease)> = None;
    for r in releases {
        if r.draft == Some(true) {
            continue;
        }
        let Some(ver) = parse_semver(&r.tag_name) else {
            continue;
        };
        let replace = match &best {
            Some((b_ver, _)) => compare_semver(&ver, b_ver) == Ordering::Greater,
            None => true,
        };
        if replace {
            best = Some((ver, r.clone()));
        }
    }
    best
}

pub fn installer_asset(platform: &str, arch: &str, version: &str) -> Option<String> {
    if platform == "darwin" && (arch == "arm64" || arch == "x64") {
        Some(format!("Quire-{version}-{arch}.dmg"))
    } else {
        None
    }
}

pub struct UpdateService {
    current_version: String,
    owner: String,
    repo: String,
    platform: String,
    arch: String,
    downloads_dir: PathBuf,
    http: reqwest::Client,
    state: Mutex<UpdateState>,
    checking: tokio::sync::Mutex<()>,
    auto_check: Arc<dyn Fn() -> bool + Send + Sync>,
    on_state: Arc<dyn Fn(UpdateState) + Send + Sync>,
    open_external: Arc<dyn Fn(&str) -> Result<(), String> + Send + Sync>,
    open_path: Arc<dyn Fn(&str) -> Result<(), String> + Send + Sync>,
    stopped: AtomicBool,
    wake: Notify,
}

impl UpdateService {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        current_version: impl Into<String>,
        owner: impl Into<String>,
        repo: impl Into<String>,
        platform: impl Into<String>,
        arch: impl Into<String>,
        downloads_dir: impl Into<PathBuf>,
        auto_check: Arc<dyn Fn() -> bool + Send + Sync>,
        on_state: Arc<dyn Fn(UpdateState) + Send + Sync>,
        open_external: Arc<dyn Fn(&str) -> Result<(), String> + Send + Sync>,
        open_path: Arc<dyn Fn(&str) -> Result<(), String> + Send + Sync>,
    ) -> Self {
        let cur = current_version.into();
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .expect("updates reqwest client");
        Self {
            state: Mutex::new(UpdateState::Idle {
                current: cur.clone(),
                checked_at: None,
            }),
            current_version: cur,
            owner: owner.into(),
            repo: repo.into(),
            platform: platform.into(),
            arch: arch.into(),
            downloads_dir: downloads_dir.into(),
            http,
            checking: tokio::sync::Mutex::new(()),
            auto_check,
            on_state,
            open_external,
            open_path,
            stopped: AtomicBool::new(false),
            wake: Notify::new(),
        }
    }

    pub fn get_state(&self) -> UpdateState {
        self.state.lock().unwrap().clone()
    }

    fn set_state(&self, next: UpdateState) {
        *self.state.lock().unwrap() = next.clone();
        (self.on_state)(next);
    }

    fn releases_url(&self) -> String {
        format!("https://github.com/{}/{}/releases", self.owner, self.repo)
    }

    fn user_agent(&self) -> String {
        format!("Quire/{} ({}; {})", self.current_version, self.platform, self.arch)
    }

    pub async fn check(&self) -> UpdateState {
        let _guard = self.checking.lock().await;
        {
            let cur = self.get_state();
            if matches!(
                cur,
                UpdateState::Downloading { .. } | UpdateState::Ready { .. } | UpdateState::Saved { .. }
            ) {
                return cur;
            }
        }
        self.set_state(UpdateState::Checking {
            current: self.current_version.clone(),
        });
        let next = self.fetch_latest().await;
        self.set_state(next.clone());
        next
    }

    async fn fetch_latest(&self) -> UpdateState {
        let Some(current) = parse_semver(&self.current_version) else {
            return UpdateState::Error {
                current: self.current_version.clone(),
                message: format!(
                    "The running version {:?} is not a version number, so releases cannot be compared with it.",
                    self.current_version
                ),
                checked_at: now_iso(),
            };
        };

        let releases = match self.fetch_releases().await {
            Ok(r) => r,
            Err(message) => {
                return UpdateState::Error {
                    current: self.current_version.clone(),
                    message,
                    checked_at: now_iso(),
                }
            }
        };

        let Some((latest_ver, release)) = pick_latest_release(&releases) else {
            return UpdateState::Error {
                current: self.current_version.clone(),
                message: format!("No releases yet at {}.", self.releases_url()),
                checked_at: now_iso(),
            };
        };

        let checked_at = now_iso();
        if compare_semver(&latest_ver, &current) != Ordering::Greater {
            return UpdateState::UpToDate {
                current: self.current_version.clone(),
                checked_at,
            };
        }

        let version_str = format_semver(&latest_ver);
        let notes = release
            .body
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.chars().take(4000).collect::<String>());
        let download_url = installer_asset(&self.platform, &self.arch, &version_str).map(|asset| {
            let encoded_tag: String = url::form_urlencoded::byte_serialize(release.tag_name.as_bytes()).collect();
            format!("{}/download/{encoded_tag}/{asset}", self.releases_url())
        });

        UpdateState::Available {
            current: self.current_version.clone(),
            latest: version_str,
            notes,
            url: release.html_url,
            can_install: false,
            download_url,
            checked_at,
        }
    }

    async fn fetch_releases(&self) -> Result<Vec<GithubRelease>, String> {
        let feed_url = format!("{}.atom", self.releases_url());
        if let Ok(resp) = self
            .http
            .get(&feed_url)
            .header(reqwest::header::ACCEPT, "application/atom+xml")
            .header(reqwest::header::USER_AGENT, self.user_agent())
            .send()
            .await
        {
            if resp.status().is_success() {
                if let Ok(xml) = resp.text().await {
                    if let Ok(parsed) = parse_release_feed(&xml) {
                        return Ok(parsed);
                    }
                }
            }
        }

        let api_url = format!(
            "https://api.github.com/repos/{}/{}/releases?per_page=10",
            self.owner, self.repo
        );
        let resp = self
            .http
            .get(&api_url)
            .header(reqwest::header::ACCEPT, "application/vnd.github+json")
            .header(reqwest::header::USER_AGENT, self.user_agent())
            .send()
            .await
            .map_err(|e| format!("Could not reach GitHub: {e}"))?;
        if resp.status().as_u16() == 404 {
            return Err(format!("No releases yet at {}.", self.releases_url()));
        }
        if resp.status().as_u16() == 403
            && resp
                .headers()
                .get("x-ratelimit-remaining")
                .and_then(|v| v.to_str().ok())
                == Some("0")
        {
            return Err("GitHub's rate limit is exhausted; try again after a few minutes.".into());
        }
        if !resp.status().is_success() {
            return Err(format!("GitHub answered HTTP {} for {api_url}.", resp.status().as_u16()));
        }
        resp.json::<Vec<GithubRelease>>()
            .await
            .map_err(|e| format!("GitHub's answer was not JSON: {e}"))
    }

    pub async fn install(&self) -> Result<(), String> {
        let st = self.get_state();
        if !matches!(st, UpdateState::Available { .. } | UpdateState::Ready { .. }) {
            return Err(UPDATE_NOT_AVAILABLE.into());
        }
        Err(UPDATE_INSTALL_UNAVAILABLE.into())
    }

    pub async fn download(&self) -> Result<(), String> {
        let st = self.get_state();
        if matches!(st, UpdateState::Downloading { .. }) {
            return Ok(());
        }
        if matches!(st, UpdateState::Saved { .. }) {
            return self.open_downloaded();
        }
        let UpdateState::Available {
            current,
            latest,
            download_url: Some(url),
            ..
        } = st
        else {
            return Err(UPDATE_NOT_AVAILABLE.into());
        };

        let file_name = url
            .rsplit('/')
            .next()
            .filter(|s| !s.is_empty())
            .unwrap_or("Quire.dmg")
            .to_string();
        self.set_state(UpdateState::Downloading {
            current: current.clone(),
            latest: latest.clone(),
            percent: 0,
        });

        let outcome: Result<PathBuf, String> = async {
            fs::create_dir_all(&self.downloads_dir).map_err(|e| e.to_string())?;
            let target_path = self.downloads_dir.join(&file_name);
            let partial_path = self.downloads_dir.join(format!("{file_name}.download"));
            let client = reqwest::Client::builder()
                .timeout(Duration::from_secs(600))
                .build()
                .map_err(|e| e.to_string())?;
            let resp = client
                .get(&url)
                .header(reqwest::header::USER_AGENT, self.user_agent())
                .send()
                .await
                .map_err(|e| e.to_string())?;
            if !resp.status().is_success() {
                return Err(format!("HTTP {}", resp.status().as_u16()));
            }
            let total = resp.content_length().unwrap_or(0);
            let mut file = fs::File::create(&partial_path).map_err(|e| e.to_string())?;
            let mut received = 0u64;
            let mut last_pct = 0u32;
            let mut stream = resp.bytes_stream();
            while let Some(chunk) = stream.next().await {
                let data = chunk.map_err(|e| e.to_string())?;
                file.write_all(&data).map_err(|e| e.to_string())?;
                received += data.len() as u64;
                if total > 0 {
                    let pct = ((received as f64 / total as f64) * 100.0).round().clamp(0.0, 100.0) as u32;
                    if pct != last_pct {
                        last_pct = pct;
                        self.set_state(UpdateState::Downloading {
                            current: current.clone(),
                            latest: latest.clone(),
                            percent: pct,
                        });
                    }
                }
            }
            file.flush().map_err(|e| e.to_string())?;
            drop(file);
            fs::rename(&partial_path, &target_path).map_err(|e| e.to_string())?;
            Ok(target_path)
        }
        .await;

        match outcome {
            Ok(saved_path) => {
                let path_str = saved_path.to_string_lossy().to_string();
                self.set_state(UpdateState::Saved {
                    current,
                    latest,
                    path: path_str,
                });
                self.open_downloaded()
            }
            Err(err) => {
                let msg = format!("Could not download {file_name}: {err}");
                self.set_state(UpdateState::Error {
                    current,
                    message: msg.clone(),
                    checked_at: now_iso(),
                });
                Err(msg)
            }
        }
    }

    pub fn open_downloaded(&self) -> Result<(), String> {
        let UpdateState::Saved { path, .. } = self.get_state() else {
            return Err(UPDATE_NOT_AVAILABLE.into());
        };
        (self.open_path)(&path)
    }

    pub fn open_release_page(&self) -> Result<(), String> {
        let url = match self.get_state() {
            UpdateState::Available { url, .. } => url,
            _ => self.releases_url(),
        };
        (self.open_external)(&url)
    }

    pub fn start(self: &Arc<Self>) {
        let svc = self.clone();
        tauri::async_runtime::spawn(async move {
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(15)) => {}
                _ = svc.wake.notified() => {}
            }
            while !svc.stopped.load(AtomicOrdering::Relaxed) {
                if (svc.auto_check)() {
                    let _ = svc.check().await;
                }
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_secs(24 * 3600)) => {}
                    _ = svc.wake.notified() => {}
                }
            }
        });
    }

    pub fn stop(&self) {
        self.stopped.store(true, AtomicOrdering::Relaxed);
        self.wake.notify_waiters();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_prerelease_semver_and_parses_atom_feed() {
        let a6 = parse_semver("v0.1.0-alpha.6").unwrap();
        let t1 = parse_semver("0.2.0-tauri.1").unwrap();
        assert_eq!(compare_semver(&t1, &a6), Ordering::Greater);

        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
        <feed xmlns="http://www.w3.org/2005/Atom">
          <entry>
            <id>tag:github.com,2008:Repository/1/v0.1.0-alpha.6</id>
            <link rel="alternate" type="text/html" href="https://github.com/Leonezz/quire/releases/tag/v0.1.0-alpha.6"/>
            <title>Quire 0.1.0-alpha.6</title>
            <content type="html">&lt;p&gt;Faster startup&lt;/p&gt;</content>
          </entry>
        </feed>"#;
        let releases = parse_release_feed(xml).unwrap();
        assert_eq!(releases.len(), 1);
        assert_eq!(releases[0].tag_name, "v0.1.0-alpha.6");
        assert_eq!(releases[0].body.as_deref(), Some("Faster startup"));
    }
}
