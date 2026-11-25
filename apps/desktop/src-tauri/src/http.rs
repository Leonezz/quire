use crate::sqlite_stores::sha256_hex;
use crate::types::{Creator, MaterialMeta, SourceDetection};
use futures_util::StreamExt;
use regex::Regex;
use std::collections::HashMap;
use std::net::IpAddr;
use std::time::Duration;
use url::Url;

pub const MAX_BYTES: usize = 32 * 1024 * 1024;
pub const PAGE_ACCEPT: &str = "text/html,application/xhtml+xml,application/pdf,text/markdown,text/plain;q=0.9,*/*;q=0.5";
pub const FEED_ACCEPT: &str = "application/rss+xml,application/atom+xml,application/xml;q=0.9,text/xml;q=0.9,text/html;q=0.7,*/*;q=0.5";

#[derive(Debug, Clone)]
pub struct FetchError {
    pub code: String,
    pub message: String,
}

impl FetchError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct FetchedPage {
    pub bytes: Vec<u8>,
    pub media_type: String,
    pub final_url: String,
}

pub fn is_private_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let [a, b, _, _] = v4.octets();
            a == 10
                || a == 127
                || a == 0
                || (a == 169 && b == 254)
                || (a == 172 && (16..=31).contains(&b))
                || (a == 192 && b == 168)
                || (a == 100 && (64..=127).contains(&b))
        }
        IpAddr::V6(v6) => {
            if v6.is_loopback() || v6.is_unspecified() {
                return true;
            }
            if let Some(mapped) = v6.to_ipv4_mapped() {
                return is_private_ip(IpAddr::V4(mapped));
            }
            let seg0 = v6.segments()[0];
            (seg0 & 0xffc0) == 0xfe80 || (seg0 & 0xfe00) == 0xfc00
        }
    }
}

pub fn is_private_host(hostname: &str) -> bool {
    let host = hostname.trim_start_matches('[').trim_end_matches(']').to_lowercase();
    if host == "localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.ends_with(".internal")
    {
        return true;
    }
    if let Ok(ip) = host.parse::<IpAddr>() {
        return is_private_ip(ip);
    }
    false
}

pub fn assert_public_http_url(raw: &str) -> Result<Url, FetchError> {
    let url = Url::parse(raw.trim()).map_err(|_| FetchError::new("URL_INVALID", "That is not a valid URL."))?;
    if url.scheme() != "https" && url.scheme() != "http" {
        return Err(FetchError::new("URL_SCHEME", "Only http and https pages can be added."));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(FetchError::new("URL_CREDENTIALS", "URLs with credentials are not accepted."));
    }
    let host = url.host_str().unwrap_or("");
    if host.is_empty() || is_private_host(host) {
        return Err(FetchError::new("URL_PRIVATE", "Local and private network addresses are not fetched."));
    }
    Ok(url)
}

pub fn build_http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .expect("reqwest client")
}

pub async fn fetch_page(client: &reqwest::Client, url: &Url, accept: &str) -> Result<FetchedPage, FetchError> {
    let response = client
        .get(url.clone())
        .header(reqwest::header::ACCEPT, accept)
        .header(reqwest::header::USER_AGENT, "Read/0.2 (+reading-workbench; tauri)")
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
    if let Some(host) = final_url.host_str() {
        if is_private_host(host) {
            return Err(FetchError::new("URL_PRIVATE", "The page redirected to a private address."));
        }
    }
    if let Some(len) = response.content_length() {
        if len as usize > MAX_BYTES {
            return Err(FetchError::new("PAGE_TOO_LARGE", "The page is larger than 32 MB."));
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
        if bytes.len() + data.len() > MAX_BYTES {
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

// ---------------------------------------------------------------------------
// Material URL identity & arXiv helpers (matching material-identity.ts & arxiv.ts)
// ---------------------------------------------------------------------------

const TRACKING_PARAMS: &[&str] = &[
    "ref", "ref_src", "fbclid", "gclid", "dclid", "msclkid", "mc_cid", "mc_eid", "igshid",
    "_hsenc", "_hsmi", "mkt_tok", "yclid", "spm", "share",
];

fn on_site(hostname: &str, sites: &[&str]) -> bool {
    sites.iter().any(|s| hostname == *s || hostname.ends_with(&format!(".{s}")))
}

fn is_tracking_param(name: &str, hostname: &str) -> bool {
    if name == "ref" {
        return !on_site(hostname, &["github.com", "gitlab.com"]);
    }
    if TRACKING_PARAMS.contains(&name) || name.starts_with("utm_") {
        return true;
    }
    if name == "s" {
        return on_site(hostname, &["x.com", "twitter.com"]);
    }
    if name == "si" {
        return on_site(hostname, &["youtube.com", "youtu.be", "spotify.com"]);
    }
    false
}

pub fn canonical_url_of(url: &Url) -> String {
    let mut page = url.clone();
    page.set_fragment(None);
    let host = page.host_str().unwrap_or("").to_string();
    if let Some(q) = page.query() {
        let pairs: Vec<&str> = q.split('&').collect();
        let kept: Vec<&str> = pairs
            .iter()
            .copied()
            .filter(|pair| {
                let name = pair.split('=').next().unwrap_or("");
                !is_tracking_param(name, &host)
            })
            .collect();
        if kept.len() < pairs.len() {
            if kept.is_empty() {
                page.set_query(None);
            } else {
                page.set_query(Some(&kept.join("&")));
            }
        }
    }
    page.to_string()
}

pub fn id_for(locator: &str) -> String {
    sha256_hex(locator.as_bytes())[..16].to_string()
}

pub fn material_id_of(url: &Url) -> String {
    id_for(&canonical_url_of(url))
}

pub fn stored_ids_of(url: &Url) -> Vec<String> {
    let mut page = url.clone();
    page.set_fragment(None);
    let first = material_id_of(url);
    let second = id_for(page.as_str());
    if first == second {
        vec![first]
    } else {
        vec![first, second]
    }
}

pub fn canonical_link_of(href: Option<&str>, page_url: &str) -> Option<String> {
    let href = href?;
    let page = Url::parse(page_url).ok()?;
    let canonical = page.join(href).ok()?;
    if canonical.scheme() != "https" && canonical.scheme() != "http" {
        return None;
    }
    let page_host = page.host_str()?.trim_start_matches("www.");
    let can_host = canonical.host_str()?.trim_start_matches("www.");
    let same_site = can_host == page_host
        || can_host.ends_with(&format!(".{page_host}"))
        || page_host.ends_with(&format!(".{can_host}"));
    if canonical.path() == "/" || !same_site {
        return None;
    }
    let named = canonical_url_of(&canonical);
    if named == canonical_url_of(&page) {
        None
    } else {
        Some(named)
    }
}

const ARXIV_ARCHIVES: &[&str] = &[
    "cs", "math", "stat", "physics", "q-bio", "q-fin", "econ", "eess", "astro-ph", "cond-mat",
    "gr-qc", "hep-ex", "hep-lat", "hep-ph", "hep-th", "math-ph", "nlin", "nucl-ex", "nucl-th",
    "quant-ph",
];

pub fn is_arxiv_category(value: &str) -> bool {
    let re = Regex::new(r"^([a-z-]+)(\.[A-Z]{2})?$").unwrap();
    if let Some(caps) = re.captures(value) {
        let archive = caps.get(1).map(|m| m.as_str()).unwrap_or("");
        return ARXIV_ARCHIVES.contains(&archive);
    }
    false
}

pub fn arxiv_category_from_input(input: &str) -> Option<String> {
    let value = input.trim();
    let bare_re = Regex::new(r"(?i)^(?:arxiv:)?([A-Za-z.-]+)$").unwrap();
    if let Some(caps) = bare_re.captures(value) {
        let cat = caps.get(1)?.as_str();
        if is_arxiv_category(cat) {
            return Some(cat.to_string());
        }
    }
    let list_re = Regex::new(r"(?i)^https?://(?:www\.)?arxiv\.org/list/([A-Za-z.-]+)(?:/(?:recent|new|current|pastweek|\d{4}|\d{2}))?/?(?:[?#].*)?$").unwrap();
    if let Some(caps) = list_re.captures(value) {
        let cat = caps.get(1)?.as_str();
        if is_arxiv_category(cat) {
            return Some(cat.to_string());
        }
    }
    None
}

pub fn arxiv_query_url(category: &str) -> String {
    format!(
        "https://export.arxiv.org/api/query?search_query=cat:{}&sortBy=submittedDate&sortOrder=descending&max_results=50",
        url::form_urlencoded::byte_serialize(category.as_bytes()).collect::<String>()
    )
}

pub fn arxiv_id_of(link: &str) -> Option<String> {
    let re = Regex::new(r"(?i)arxiv\.org/(?:abs|pdf|html)/([a-z-]+/\d{7}|\d{4}\.\d{4,5})(?:v(\d+))?").unwrap();
    re.captures(link).and_then(|c| c.get(1).map(|m| m.as_str().to_string()))
}

pub fn arxiv_version_of(link: &str) -> Option<u32> {
    let re = Regex::new(r"(?i)arxiv\.org/(?:abs|pdf|html)/([a-z-]+/\d{7}|\d{4}\.\d{4,5})v(\d+)").unwrap();
    re.captures(link)
        .and_then(|c| c.get(2))
        .and_then(|m| m.as_str().parse::<u32>().ok())
}

pub fn arxiv_id_of_url(url: &Url) -> Option<String> {
    let host = url.host_str()?;
    if on_site(host, &["arxiv.org"]) {
        arxiv_id_of(url.as_str())
    } else {
        None
    }
}

pub fn arxiv_rendering_version(id: &str, urls: &[&str], text: &str) -> Option<u32> {
    for u in urls {
        if arxiv_id_of(u).as_deref() == Some(id) {
            if let Some(v) = arxiv_version_of(u) {
                return Some(v);
            }
        }
    }
    let escaped = regex::escape(id);
    let stamp = Regex::new(&format!(r"{escaped}v(\d+)")).ok()?;
    stamp
        .captures_iter(text)
        .filter_map(|cap| {
            let full_start = cap.get(0)?.start();
            if full_start > 0 {
                let prev = text.as_bytes()[full_start - 1];
                if prev.is_ascii_alphanumeric() || prev == b'_' || prev == b'.' {
                    return None;
                }
            }
            cap.get(1)?.as_str().parse::<u32>().ok()
        })
        .max()
}

pub fn arxiv_entry_meta_of(bytes: &[u8]) -> HashMap<String, MaterialMeta> {
    let xml = String::from_utf8_lossy(bytes);
    let entry_re = Regex::new(r"(?s)<entry(?:\s[^>]*)?>(.*?)</entry>").unwrap();
    let id_re = Regex::new(r"<id>\s*([^<]+?)\s*</id>").unwrap();
    let author_re = Regex::new(r"(?s)<author(?:\s[^>]*)?>.*?<name>([^<]+)</name>.*?</author>").unwrap();
    let summary_re = Regex::new(r"(?s)<summary(?:\s[^>]*)?>(.*?)</summary>").unwrap();
    let pub_re = Regex::new(r"<published>\s*([^<]+?)\s*</published>").unwrap();
    let cat_re = Regex::new(r#"<arxiv:primary_category\b[^>]*\bterm="([^"]+)""#).unwrap();

    let collapse = |s: &str| {
        s.replace("&amp;", "&")
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&quot;", "\"")
            .replace("&apos;", "'")
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
    };

    let mut out = HashMap::new();
    for cap in entry_re.captures_iter(&xml) {
        let entry = cap.get(1).map(|m| m.as_str()).unwrap_or("");
        let Some(id_raw) = id_re.captures(entry).and_then(|c| c.get(1)).map(|m| m.as_str()) else {
            continue;
        };
        let Some(id) = arxiv_id_of(id_raw) else {
            continue;
        };
        let creators: Vec<Creator> = author_re
            .captures_iter(entry)
            .filter_map(|c| {
                let name = collapse(c.get(1)?.as_str());
                if name.is_empty() {
                    None
                } else {
                    Some(Creator {
                        role: "author".into(),
                        name,
                        given: None,
                        family: None,
                    })
                }
            })
            .collect();
        let abs = summary_re.captures(entry).and_then(|c| c.get(1)).map(|m| collapse(m.as_str())).filter(|s| !s.is_empty());
        let published = pub_re.captures(entry).and_then(|c| c.get(1)).map(|m| m.as_str().trim().to_string());
        let category = cat_re.captures(entry).and_then(|c| c.get(1)).map(|m| m.as_str());
        let extra = match category {
            Some(cat) => format!("arXiv: {id} [{cat}]"),
            None => format!("arXiv: {id}"),
        };
        out.insert(
            id.clone(),
            MaterialMeta {
                kind: Some("preprint".into()),
                arxiv_id: Some(id),
                publication: Some("arXiv".into()),
                creators: if creators.is_empty() { None } else { Some(creators) },
                r#abstract: abs,
                date: published,
                extra: Some(extra),
                ..Default::default()
            },
        );
    }
    out
}

// ---------------------------------------------------------------------------
// Source detection (matching sources.ts)
// ---------------------------------------------------------------------------

pub fn alternate_feed_of(html: &str, base_url: &str) -> Option<String> {
    let end = html.char_indices().nth(256 * 1024).map(|(i, _)| i).unwrap_or(html.len());
    let head = &html[..end];
    let link_re = Regex::new(r"(?i)<link\b[^>]*>").unwrap();
    let rel_re = Regex::new(r#"(?i)\brel\s*=\s*["']([^"']*)["']"#).unwrap();
    let type_re = Regex::new(r#"(?i)\btype\s*=\s*["']([^"']*)["']"#).unwrap();
    let href_re = Regex::new(r#"(?i)\bhref\s*=\s*["']([^"']*)["']"#).unwrap();

    let mut candidates: Vec<(String, String)> = Vec::new();
    for m in link_re.find_iter(head) {
        let tag = m.as_str();
        let rel = rel_re.captures(tag).and_then(|c| c.get(1)).map(|m| m.as_str().to_lowercase()).unwrap_or_default();
        if !rel.split_whitespace().any(|r| r == "alternate") {
            continue;
        }
        let mime = type_re.captures(tag).and_then(|c| c.get(1)).map(|m| m.as_str().to_lowercase()).unwrap_or_default();
        let Some(href) = href_re.captures(tag).and_then(|c| c.get(1)).map(|m| m.as_str().trim().to_string()) else {
            continue;
        };
        if (mime == "application/atom+xml" || mime == "application/rss+xml") && !href.is_empty() {
            candidates.push((mime, href));
        }
    }
    let chosen = candidates
        .iter()
        .find(|(t, _)| t == "application/atom+xml")
        .or_else(|| candidates.first())?;
    let base = Url::parse(base_url).ok()?;
    base.join(&chosen.1).ok().map(|u| u.to_string())
}

fn is_feed_home(page_url: &str, feed_url: &str) -> bool {
    let (Ok(page), Ok(feed)) = (Url::parse(page_url), Url::parse(feed_url)) else {
        return false;
    };
    let index_re = Regex::new(r"(?i)index\.html?$").unwrap();
    let home = index_re.replace(page.path(), "");
    if page.query().is_some() || !home.ends_with('/') {
        return false;
    }
    home == "/" || (feed.origin() == page.origin() && feed.path().starts_with(home.as_ref()))
}

pub async fn detect_source(client: &reqwest::Client, input: &str) -> Result<SourceDetection, FetchError> {
    let value = input.trim();
    if let Some(category) = arxiv_category_from_input(value) {
        return Ok(SourceDetection::Arxiv {
            title: format!("arXiv {category}"),
            category,
        });
    }
    let normalized = if value.starts_with("http://") || value.starts_with("https://") || value.to_lowercase().starts_with("http") {
        value.to_string()
    } else {
        format!("https://{value}")
    };
    let url = assert_public_http_url(&normalized)?;
    let page = fetch_page(client, &url, FEED_ACCEPT).await?;
    let head_len = page.bytes.len().min(64 * 1024);
    let head = String::from_utf8_lossy(&page.bytes[..head_len]);

    let xml_type_re = Regex::new(r"^(?:application/(?:rss|atom|rdf)\+xml|application/xml|text/xml)$").unwrap();
    let feed_root_re = Regex::new(r"(?s)^(?:\u{feff})?\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--.*?-->\s*)*<(?:rss|feed|rdf:RDF)\b").unwrap();

    if xml_type_re.is_match(&page.media_type) || feed_root_re.is_match(&head) {
        let title_re = Regex::new(r"(?s)<(?:channel|feed)\b[^>]*>.*?<title(?:\s[^>]*)?>(?:<!\[CDATA\[)?([^<\]]{1,300})").unwrap();
        let title = title_re
            .captures(&head)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().split_whitespace().collect::<Vec<_>>().join(" "))
            .filter(|s| !s.is_empty());
        return Ok(SourceDetection::Feed {
            url: page.final_url,
            title,
        });
    }

    let head_256 = String::from_utf8_lossy(&page.bytes[..page.bytes.len().min(256 * 1024)]);
    if let Some(alt) = alternate_feed_of(&head_256, &page.final_url) {
        if !is_feed_home(&page.final_url, &alt) {
            let feed = assert_public_http_url(&alt).ok().map(|u| u.to_string());
            return Ok(SourceDetection::Page {
                url: page.final_url,
                feed,
            });
        }
        assert_public_http_url(&alt)?;
        let html_title_re = Regex::new(r"(?i)<title[^>]*>([^<]{1,300})</title>").unwrap();
        let title = html_title_re
            .captures(&head)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().split_whitespace().collect::<Vec<_>>().join(" "))
            .filter(|s| !s.is_empty());
        return Ok(SourceDetection::Feed { url: alt, title });
    }
    Ok(SourceDetection::Page {
        url: page.final_url,
        feed: None,
    })
}

pub fn subscription_of(detection: &SourceDetection) -> Option<(String, String, String)> {
    match detection {
        SourceDetection::Arxiv { category, title } => Some(("arxiv".into(), category.clone(), title.clone())),
        SourceDetection::Feed { url, title } => {
            let fallback = Url::parse(url).ok().and_then(|u| u.host_str().map(String::from)).unwrap_or_else(|| url.clone());
            Some(("feed".into(), url.clone(), title.clone().unwrap_or(fallback)))
        }
        SourceDetection::Podcast { url, title, .. } => {
            let fallback = Url::parse(url).ok().and_then(|u| u.host_str().map(String::from)).unwrap_or_else(|| url.clone());
            Some(("podcast".into(), url.clone(), title.clone().unwrap_or(fallback)))
        }
        SourceDetection::Youtube { url, title, .. } => {
            Some(("youtube".into(), url.clone(), title.clone().unwrap_or_else(|| "YouTube channel".into())))
        }
        SourceDetection::Page { feed: Some(feed), .. } | SourceDetection::Episode { feed: Some(feed), .. } => {
            let fallback = Url::parse(feed).ok().and_then(|u| u.host_str().map(String::from)).unwrap_or_else(|| feed.clone());
            Some(("feed".into(), feed.clone(), fallback))
        }
        SourceDetection::Page { feed: None, .. } | SourceDetection::Episode { feed: None, .. } => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_private_and_loopback_urls_and_strips_tracking() {
        assert!(assert_public_http_url("http://127.0.0.1:8080/a").is_err());
        assert!(assert_public_http_url("http://localhost/a").is_err());
        assert!(assert_public_http_url("http://192.168.1.10/a").is_err());
        assert!(assert_public_http_url("http://169.254.169.254/latest").is_err());
        assert!(assert_public_http_url("https://user:pass@example.com/a").is_err());

        let u = assert_public_http_url("https://example.com/post?utm_source=rss&id=42#top").unwrap();
        assert_eq!(canonical_url_of(&u), "https://example.com/post?id=42");
    }

    #[test]
    fn parses_arxiv_categories_and_versions() {
        assert_eq!(arxiv_category_from_input("cs.CL").as_deref(), Some("cs.CL"));
        assert_eq!(arxiv_category_from_input("https://arxiv.org/list/cs.LG/recent").as_deref(), Some("cs.LG"));
        assert_eq!(arxiv_rendering_version("2409.12345", &["https://arxiv.org/abs/2409.12345"], "arXiv:2409.12345v3 [cs.CL]"), Some(3));
    }
}
