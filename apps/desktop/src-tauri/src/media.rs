use crate::http::{assert_public_http_url, is_private_host};
use crate::materials::{valid_hex_16, MaterialStore};
use crate::types::MediaCacheProgress;
use futures_util::StreamExt;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tauri::http::{header, Request, Response, StatusCode};
use url::Url;

/// Maximum bytes returned in a single open-ended `quire-media://` Range response (2 MB).
/// Keeping open-ended responses bounded lets WebKit begin playback immediately and issue
/// follow-up `Range` requests on scrub or buffer advance without buffering whole episodes in RAM.
const STREAM_CHUNK_BYTES: u64 = 2 * 1024 * 1024;
/// Maximum bytes read per chunk from a local cached file (4 MB).
const LOCAL_CHUNK_BYTES: u64 = 4 * 1024 * 1024;
/// Hard ceiling for a single offline media cache file (1.5 GB).
const MAX_MEDIA_CACHE_BYTES: u64 = 1536 * 1024 * 1024;

const MEDIA_CSP: &str = "default-src 'none'; media-src 'self'";

const KNOWN_MEDIA_EXTS: &[(&str, &str)] = &[
    ("mp3", "audio/mpeg"),
    ("m4a", "audio/mp4"),
    ("aac", "audio/aac"),
    ("ogg", "audio/ogg"),
    ("opus", "audio/ogg"),
    ("wav", "audio/wav"),
    ("mp4", "video/mp4"),
    ("webm", "video/webm"),
    ("bin", "application/octet-stream"),
];

pub fn build_media_http_client() -> reqwest::Client {
    let policy = reqwest::redirect::Policy::custom(|attempt| {
        if attempt.previous().len() >= 10 {
            return attempt.error("Too many redirects");
        }
        let next = attempt.url();
        if next.scheme() != "https" && next.scheme() != "http" {
            return attempt.error("Redirected to unsupported scheme");
        }
        if !next.username().is_empty() || next.password().is_some() {
            return attempt.error("Redirected to URL with credentials");
        }
        let host = next.host_str().unwrap_or("");
        if host.is_empty() || is_private_host(host) {
            return attempt.error("Redirected to private network address");
        }
        attempt.follow()
    });
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .redirect(policy)
        .build()
        .expect("media reqwest client")
}

pub fn parse_media_url(raw: &str) -> Option<String> {
    let parsed = Url::parse(raw).ok()?;
    let id = if parsed.scheme() == "quire-media" && parsed.host_str() == Some("stream") {
        parsed.path().trim_matches('/')
    } else if (parsed.scheme() == "http" || parsed.scheme() == "https")
        && parsed.host_str() == Some("quire-media.localhost")
    {
        parsed.path().strip_prefix("/stream/")?.trim_matches('/')
    } else {
        return None;
    };
    if valid_hex_16(id) {
        Some(id.to_string())
    } else {
        None
    }
}

pub fn parse_range_header(raw: Option<&str>) -> Option<(u64, Option<u64>)> {
    let header_val = raw?.trim();
    let spec = header_val.strip_prefix("bytes=")?;
    let first_range = spec.split(',').next()?.trim();
    let (start_str, end_str) = first_range.split_once('-')?;
    let start = start_str.trim().parse::<u64>().ok()?;
    let end = if end_str.trim().is_empty() {
        None
    } else {
        Some(end_str.trim().parse::<u64>().ok()?)
    };
    if let Some(e) = end {
        if e < start {
            return None;
        }
    }
    Some((start, end))
}

pub fn ext_and_mime_for(content_type: Option<&str>, stream_url: &str) -> (&'static str, &'static str) {
    let ct = content_type
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    match ct.as_str() {
        "audio/mpeg" | "audio/mp3" => return ("mp3", "audio/mpeg"),
        "audio/mp4" | "audio/x-m4a" | "audio/m4a" => return ("m4a", "audio/mp4"),
        "audio/aac" => return ("aac", "audio/aac"),
        "audio/ogg" | "application/ogg" => return ("ogg", "audio/ogg"),
        "audio/opus" => return ("opus", "audio/ogg"),
        "audio/wav" | "audio/x-wav" => return ("wav", "audio/wav"),
        "video/mp4" => return ("mp4", "video/mp4"),
        "video/webm" => return ("webm", "video/webm"),
        _ => {}
    }
    if let Ok(u) = Url::parse(stream_url) {
        let p = u.path().to_ascii_lowercase();
        for &(ext, mime) in KNOWN_MEDIA_EXTS {
            if ext != "bin" && p.ends_with(&format!(".{ext}")) {
                return (ext, mime);
            }
        }
    }
    ("mp3", "audio/mpeg")
}

pub fn cached_media_info(data_dir: &Path, material_id: &str) -> Option<(PathBuf, &'static str, u64)> {
    if !valid_hex_16(material_id) {
        return None;
    }
    let dir = data_dir.join("media");
    for &(ext, mime) in KNOWN_MEDIA_EXTS {
        let candidate = dir.join(format!("{material_id}.{ext}"));
        if let Ok(meta) = fs::metadata(&candidate) {
            if meta.is_file() && meta.len() > 0 {
                return Some((candidate, mime, meta.len()));
            }
        }
    }
    None
}

pub fn remove_cached_media_files(data_dir: &Path, material_id: &str) -> Result<u64, String> {
    if !valid_hex_16(material_id) {
        return Err("IPC_INVALID_ID".into());
    }
    let dir = data_dir.join("media");
    let mut removed = 0u64;
    for &(ext, _) in KNOWN_MEDIA_EXTS {
        let p = dir.join(format!("{material_id}.{ext}"));
        if let Ok(meta) = fs::metadata(&p) {
            if fs::remove_file(&p).is_ok() {
                removed += meta.len();
            }
        }
    }
    let _ = fs::remove_file(dir.join(format!("{material_id}.part")));
    Ok(removed)
}

#[derive(Clone)]
pub struct MediaCache {
    root: PathBuf,
    client: reqwest::Client,
}

impl MediaCache {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            client: build_media_http_client(),
        }
    }

    pub fn client(&self) -> &reqwest::Client {
        &self.client
    }

    pub fn dir(&self) -> PathBuf {
        self.root.join("media")
    }

    pub fn stored(&self, material_id: &str) -> Option<(PathBuf, &'static str, u64)> {
        cached_media_info(&self.root, material_id)
    }

    pub fn remove(&self, material_id: &str) -> Result<u64, String> {
        remove_cached_media_files(&self.root, material_id)
    }

    pub fn clear_all(&self) -> Result<u64, String> {
        let dir = self.dir();
        let Ok(entries) = fs::read_dir(&dir) else {
            return Ok(0);
        };
        let mut freed = 0u64;
        for entry in entries.flatten() {
            let path = entry.path();
            if let Ok(meta) = entry.metadata() {
                if meta.is_file() && fs::remove_file(&path).is_ok() {
                    freed += meta.len();
                }
            }
        }
        Ok(freed)
    }

    pub async fn download(
        &self,
        material_id: &str,
        stream_url: &str,
        on_progress: impl Fn(MediaCacheProgress),
    ) -> Result<u64, String> {
        if !valid_hex_16(material_id) {
            return Err("IPC_INVALID_ID".into());
        }
        if let Some((_, _, bytes)) = self.stored(material_id) {
            on_progress(MediaCacheProgress {
                material_id: material_id.to_string(),
                downloaded_bytes: bytes,
                total_bytes: Some(bytes),
                phase: "done".into(),
                error: None,
            });
            return Ok(bytes);
        }
        let resolved_stream = if let Some(vid) = crate::youtube::parse_youtube_video_id(stream_url) {
            match crate::youtube::resolve_ytdlp_stream(&vid, None).await {
                Some(direct) => direct,
                None => {
                    let msg = "Install yt-dlp (e.g. brew install yt-dlp) to save YouTube videos for offline playback.".to_string();
                    on_progress(MediaCacheProgress {
                        material_id: material_id.to_string(),
                        downloaded_bytes: 0,
                        total_bytes: None,
                        phase: "error".into(),
                        error: Some(msg.clone()),
                    });
                    return Err(msg);
                }
            }
        } else {
            stream_url.to_string()
        };
        let valid_url = assert_public_http_url(&resolved_stream).map_err(|e| e.message)?;
        fs::create_dir_all(self.dir()).map_err(|e| e.to_string())?;

        let resp = self
            .client
            .get(valid_url)
            .header(reqwest::header::USER_AGENT, "Quire/0.2 (+reading-workbench)")
            .send()
            .await
            .map_err(|e| e.to_string())?;

        if !resp.status().is_success() {
            let msg = format!("The media stream answered HTTP {}.", resp.status().as_u16());
            on_progress(MediaCacheProgress {
                material_id: material_id.to_string(),
                downloaded_bytes: 0,
                total_bytes: None,
                phase: "error".into(),
                error: Some(msg.clone()),
            });
            return Err(msg);
        }

        let total = resp.content_length();
        if let Some(len) = total {
            if len > MAX_MEDIA_CACHE_BYTES {
                return Err("This media file is larger than 1.5 GB.".into());
            }
        }

        let content_type = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .map(String::from);
        let (ext, _) = ext_and_mime_for(content_type.as_deref(), stream_url);

        let part_path = self.dir().join(format!("{material_id}.part"));
        let final_path = self.dir().join(format!("{material_id}.{ext}"));

        let mut file = File::create(&part_path).map_err(|e| e.to_string())?;
        let mut downloaded = 0u64;
        let mut last_emit = Instant::now();
        on_progress(MediaCacheProgress {
            material_id: material_id.to_string(),
            downloaded_bytes: 0,
            total_bytes: total,
            phase: "downloading".into(),
            error: None,
        });

        let mut stream = resp.bytes_stream();
        while let Some(chunk_res) = stream.next().await {
            let chunk = match chunk_res {
                Ok(c) => c,
                Err(err) => {
                    let _ = fs::remove_file(&part_path);
                    let msg = err.to_string();
                    on_progress(MediaCacheProgress {
                        material_id: material_id.to_string(),
                        downloaded_bytes: downloaded,
                        total_bytes: total,
                        phase: "error".into(),
                        error: Some(msg.clone()),
                    });
                    return Err(msg);
                }
            };
            downloaded += chunk.len() as u64;
            if downloaded > MAX_MEDIA_CACHE_BYTES {
                let _ = fs::remove_file(&part_path);
                return Err("This media file exceeded the 1.5 GB offline cache limit.".into());
            }
            if let Err(err) = file.write_all(&chunk) {
                let _ = fs::remove_file(&part_path);
                return Err(err.to_string());
            }
            if last_emit.elapsed() >= Duration::from_millis(150) {
                last_emit = Instant::now();
                on_progress(MediaCacheProgress {
                    material_id: material_id.to_string(),
                    downloaded_bytes: downloaded,
                    total_bytes: total,
                    phase: "downloading".into(),
                    error: None,
                });
            }
        }
        let _ = file.flush();
        drop(file);

        for &(old_ext, _) in KNOWN_MEDIA_EXTS {
            let old_path = self.dir().join(format!("{material_id}.{old_ext}"));
            if old_path != final_path {
                let _ = fs::remove_file(old_path);
            }
        }
        fs::rename(&part_path, &final_path).map_err(|e| e.to_string())?;
        on_progress(MediaCacheProgress {
            material_id: material_id.to_string(),
            downloaded_bytes: downloaded,
            total_bytes: Some(downloaded),
            phase: "done".into(),
            error: None,
        });
        Ok(downloaded)
    }
}

fn plain_response(status: StatusCode, msg: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .header("x-content-type-options", "nosniff")
        .header(header::CONTENT_SECURITY_POLICY, MEDIA_CSP)
        .body(msg.as_bytes().to_vec())
        .unwrap()
}

fn serve_local_file(
    path: &Path,
    mime: &str,
    total_len: u64,
    range: Option<(u64, Option<u64>)>,
) -> Response<Vec<u8>> {
    if total_len == 0 {
        return plain_response(StatusCode::NOT_FOUND, "Empty media file");
    }
    let mut file = match File::open(path) {
        Ok(f) => f,
        Err(_) => return plain_response(StatusCode::NOT_FOUND, "Media file not found"),
    };

    if let Some((start, end_opt)) = range {
        if start >= total_len {
            return Response::builder()
                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                .header(header::CONTENT_RANGE, format!("bytes */{total_len}"))
                .header("x-content-type-options", "nosniff")
                .body(Vec::new())
                .unwrap();
        }
        let end = end_opt
            .unwrap_or_else(|| start.saturating_add(LOCAL_CHUNK_BYTES - 1))
            .min(total_len - 1);
        let len = (end - start + 1) as usize;
        if file.seek(SeekFrom::Start(start)).is_err() {
            return plain_response(StatusCode::INTERNAL_SERVER_ERROR, "Seek failed");
        }
        let mut buf = vec![0u8; len];
        if file.read_exact(&mut buf).is_err() {
            return plain_response(StatusCode::INTERNAL_SERVER_ERROR, "Read failed");
        }
        return Response::builder()
            .status(StatusCode::PARTIAL_CONTENT)
            .header(header::CONTENT_TYPE, mime)
            .header(header::ACCEPT_RANGES, "bytes")
            .header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{total_len}"))
            .header(header::CONTENT_LENGTH, len.to_string())
            .header(header::CACHE_CONTROL, "no-store")
            .header("x-content-type-options", "nosniff")
            .header(header::CONTENT_SECURITY_POLICY, MEDIA_CSP)
            .body(buf)
            .unwrap();
    }

    // Even when no Range header is sent, if the file is larger than LOCAL_CHUNK_BYTES, read up to LOCAL_CHUNK_BYTES if Range wasn't requested?
    // Standard HTTP requires 200 OK to match Content-Length; if the file is reasonable or probed, WebKit always sends `Range: bytes=0-1` first.
    let read_len = total_len.min(32 * 1024 * 1024) as usize;
    let mut buf = vec![0u8; read_len];
    if file.read_exact(&mut buf).is_err() {
        return plain_response(StatusCode::INTERNAL_SERVER_ERROR, "Read failed");
    }
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_LENGTH, read_len.to_string())
        .header(header::CACHE_CONTROL, "no-store")
        .header("x-content-type-options", "nosniff")
        .header(header::CONTENT_SECURITY_POLICY, MEDIA_CSP)
        .body(buf)
        .unwrap()
}

pub async fn media_protocol_response<T>(
    request: &Request<T>,
    store: &MaterialStore,
    cache: &MediaCache,
) -> Response<Vec<u8>> {
    let url_str = request.uri().to_string();
    let Some(material_id) = parse_media_url(&url_str) else {
        return plain_response(StatusCode::NOT_FOUND, "Invalid media URL");
    };

    let range_raw = request
        .headers()
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok());
    let range = parse_range_header(range_raw);

    // 1. Serve from local offline cache when available (zero network, instant seek)
    if let Some((path, mime, total_len)) = cache.stored(&material_id) {
        return serve_local_file(&path, mime, total_len, range);
    }

    // 2. Otherwise proxy with bounded HTTP Range via cookie-less SSRF-guarded client
    let Ok(Some(record)) = store.read_stored(&material_id) else {
        return plain_response(StatusCode::NOT_FOUND, "Material not found");
    };
    let Some(media) = record.media else {
        return plain_response(StatusCode::NOT_FOUND, "Material has no media stream");
    };
    let effective_stream_url = if media.provider == "youtube" {
        let vid = media
            .video_id
            .clone()
            .or_else(|| crate::youtube::parse_youtube_video_id(&media.stream_url));
        match vid {
            Some(v) => match crate::youtube::resolve_ytdlp_stream(&v, None).await {
                Some(u) => u,
                None => {
                    return plain_response(
                        StatusCode::NOT_FOUND,
                        "Direct YouTube stream requires local yt-dlp; use quire-player://youtube/<videoId>.",
                    );
                }
            },
            None => media.stream_url.clone(),
        }
    } else {
        media.stream_url.clone()
    };
    let Ok(upstream_url) = assert_public_http_url(&effective_stream_url) else {
        return plain_response(StatusCode::FORBIDDEN, "Refusing private or invalid media stream");
    };

    let (req_start, req_end) = match range {
        Some((s, Some(e))) => (s, s.saturating_add(STREAM_CHUNK_BYTES - 1).min(e)),
        Some((s, None)) => (s, s.saturating_add(STREAM_CHUNK_BYTES - 1)),
        None => (0, STREAM_CHUNK_BYTES - 1),
    };

    let upstream_resp = match cache
        .client()
        .get(upstream_url)
        .header(reqwest::header::USER_AGENT, "Quire/0.2 (+reading-workbench)")
        .header(reqwest::header::RANGE, format!("bytes={req_start}-{req_end}"))
        .send()
        .await
    {
        Ok(r) => r,
        Err(err) => {
            return plain_response(StatusCode::BAD_GATEWAY, &format!("Media stream error: {err}"));
        }
    };

    let status = upstream_resp.status();
    if status == reqwest::StatusCode::RANGE_NOT_SATISFIABLE {
        let cr = upstream_resp
            .headers()
            .get(reqwest::header::CONTENT_RANGE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("bytes */*")
            .to_string();
        return Response::builder()
            .status(StatusCode::RANGE_NOT_SATISFIABLE)
            .header(header::CONTENT_RANGE, cr)
            .header("x-content-type-options", "nosniff")
            .body(Vec::new())
            .unwrap();
    }
    if !status.is_success() {
        return plain_response(
            StatusCode::BAD_GATEWAY,
            &format!("Media stream answered HTTP {}", status.as_u16()),
        );
    }

    let (_, fallback_mime) = ext_and_mime_for(None, &media.stream_url);
    let content_type = upstream_resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .filter(|ct| !ct.starts_with("application/octet-stream"))
        .unwrap_or(fallback_mime)
        .to_string();
    let content_range = upstream_resp
        .headers()
        .get(reqwest::header::CONTENT_RANGE)
        .and_then(|v| v.to_str().ok())
        .map(String::from);

    let max_read = (STREAM_CHUNK_BYTES as usize) + 64 * 1024;
    let mut body = Vec::new();
    let mut stream = upstream_resp.bytes_stream();
    while let Some(chunk_res) = stream.next().await {
        match chunk_res {
            Ok(chunk) => {
                if body.len() + chunk.len() > max_read {
                    let take = max_read.saturating_sub(body.len());
                    body.extend_from_slice(&chunk[..take]);
                    break;
                }
                body.extend_from_slice(&chunk);
            }
            Err(err) => {
                return plain_response(StatusCode::BAD_GATEWAY, &format!("Stream interrupted: {err}"));
            }
        }
    }

    let mut builder = Response::builder()
        .status(if content_range.is_some() {
            StatusCode::PARTIAL_CONTENT
        } else {
            StatusCode::OK
        })
        .header(header::CONTENT_TYPE, content_type)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_LENGTH, body.len().to_string())
        .header(header::CACHE_CONTROL, "no-store")
        .header("x-content-type-options", "nosniff")
        .header(header::CONTENT_SECURITY_POLICY, MEDIA_CSP);

    if let Some(cr) = content_range {
        builder = builder.header(header::CONTENT_RANGE, cr);
    }
    builder.body(body).unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_media_urls_and_http_ranges() {
        assert_eq!(
            parse_media_url("quire-media://stream/0123456789abcdef").as_deref(),
            Some("0123456789abcdef")
        );
        assert_eq!(
            parse_media_url("http://quire-media.localhost/stream/fedcba9876543210").as_deref(),
            Some("fedcba9876543210")
        );
        assert_eq!(parse_media_url("quire-media://stream/not-valid"), None);

        assert_eq!(parse_range_header(Some("bytes=0-1")), Some((0, Some(1))));
        assert_eq!(parse_range_header(Some("bytes=4096-")), Some((4096, None)));
        assert_eq!(parse_range_header(Some("bytes=500-100")), None);
    }

    #[test]
    fn serves_partial_content_from_cached_file() {
        let tmp = tempfile::tempdir().unwrap();
        let media_dir = tmp.path().join("media");
        fs::create_dir_all(&media_dir).unwrap();
        let id = "0123456789abcdef";
        let payload: Vec<u8> = (0..=255u8).collect();
        fs::write(media_dir.join(format!("{id}.mp3")), &payload).unwrap();

        let (path, mime, total) = cached_media_info(tmp.path(), id).unwrap();
        assert_eq!(mime, "audio/mpeg");
        assert_eq!(total, 256);

        let resp = serve_local_file(&path, mime, total, Some((10, Some(19))));
        assert_eq!(resp.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(
            resp.headers().get(header::CONTENT_RANGE).unwrap().to_str().unwrap(),
            "bytes 10-19/256"
        );
        assert_eq!(resp.body(), &(10..=19u8).collect::<Vec<u8>>());
    }
}
