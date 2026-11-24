use crate::http::{assert_public_http_url, is_private_host};
use crate::materials::{parse_figure_url, FigureRef, FigureStore};
use crate::sqlite_stores::{now_iso, sha256_hex};
use crate::types::IMAGE_SCHEME;
use base64::Engine;
use futures_util::StreamExt;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;
use url::Url;

const MAX_IMAGE_BYTES: usize = 8 * 1024 * 1024;
const MAX_GIF_BYTES: usize = 32 * 1024 * 1024;
const MAX_INLINE_IMAGE_URL_CHARS: usize = 3 * 1024 * 1024; // ~2 MiB base64

#[derive(Debug, Clone)]
pub struct StoredImage {
    pub media_type: String,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ImageTarget {
    Cache { key: String },
    Figure { figure: FigureRef },
}

pub fn valid_image_key(key: &str) -> bool {
    key.len() == 64 && key.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

pub fn is_supported_image_type(media_type: &str) -> bool {
    matches!(
        media_type,
        "image/avif" | "image/gif" | "image/jpeg" | "image/png" | "image/webp" | "image/svg+xml"
    )
}

pub fn image_url(key: &str) -> Result<String, String> {
    if !valid_image_key(key) {
        return Err(format!("\"{key}\" is not an image cache key"));
    }
    Ok(format!("{IMAGE_SCHEME}://cache/{key}"))
}

pub fn figure_image_url(r: &FigureRef) -> String {
    format!("{IMAGE_SCHEME}://figure/{}/{}.png", r.material_id, r.index)
}

pub fn parse_image_url(raw: &str) -> Option<ImageTarget> {
    let normalized = raw
        .strip_prefix("quire-image://")
        .or_else(|| raw.strip_prefix("http://quire-image.localhost/"))
        .or_else(|| raw.strip_prefix("https://quire-image.localhost/"))?;
    let path = normalized.split('?').next().unwrap_or(normalized);
    if let Some(key) = path.strip_prefix("cache/") {
        if valid_image_key(key) {
            return Some(ImageTarget::Cache { key: key.to_string() });
        }
        return None;
    }
    if let Some(rest) = path.strip_prefix("figure/") {
        return parse_figure_url(&format!("quire-figure://{rest}"))
            .map(|figure| ImageTarget::Figure { figure });
    }
    None
}

pub fn sniff_image_type(bytes: &[u8]) -> Option<&'static str> {
    if bytes.len() >= 4 && bytes[0..4] == [0x89, 0x50, 0x4e, 0x47] {
        return Some("image/png");
    }
    if bytes.len() >= 3 && bytes[0..3] == [0xff, 0xd8, 0xff] {
        return Some("image/jpeg");
    }
    if bytes.len() >= 4 && bytes[0..4] == [0x47, 0x49, 0x46, 0x38] {
        return Some("image/gif");
    }
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    if bytes.len() >= 8 && &bytes[4..8] == b"ftyp" {
        return Some("image/avif");
    }
    let prefix = String::from_utf8_lossy(&bytes[..bytes.len().min(512)])
        .trim_start()
        .to_lowercase();
    if prefix.starts_with("<svg") || (prefix.starts_with("<?xml") && prefix.contains("<svg")) {
        return Some("image/svg+xml");
    }
    None
}

fn max_image_bytes(media_type: &str) -> usize {
    if media_type == "image/gif" {
        MAX_GIF_BYTES
    } else {
        MAX_IMAGE_BYTES
    }
}

fn decode_inline_image(raw: &str) -> Result<(String, Vec<u8>), String> {
    if raw.len() > MAX_INLINE_IMAGE_URL_CHARS {
        return Err("embedded image exceeds 2 MiB".into());
    }
    let re = Regex::new(r"(?i)^data:(image/(?:png|jpeg|gif|webp|avif));base64,([A-Za-z0-9+/=\s]+)$").unwrap();
    let Some(caps) = re.captures(raw) else {
        return Err("not an embedded raster image (png, jpeg, gif, webp or avif, base64, at most 2 MiB)".into());
    };
    let media_type = caps.get(1).unwrap().as_str().to_lowercase();
    let cleaned: String = caps.get(2).unwrap().as_str().chars().filter(|c| !c.is_whitespace()).collect();
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(cleaned)
        .map_err(|_| "invalid base64 image data".to_string())?;
    if bytes.len() > 2 * 1024 * 1024 {
        return Err("embedded image exceeds 2 MiB".into());
    }
    if sniff_image_type(&bytes) != Some(media_type.as_str()) {
        return Err(format!("the embedded bytes are not {media_type}"));
    }
    Ok((media_type, bytes))
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImageMetaFile {
    media_type: String,
    url: String,
    fetched_at: String,
}

#[derive(Clone)]
pub struct ImageCache {
    root: PathBuf,
    figures: FigureStore,
    client: reqwest::Client,
    write_lock: Arc<Mutex<()>>,
}

impl ImageCache {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        let root_path = root.into();
        let figures = FigureStore::new(&root_path);
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .redirect(reqwest::redirect::Policy::limited(10))
            .build()
            .expect("image reqwest client");
        Self {
            root: root_path,
            figures,
            client,
            write_lock: Arc::new(Mutex::new(())),
        }
    }

    fn dir(&self) -> PathBuf {
        self.root.join("images")
    }

    fn key_of(&self, url: &str) -> String {
        sha256_hex(url.as_bytes())
    }

    fn has(&self, key: &str) -> bool {
        let dir = self.dir();
        dir.join(format!("{key}.json")).is_file() && dir.join(format!("{key}.bin")).is_file()
    }

    pub async fn resolve(&self, raw_url: &str) -> Option<String> {
        if let Some(fig) = parse_figure_url(raw_url) {
            return if self.figures.has(&fig) {
                Some(figure_image_url(&fig))
            } else {
                None
            };
        }
        let key = self.key_of(raw_url);
        if self.has(&key) {
            return image_url(&key).ok();
        }
        if raw_url.len() >= 5 && raw_url[..5].eq_ignore_ascii_case("data:") {
            let (media_type, bytes) = decode_inline_image(raw_url).ok()?;
            self.write(raw_url, &media_type, &bytes).await.ok()?;
            return image_url(&key).ok();
        }
        let url = assert_public_http_url(raw_url).ok()?;
        let (media_type, bytes) = self.download(&url).await.ok()?;
        self.write(raw_url, &media_type, &bytes).await.ok()?;
        image_url(&key).ok()
    }

    pub fn stored(&self, key: &str) -> Result<Option<StoredImage>, String> {
        if !valid_image_key(key) {
            return Err(format!("\"{key}\" is not an image cache key"));
        }
        let dir = self.dir();
        let meta_raw = match fs::read_to_string(dir.join(format!("{key}.json"))) {
            Ok(s) => s,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e.to_string()),
        };
        let bytes = match fs::read(dir.join(format!("{key}.bin"))) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e.to_string()),
        };
        let meta: ImageMetaFile = serde_json::from_str(&meta_raw).map_err(|e| e.to_string())?;
        if !is_supported_image_type(&meta.media_type) {
            return Err(format!(
                "The cached image {key} records the media type {:?}, which is not an image type.",
                meta.media_type
            ));
        }
        Ok(Some(StoredImage {
            media_type: meta.media_type,
            bytes,
        }))
    }

    pub fn figure(&self, r: &FigureRef) -> Result<Option<Vec<u8>>, String> {
        self.figures.bytes(r)
    }

    async fn write(&self, raw_url: &str, media_type: &str, bytes: &[u8]) -> Result<(), String> {
        let _guard = self.write_lock.lock().await;
        let dir = self.dir();
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let key = self.key_of(raw_url);
        fs::write(dir.join(format!("{key}.bin")), bytes).map_err(|e| e.to_string())?;
        let recorded_url = if raw_url.len() >= 5 && raw_url[..5].eq_ignore_ascii_case("data:") {
            format!("data:{media_type};base64 ({} bytes embedded in the page)", bytes.len())
        } else {
            raw_url.to_string()
        };
        let meta = ImageMetaFile {
            media_type: media_type.to_string(),
            url: recorded_url,
            fetched_at: now_iso(),
        };
        fs::write(
            dir.join(format!("{key}.json")),
            serde_json::to_string(&meta).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())
    }

    pub async fn forget(&self, urls: &[String]) -> Result<usize, String> {
        let keys: Vec<String> = urls
            .iter()
            .filter(|u| {
                u.starts_with("http://")
                    || u.starts_with("https://")
                    || (u.len() >= 5 && u[..5].eq_ignore_ascii_case("data:"))
            })
            .collect::<HashSet<_>>()
            .into_iter()
            .map(|u| self.key_of(u))
            .collect();

        let _guard = self.write_lock.lock().await;
        let dir = self.dir();
        let mut removed = 0;
        for key in keys {
            if fs::remove_file(dir.join(format!("{key}.bin"))).is_ok() {
                removed += 1;
            }
            let _ = fs::remove_file(dir.join(format!("{key}.json")));
        }
        Ok(removed)
    }

    pub async fn prefetch(&self, urls: Vec<String>, concurrency: usize) -> (usize, usize) {
        if urls.is_empty() {
            return (0, 0);
        }
        let queue = Arc::new(std::sync::Mutex::new(urls.into_iter()));
        let workers = concurrency.max(1).min(8);
        let mut handles = Vec::with_capacity(workers);
        for _ in 0..workers {
            let cache = self.clone();
            let q = queue.clone();
            handles.push(tokio::spawn(async move {
                let mut cached = 0usize;
                let mut skipped = 0usize;
                loop {
                    let next = q.lock().ok().and_then(|mut it| it.next());
                    let Some(url) = next else { break };
                    if cache.resolve(&url).await.is_some() {
                        cached += 1;
                    } else {
                        skipped += 1;
                    }
                }
                (cached, skipped)
            }));
        }
        let mut total_cached = 0;
        let mut total_skipped = 0;
        for h in handles {
            if let Ok((c, s)) = h.await {
                total_cached += c;
                total_skipped += s;
            }
        }
        (total_cached, total_skipped)
    }

    async fn download(&self, url: &Url) -> Result<(String, Vec<u8>), String> {
        let referer = format!("{}/", url.origin().ascii_serialization());
        let response = self
            .client
            .get(url.clone())
            .header(
                reqwest::header::ACCEPT,
                "image/avif,image/webp,image/png,image/jpeg,image/gif,image/svg+xml,*/*;q=0.5",
            )
            .header(
                reqwest::header::USER_AGENT,
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
            )
            .header(reqwest::header::REFERER, referer)
            .send()
            .await
            .map_err(|e| e.to_string())?;

        if !response.status().is_success() {
            return Err(format!("HTTP {}", response.status().as_u16()));
        }
        if let Some(host) = response.url().host_str() {
            if is_private_host(host) {
                return Err("redirected to private host".into());
            }
        }
        let declared_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .split(';')
            .next()
            .unwrap_or("")
            .trim()
            .to_lowercase();
        let declared_cap = if is_supported_image_type(&declared_type) {
            max_image_bytes(&declared_type)
        } else {
            MAX_GIF_BYTES
        };
        if let Some(len) = response.content_length() {
            if len as usize > declared_cap {
                return Err(format!("larger than {declared_cap} bytes"));
            }
        }

        let mut stream = response.bytes_stream();
        let mut bytes = Vec::new();
        while let Some(chunk) = stream.next().await {
            let data = chunk.map_err(|e| e.to_string())?;
            if bytes.len() + data.len() > MAX_GIF_BYTES {
                return Err(format!("larger than {MAX_GIF_BYTES} bytes"));
            }
            bytes.extend_from_slice(&data);
        }
        if bytes.is_empty() {
            return Err("empty body".into());
        }
        let media_type = if is_supported_image_type(&declared_type) {
            declared_type
        } else {
            sniff_image_type(&bytes)
                .ok_or_else(|| "not an image".to_string())?
                .to_string()
        };
        let cap = max_image_bytes(&media_type);
        if bytes.len() > cap {
            return Err(format!("larger than {cap} bytes"));
        }
        Ok((media_type, bytes))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sniffs_formats_and_parses_quire_image_urls() {
        assert_eq!(sniff_image_type(&[0x89, 0x50, 0x4e, 0x47, 0x0d]), Some("image/png"));
        assert_eq!(sniff_image_type(&[0xff, 0xd8, 0xff, 0xe0]), Some("image/jpeg"));
        assert_eq!(sniff_image_type(b"<svg viewBox=\"0 0 10 10\"></svg>"), Some("image/svg+xml"));

        let key = "a".repeat(64);
        assert_eq!(
            parse_image_url(&format!("quire-image://cache/{key}")),
            Some(ImageTarget::Cache { key })
        );
        assert_eq!(
            parse_image_url("quire-image://figure/0123456789abcdef/3.png"),
            Some(ImageTarget::Figure {
                figure: FigureRef {
                    material_id: "0123456789abcdef".into(),
                    index: 3,
                }
            })
        );
    }

    #[tokio::test]
    async fn caches_inline_base64_png_and_forgets() {
        let tmp = tempfile::tempdir().unwrap();
        let cache = ImageCache::new(tmp.path());
        // 1x1 transparent PNG
        let data_url = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
        let resolved = cache.resolve(data_url).await.unwrap();
        assert!(resolved.starts_with("quire-image://cache/"));
        let target = parse_image_url(&resolved).unwrap();
        if let ImageTarget::Cache { key } = target {
            let stored = cache.stored(&key).unwrap().unwrap();
            assert_eq!(stored.media_type, "image/png");
        }
        assert_eq!(cache.forget(&[data_url.to_string()]).await.unwrap(), 1);
    }
}
