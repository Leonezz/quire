use crate::http::{assert_public_http_url, is_private_host};
use crate::materials::{valid_hex_16, MaterialStore};
use crate::media::MediaCache;
use crate::normalizer_bridge::{NormalizeTranscriptInput, Normalizer, TranscriptCueDto};
use crate::settings::SettingsStore;
use crate::sqlite_stores::random_hex_16;
use crate::types::{AsrConnectionTestResult, AsrModelStatus, TranscribeEvent, TranscribeJobSnapshot};
use futures_util::StreamExt;
use serde::Deserialize;
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::Write;
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::process::Command;
use tokio::sync::Semaphore;
use url::Url;

pub const SAMPLE_RATE_HZ: u32 = 16_000;
const FRAME_SAMPLES: usize = 800; // 50ms at 16 kHz
const MIN_SILENCE_FRAMES: usize = 7; // 350ms natural pause
const TARGET_MIN_SEC: f64 = 30.0;
const TARGET_MAX_SEC: f64 = 60.0;
const HARD_MAX_SEC: f64 = 85.0; // ~2.7 MB WAV, well below 25 MB OpenAI limit

#[derive(Debug, Clone)]
pub struct AudioChunk {
    pub index: usize,
    pub start_sec: f64,
    pub end_sec: f64,
    pub wav_bytes: Vec<u8>,
}

pub fn is_loopback_host(host: &str) -> bool {
    let clean = host.trim_start_matches('[').trim_end_matches(']').to_ascii_lowercase();
    if clean == "localhost" || clean == "127.0.0.1" || clean == "::1" {
        return true;
    }
    if let Ok(ip) = clean.parse::<IpAddr>() {
        return ip.is_loopback();
    }
    false
}

/// Validates an ASR base URL configured in Settings:
/// - Explicitly permits `http://localhost` / `127.0.0.1` / `[::1]` so local Speaches,
///   `whisper-server`, or `vllm` containers work with zero TLS ceremony.
/// - Requires `https://` and non-private hosts for remote endpoints.
pub fn validate_asr_base_url(raw: &str) -> Result<Url, String> {
    let trimmed = raw.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("ASR base URL cannot be empty.".into());
    }
    let url = Url::parse(trimmed).map_err(|_| "ASR base URL is not a valid URL.".to_string())?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err("ASR base URL must not embed credentials; store the API key separately.".into());
    }
    let host = url.host_str().unwrap_or("");
    if host.is_empty() {
        return Err("ASR base URL has no host.".into());
    }
    if is_loopback_host(host) {
        if url.scheme() != "http" && url.scheme() != "https" {
            return Err("Local ASR base URL must use http:// or https://.".into());
        }
        return Ok(url);
    }
    if url.scheme() != "https" {
        return Err("Remote ASR endpoints must use https:// (http:// is allowed only for localhost).".into());
    }
    if is_private_host(host) {
        return Err("ASR base URL cannot point to a private LAN address (only localhost or public HTTPS endpoints are allowed).".into());
    }
    Ok(url)
}

/// Encodes 16 kHz mono 16-bit signed PCM samples into a standard 44-byte header RIFF `.wav`.
pub fn encode_wav_pcm16_16k(samples: &[i16]) -> Vec<u8> {
    let data_bytes = (samples.len() * 2) as u32;
    let riff_size = 36u32.saturating_add(data_bytes);
    let byte_rate = SAMPLE_RATE_HZ * 2;
    let mut out = Vec::with_capacity(44 + samples.len() * 2);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&riff_size.to_le_bytes());
    out.extend_from_slice(b"WAVE");
    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&16u32.to_le_bytes()); // PCM fmt chunk size
    out.extend_from_slice(&1u16.to_le_bytes()); // audio format = 1 (PCM)
    out.extend_from_slice(&1u16.to_le_bytes()); // channels = 1 (mono)
    out.extend_from_slice(&SAMPLE_RATE_HZ.to_le_bytes());
    out.extend_from_slice(&byte_rate.to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes()); // block align = 2 bytes
    out.extend_from_slice(&16u16.to_le_bytes()); // bits per sample = 16
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_bytes.to_le_bytes());
    for &sample in samples {
        out.extend_from_slice(&sample.to_le_bytes());
    }
    out
}

/// Parses a RIFF WAVE file holding 16-bit signed PCM (mono or stereo, downmixed/resampled to 16kHz mono).
pub fn parse_wav_pcm16_to_16k_mono(bytes: &[u8]) -> Option<Vec<i16>> {
    if bytes.len() < 44 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return None;
    }
    let mut pos = 12usize;
    let mut channels = 0u16;
    let mut sample_rate = 0u32;
    let mut bits_per_sample = 0u16;
    let mut audio_format = 0u16;
    let mut pcm_slice: Option<&[u8]> = None;

    while pos + 8 <= bytes.len() {
        let chunk_id = &bytes[pos..pos + 4];
        let chunk_len = u32::from_le_bytes([bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]]) as usize;
        let body_start = pos + 8;
        let body_end = body_start.saturating_add(chunk_len).min(bytes.len());
        if chunk_id == b"fmt " && body_end - body_start >= 16 {
            let fmt = &bytes[body_start..body_end];
            audio_format = u16::from_le_bytes([fmt[0], fmt[1]]);
            channels = u16::from_le_bytes([fmt[2], fmt[3]]);
            sample_rate = u32::from_le_bytes([fmt[4], fmt[5], fmt[6], fmt[7]]);
            bits_per_sample = u16::from_le_bytes([fmt[14], fmt[15]]);
        } else if chunk_id == b"data" {
            pcm_slice = Some(&bytes[body_start..body_end]);
            break;
        }
        pos = body_start.saturating_add(chunk_len);
        if chunk_len % 2 == 1 {
            pos = pos.saturating_add(1);
        }
    }

    let raw = pcm_slice?;
    if audio_format != 1 || bits_per_sample != 16 || channels == 0 || sample_rate == 0 {
        return None;
    }
    let ch = channels as usize;
    let frame_bytes = ch * 2;
    let total_frames = raw.len() / frame_bytes;
    let mut mono = Vec::with_capacity(total_frames);
    for i in 0..total_frames {
        let mut acc = 0i32;
        for c in 0..ch {
            let off = i * frame_bytes + c * 2;
            acc += i16::from_le_bytes([raw[off], raw[off + 1]]) as i32;
        }
        mono.push((acc / ch as i32) as i16);
    }

    if sample_rate == SAMPLE_RATE_HZ {
        return Some(mono);
    }
    // Linear resample when input WAV was not already 16 kHz
    let ratio = sample_rate as f64 / SAMPLE_RATE_HZ as f64;
    let out_len = ((mono.len() as f64) / ratio).floor() as usize;
    let mut resampled = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let src_pos = (i as f64) * ratio;
        let idx = (src_pos.floor() as usize).min(mono.len().saturating_sub(1));
        resampled.push(mono[idx]);
    }
    Some(resampled)
}

/// Decodes any audio/video file on disk into 16 kHz mono PCM16 samples:
/// 1. Direct pure-Rust parse if already PCM16 WAV;
/// 2. macOS CoreAudio `/usr/bin/afconvert` (zero external dependencies, hardware-accelerated);
/// 3. Fallback to `ffmpeg` if installed.
pub async fn decode_file_to_pcm16_16k(input_path: &Path, work_dir: &Path) -> Result<Vec<i16>, String> {
    if let Ok(bytes) = fs::read(input_path) {
        if let Some(samples) = parse_wav_pcm16_to_16k_mono(&bytes) {
            return Ok(samples);
        }
    }
    fs::create_dir_all(work_dir).map_err(|e| e.to_string())?;
    let temp_wav = work_dir.join(format!("decode-{}.wav", random_hex_16()));

    let mut decoded = false;
    if Path::new("/usr/bin/afconvert").is_file() {
        if let Ok(out) = Command::new("/usr/bin/afconvert")
            .arg("-f")
            .arg("WAVE")
            .arg("-d")
            .arg("LEI16@16000")
            .arg("-c")
            .arg("1")
            .arg(input_path)
            .arg(&temp_wav)
            .output()
            .await
        {
            decoded = out.status.success() && temp_wav.is_file();
        }
    }

    if !decoded {
        for bin in ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "ffmpeg"] {
            if let Ok(out) = Command::new(bin)
                .args(["-y", "-i"])
                .arg(input_path)
                .args(["-vn", "-ar", "16000", "-ac", "1", "-acodec", "pcm_s16le", "-f", "wav"])
                .arg(&temp_wav)
                .output()
                .await
            {
                if out.status.success() && temp_wav.is_file() {
                    decoded = true;
                    break;
                }
            }
        }
    }

    if !decoded {
        let _ = fs::remove_file(&temp_wav);
        return Err("Could not decode audio into 16 kHz PCM WAV (neither macOS afconvert nor ffmpeg succeeded).".into());
    }

    let wav_bytes = fs::read(&temp_wav).map_err(|e| e.to_string());
    let _ = fs::remove_file(&temp_wav);
    let wav_bytes = wav_bytes?;
    parse_wav_pcm16_to_16k_mono(&wav_bytes)
        .ok_or_else(|| "Decoded WAV file could not be parsed as 16-bit PCM.".to_string())
}

/// RMS energy-valley Voice Activity Detection (VAD) chunker:
/// Splits 16 kHz mono PCM samples at natural speech pauses (`>= 350ms`) within `[30s, 60s]`
/// windows (hard ceiling `85s`), producing self-contained `.wav` chunks with exact physical
/// `[start_sec, end_sec]` timestamps.
pub fn chunk_pcm16_by_silence(samples: &[i16]) -> Vec<AudioChunk> {
    if samples.is_empty() {
        return Vec::new();
    }
    let total_frames = (samples.len() + FRAME_SAMPLES - 1) / FRAME_SAMPLES;
    let mut rms = Vec::with_capacity(total_frames);
    for f in 0..total_frames {
        let start = f * FRAME_SAMPLES;
        let end = (start + FRAME_SAMPLES).min(samples.len());
        let mut sum_sq = 0.0_f64;
        for &s in &samples[start..end] {
            let v = s as f64;
            sum_sq += v * v;
        }
        rms.push((sum_sq / ((end - start).max(1) as f64)).sqrt());
    }

    let mut sorted_rms: Vec<f64> = rms.iter().copied().filter(|&v| v > 20.0).collect();
    sorted_rms.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let median_rms = if sorted_rms.is_empty() {
        200.0
    } else {
        sorted_rms[sorted_rms.len() / 2]
    };
    let silence_thresh = (median_rms * 0.22).max(120.0);

    let min_frames = ((TARGET_MIN_SEC * SAMPLE_RATE_HZ as f64) / FRAME_SAMPLES as f64).round() as usize;
    let target_max_frames = ((TARGET_MAX_SEC * SAMPLE_RATE_HZ as f64) / FRAME_SAMPLES as f64).round() as usize;
    let hard_max_frames = ((HARD_MAX_SEC * SAMPLE_RATE_HZ as f64) / FRAME_SAMPLES as f64).round() as usize;

    let mut chunks = Vec::new();
    let mut chunk_start_frame = 0usize;

    while chunk_start_frame < total_frames {
        let remaining_frames = total_frames - chunk_start_frame;
        if remaining_frames <= target_max_frames {
            let s_idx = chunk_start_frame * FRAME_SAMPLES;
            let slice = &samples[s_idx..];
            if !slice.is_empty() {
                chunks.push(AudioChunk {
                    index: chunks.len(),
                    start_sec: (s_idx as f64) / (SAMPLE_RATE_HZ as f64),
                    end_sec: (samples.len() as f64) / (SAMPLE_RATE_HZ as f64),
                    wav_bytes: encode_wav_pcm16_16k(slice),
                });
            }
            break;
        }

        let search_from = chunk_start_frame + min_frames;
        let search_to = (chunk_start_frame + hard_max_frames).min(total_frames);

        // Look for the quietest sustained pause (>= MIN_SILENCE_FRAMES) in [30s, 85s], preferring [30s, 60s]
        let mut best_cut_frame: Option<usize> = None;
        let mut best_valley_score = f64::INFINITY;
        let mut quiet_run = 0usize;

        for f in search_from..search_to {
            if rms[f] <= silence_thresh {
                quiet_run += 1;
                if quiet_run >= MIN_SILENCE_FRAMES {
                    let center = f - quiet_run / 2;
                    let penalty = if center > chunk_start_frame + target_max_frames { 1.35 } else { 1.0 };
                    let score = (rms[center] + 1.0) * penalty;
                    if score < best_valley_score {
                        best_valley_score = score;
                        best_cut_frame = Some(center);
                    }
                    // Once we found a clean pause inside [30s, 60s] and exited it, stop early
                    if center <= chunk_start_frame + target_max_frames && quiet_run >= MIN_SILENCE_FRAMES + 2 {
                        break;
                    }
                }
            } else {
                quiet_run = 0;
            }
        }

        let cut_frame = best_cut_frame.unwrap_or_else(|| {
            let fb_from = (chunk_start_frame + target_max_frames).min(search_to.saturating_sub(1));
            (fb_from..search_to)
                .min_by(|&a, &b| rms[a].partial_cmp(&rms[b]).unwrap_or(std::cmp::Ordering::Equal))
                .unwrap_or(search_to)
        });

        let s_idx = chunk_start_frame * FRAME_SAMPLES;
        let e_idx = (cut_frame * FRAME_SAMPLES).min(samples.len());
        if e_idx > s_idx {
            chunks.push(AudioChunk {
                index: chunks.len(),
                start_sec: (s_idx as f64) / (SAMPLE_RATE_HZ as f64),
                end_sec: (e_idx as f64) / (SAMPLE_RATE_HZ as f64),
                wav_bytes: encode_wav_pcm16_16k(&samples[s_idx..e_idx]),
            });
        }
        chunk_start_frame = cut_frame.max(chunk_start_frame + 1);
    }

    chunks
}

fn build_multipart_body(
    boundary: &str,
    wav_bytes: &[u8],
    filename: &str,
    model: &str,
    response_format: &str,
) -> Vec<u8> {
    let mut body = Vec::with_capacity(wav_bytes.len() + 512);
    let write_field = |buf: &mut Vec<u8>, name: &str, val: &str| {
        buf.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
        buf.extend_from_slice(
            format!("Content-Disposition: form-data; name=\"{name}\"\r\n\r\n{val}\r\n").as_bytes(),
        );
    };
    write_field(&mut body, "model", model);
    write_field(&mut body, "response_format", response_format);

    body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
    body.extend_from_slice(
        format!("Content-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\n").as_bytes(),
    );
    body.extend_from_slice(b"Content-Type: audio/wav\r\n\r\n");
    body.extend_from_slice(wav_bytes);
    body.extend_from_slice(b"\r\n");
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    body
}

#[derive(Debug, Deserialize)]
struct OpenAiTranscriptionResponse {
    #[serde(default)]
    text: String,
    #[serde(default)]
    segments: Option<Vec<OpenAiSegment>>,
}

#[derive(Debug, Deserialize)]
struct OpenAiSegment {
    start: f64,
    end: f64,
    text: String,
}

/// Splits text-only ASR output (e.g. `SenseVoiceSmall` or `gpt-4o-transcribe`) into proportional
/// cues anchored strictly inside the VAD chunk's physical `[start_sec, end_sec]` window.
pub fn cues_from_plain_chunk_text(text: &str, start_sec: f64, end_sec: f64) -> Vec<TranscriptCueDto> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    let mut sentences: Vec<String> = Vec::new();
    let mut current = String::new();
    for ch in trimmed.chars() {
        current.push(ch);
        if matches!(ch, '.' | '?' | '!' | '。' | '？' | '！' | '\n') && current.trim().chars().count() >= 12 {
            sentences.push(current.trim().to_string());
            current.clear();
        }
    }
    if !current.trim().is_empty() {
        sentences.push(current.trim().to_string());
    }
    if sentences.is_empty() {
        return Vec::new();
    }

    let total_chars: usize = sentences.iter().map(|s| s.chars().count().max(1)).sum();
    let span = (end_sec - start_sec).max(0.5);
    let mut cursor = start_sec;
    let mut out = Vec::with_capacity(sentences.len());

    for (idx, sent) in sentences.iter().enumerate() {
        let weight = sent.chars().count().max(1) as f64 / (total_chars as f64);
        let next_end = if idx + 1 == sentences.len() {
            end_sec
        } else {
            (cursor + span * weight).min(end_sec)
        };
        out.push(TranscriptCueDto {
            start_sec: (cursor * 100.0).round() / 100.0,
            end_sec: (next_end.max(cursor + 0.2) * 100.0).round() / 100.0,
            text: sent.clone(),
            speaker: None,
        });
        cursor = next_end;
    }
    out
}

pub async fn transcribe_chunk_openai_compatible(
    client: &reqwest::Client,
    base_url: &Url,
    api_key: Option<&str>,
    model: &str,
    chunk: &AudioChunk,
) -> Result<(Vec<TranscriptCueDto>, bool), String> {
    let endpoint = format!("{}/audio/transcriptions", base_url.as_str().trim_end_matches('/'));
    let eff_model = if model.trim().is_empty() {
        "whisper-large-v3-turbo"
    } else {
        model.trim()
    };
    let filename = format!("chunk-{:04}.wav", chunk.index);

    // 1. Try `verbose_json` first for fine-grained segment timestamps
    let boundary = format!("----quireasr{}", random_hex_16());
    let verbose_body = build_multipart_body(&boundary, &chunk.wav_bytes, &filename, eff_model, "verbose_json");
    let mut req = client
        .post(&endpoint)
        .header(
            reqwest::header::CONTENT_TYPE,
            format!("multipart/form-data; boundary={boundary}"),
        )
        .body(verbose_body);
    if let Some(k) = api_key.filter(|k| !k.trim().is_empty()) {
        req = req.bearer_auth(k.trim());
    }

    let resp = req.send().await.map_err(|e| format!("ASR request failed: {e}"))?;
    let status = resp.status();

    if status.is_success() {
        let body_bytes = resp.bytes().await.map_err(|e| e.to_string())?;
        if let Ok(parsed) = serde_json::from_slice::<OpenAiTranscriptionResponse>(&body_bytes) {
            if let Some(segs) = parsed.segments.filter(|s| !s.is_empty()) {
                let cues: Vec<TranscriptCueDto> = segs
                    .into_iter()
                    .filter_map(|s| {
                        let txt = s.text.trim().to_string();
                        if txt.is_empty() {
                            return None;
                        }
                        let st = (chunk.start_sec + s.start.max(0.0)).min(chunk.end_sec);
                        let en = (chunk.start_sec + s.end.max(s.start + 0.2)).min(chunk.end_sec + 1.0);
                        Some(TranscriptCueDto {
                            start_sec: (st * 100.0).round() / 100.0,
                            end_sec: (en * 100.0).round() / 100.0,
                            text: txt,
                            speaker: None,
                        })
                    })
                    .collect();
                return Ok((cues, true));
            }
            return Ok((
                cues_from_plain_chunk_text(&parsed.text, chunk.start_sec, chunk.end_sec),
                false,
            ));
        }
        let raw_txt = String::from_utf8_lossy(&body_bytes);
        return Ok((
            cues_from_plain_chunk_text(&raw_txt, chunk.start_sec, chunk.end_sec),
            false,
        ));
    }

    // 2. If endpoint rejected `verbose_json` (HTTP 400 / 422, e.g. SenseVoiceSmall or gpt-4o-transcribe),
    //    fall back to `response_format="json"` and anchor to the physical VAD chunk window!
    if status.as_u16() != 400 && status.as_u16() != 422 {
        let err_txt = resp.text().await.unwrap_or_default();
        return Err(format!(
            "ASR endpoint answered HTTP {}: {}",
            status.as_u16(),
            err_txt.chars().take(240).collect::<String>()
        ));
    }

    let boundary_fb = format!("----quireasrfb{}", random_hex_16());
    let json_body = build_multipart_body(&boundary_fb, &chunk.wav_bytes, &filename, eff_model, "json");
    let mut fb_req = client
        .post(&endpoint)
        .header(
            reqwest::header::CONTENT_TYPE,
            format!("multipart/form-data; boundary={boundary_fb}"),
        )
        .body(json_body);
    if let Some(k) = api_key.filter(|k| !k.trim().is_empty()) {
        fb_req = fb_req.bearer_auth(k.trim());
    }
    let fb_resp = fb_req.send().await.map_err(|e| format!("ASR fallback request failed: {e}"))?;
    if !fb_resp.status().is_success() {
        let code = fb_resp.status().as_u16();
        let err_txt = fb_resp.text().await.unwrap_or_default();
        return Err(format!(
            "ASR endpoint answered HTTP {code}: {}",
            err_txt.chars().take(240).collect::<String>()
        ));
    }
    let fb_bytes = fb_resp.bytes().await.map_err(|e| e.to_string())?;
    let parsed: OpenAiTranscriptionResponse =
        serde_json::from_slice(&fb_bytes).map_err(|e| format!("Invalid ASR JSON response: {e}"))?;
    Ok((
        cues_from_plain_chunk_text(&parsed.text, chunk.start_sec, chunk.end_sec),
        false,
    ))
}

pub fn whisper_model_candidates(model_name: &str) -> (&'static [&'static str], [&'static str; 2]) {
    match model_name.trim() {
        "small" => (
            &["ggml-small.bin"],
            [
                "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin",
                "https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-small.bin",
            ],
        ),
        "large-v3-turbo" => (
            &["ggml-large-v3-turbo-q5_0.bin", "ggml-large-v3-turbo.bin"],
            [
                "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin",
                "https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin",
            ],
        ),
        _ => (
            &["ggml-base.bin"],
            [
                "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin",
                "https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-base.bin",
            ],
        ),
    }
}

pub fn local_whisper_binary() -> Option<String> {
    for candidate in [
        "/opt/homebrew/bin/whisper-cli",
        "/usr/local/bin/whisper-cli",
        "/opt/homebrew/bin/whisper-cpp",
        "/usr/local/bin/whisper-cpp",
    ] {
        if Path::new(candidate).is_file() {
            return Some(candidate.to_string());
        }
    }
    if let Ok(path_env) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path_env) {
            for bin in ["whisper-cli", "whisper-cpp"] {
                let p = dir.join(bin);
                if p.is_file() {
                    return Some(p.to_string_lossy().to_string());
                }
            }
        }
    }
    None
}

pub fn check_asr_model_status(data_dir: &Path, model_name: &str) -> AsrModelStatus {
    let normalized = match model_name.trim() {
        "small" => "small",
        "large-v3-turbo" => "large-v3-turbo",
        _ => "base",
    };
    let (file_names, _) = whisper_model_candidates(normalized);
    let models_dir = data_dir.join("models");
    let size_bytes = file_names.iter().find_map(|file_name| {
        fs::metadata(models_dir.join(file_name))
            .ok()
            .filter(|m| m.is_file() && m.len() > 1024 * 1024)
            .map(|m| m.len())
    });
    AsrModelStatus {
        model: normalized.into(),
        downloaded: size_bytes.is_some(),
        size_bytes,
        local_runtime_ready: local_whisper_binary().is_some(),
    }
}

fn build_model_download_client() -> reqwest::Client {
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
        .connect_timeout(Duration::from_secs(10))
        .read_timeout(Duration::from_secs(30))
        .redirect(policy)
        .build()
        .expect("model download client")
}

pub async fn download_asr_model(
    data_dir: &Path,
    model_name: &str,
    on_progress: impl Fn(crate::types::AsrModelDownloadProgress),
) -> Result<AsrModelStatus, String> {
    let normalized = match model_name.trim() {
        "small" => "small",
        "large-v3-turbo" => "large-v3-turbo",
        _ => "base",
    };
    let existing = check_asr_model_status(data_dir, normalized);
    if existing.downloaded {
        return Ok(existing);
    }

    let (file_names, urls) = whisper_model_candidates(normalized);
    let primary_file = file_names[0];
    let models_dir = data_dir.join("models");
    fs::create_dir_all(&models_dir).map_err(|e| e.to_string())?;
    let part_path = models_dir.join(format!("{primary_file}.part"));
    let final_path = models_dir.join(primary_file);

    let client = build_model_download_client();
    let resume_from = fs::metadata(&part_path)
        .ok()
        .filter(|m| m.is_file())
        .map(|m| m.len())
        .unwrap_or(0);

    let mut connected_resp = None;
    let mut last_err = String::new();
    for url_str in urls {
        let Ok(url) = assert_public_http_url(url_str) else {
            continue;
        };
        let mut req = client
            .get(url)
            .header(reqwest::header::USER_AGENT, "Quire/0.2 (+reading-workbench)");
        if resume_from > 0 {
            req = req.header(reqwest::header::RANGE, format!("bytes={resume_from}-"));
        }
        match req.send().await {
            Ok(resp) if resp.status().is_success() || resp.status().as_u16() == 206 => {
                connected_resp = Some(resp);
                break;
            }
            Ok(resp) if resp.status().as_u16() == 416 => {
                // Range not satisfiable -> restart clean
                let _ = fs::remove_file(&part_path);
                if let Ok(fresh) = client
                    .get(url_str)
                    .header(reqwest::header::USER_AGENT, "Quire/0.2 (+reading-workbench)")
                    .send()
                    .await
                {
                    if fresh.status().is_success() {
                        connected_resp = Some(fresh);
                        break;
                    }
                }
                last_err = format!("Model server answered HTTP {}.", resp.status().as_u16());
            }
            Ok(resp) => {
                last_err = format!("Model server answered HTTP {}.", resp.status().as_u16());
            }
            Err(e) => {
                last_err = format!("Could not reach model host: {e}");
            }
        }
    }

    let resp = connected_resp.ok_or_else(|| {
        if last_err.is_empty() {
            "Could not connect to Hugging Face or mirror.".to_string()
        } else {
            last_err
        }
    })?;

    let is_partial = resp.status().as_u16() == 206 && resume_from > 0;
    let base_bytes = if is_partial { resume_from } else { 0 };
    let total_bytes = resp.content_length().map(|len| base_bytes + len);

    let mut file = if is_partial {
        fs::OpenOptions::new()
            .append(true)
            .open(&part_path)
            .map_err(|e| e.to_string())?
    } else {
        File::create(&part_path).map_err(|e| e.to_string())?
    };

    let mut downloaded_bytes = base_bytes;
    on_progress(crate::types::AsrModelDownloadProgress {
        model: normalized.into(),
        downloaded_bytes,
        total_bytes,
    });

    let mut last_emit = Instant::now();
    let mut stream = resp.bytes_stream();
    while let Some(chunk_res) = stream.next().await {
        let chunk = chunk_res.map_err(|e| format!("Download interrupted ({downloaded_bytes} bytes saved, click Download again to resume): {e}"))?;
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        downloaded_bytes += chunk.len() as u64;
        if last_emit.elapsed() >= Duration::from_millis(200) {
            last_emit = Instant::now();
            on_progress(crate::types::AsrModelDownloadProgress {
                model: normalized.into(),
                downloaded_bytes,
                total_bytes,
            });
        }
    }
    let _ = file.flush();
    drop(file);
    fs::rename(&part_path, &final_path).map_err(|e| e.to_string())?;
    on_progress(crate::types::AsrModelDownloadProgress {
        model: normalized.into(),
        downloaded_bytes,
        total_bytes: Some(downloaded_bytes),
    });
    Ok(check_asr_model_status(data_dir, normalized))
}

async fn transcribe_chunk_local_whisper(
    data_dir: &Path,
    model_name: &str,
    chunk: &AudioChunk,
) -> Result<Vec<TranscriptCueDto>, String> {
    let Some(bin) = local_whisper_binary() else {
        return Err(
            "Local Whisper CLI is not installed (`brew install whisper-cpp`), or switch Settings › Transcription to an OpenAI-compatible ASR endpoint.".into(),
        );
    };
    let (file_names, _) = whisper_model_candidates(model_name);
    let models_dir = data_dir.join("models");
    let Some(model_path) = file_names
        .iter()
        .map(|f| models_dir.join(f))
        .find(|p| p.is_file())
    else {
        return Err(format!(
            "Local Whisper model ({}) is not downloaded yet. Download it in Settings › Transcription first.",
            file_names[0]
        ));
    };

    let tmp_dir = data_dir.join("tmp-asr");
    fs::create_dir_all(&tmp_dir).map_err(|e| e.to_string())?;
    let token = random_hex_16();
    let wav_path = tmp_dir.join(format!("{token}.wav"));
    let out_prefix = tmp_dir.join(&token);
    let json_path = tmp_dir.join(format!("{token}.json"));
    fs::write(&wav_path, &chunk.wav_bytes).map_err(|e| e.to_string())?;

    let output = Command::new(&bin)
        .arg("-m")
        .arg(&model_path)
        .arg("-f")
        .arg(&wav_path)
        .arg("-oj")
        .arg("-of")
        .arg(&out_prefix)
        .arg("-l")
        .arg("auto")
        .output()
        .await
        .map_err(|e| format!("Failed to run local whisper: {e}"));

    let _ = fs::remove_file(&wav_path);
    let output = output?;
    if !output.status.success() {
        let _ = fs::remove_file(&json_path);
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "Local Whisper failed: {}",
            stderr.chars().take(200).collect::<String>()
        ));
    }

    let raw_json = fs::read_to_string(&json_path).unwrap_or_default();
    let _ = fs::remove_file(&json_path);

    #[derive(Deserialize)]
    struct WhisperCppJson {
        #[serde(default)]
        transcription: Vec<WhisperCppItem>,
    }
    #[derive(Deserialize)]
    struct WhisperCppOffsets {
        from: u64,
        to: u64,
    }
    #[derive(Deserialize)]
    struct WhisperCppItem {
        offsets: Option<WhisperCppOffsets>,
        text: String,
    }

    if let Ok(parsed) = serde_json::from_str::<WhisperCppJson>(&raw_json) {
        let cues: Vec<TranscriptCueDto> = parsed
            .transcription
            .into_iter()
            .filter_map(|item| {
                let txt = item.text.trim().to_string();
                if txt.is_empty() {
                    return None;
                }
                let (from_ms, to_ms) = item
                    .offsets
                    .map(|o| (o.from as f64, o.to as f64))
                    .unwrap_or((0.0, (chunk.end_sec - chunk.start_sec) * 1000.0));
                Some(TranscriptCueDto {
                    start_sec: ((chunk.start_sec + from_ms / 1000.0) * 100.0).round() / 100.0,
                    end_sec: ((chunk.start_sec + (to_ms / 1000.0).max(from_ms / 1000.0 + 0.2)) * 100.0).round()
                        / 100.0,
                    text: txt,
                    speaker: None,
                })
            })
            .collect();
        return Ok(cues);
    }

    let fallback_txt = String::from_utf8_lossy(&output.stdout);
    Ok(cues_from_plain_chunk_text(&fallback_txt, chunk.start_sec, chunk.end_sec))
}

pub async fn test_asr_connection(settings: &SettingsStore) -> Result<AsrConnectionTestResult, String> {
    let cur = settings.get();
    if cur.asr_provider == "local" {
        let st = check_asr_model_status(Path::new(&cur.data_directory), &cur.local_whisper_model);
        if !st.local_runtime_ready {
            return Err("whisper-cli was not found on this Mac (`brew install whisper-cpp`).".into());
        }
        if !st.downloaded {
            return Err(format!("Model ggml-{}.bin is not downloaded yet.", st.model));
        }
        return Ok(AsrConnectionTestResult {
            latency_ms: 1,
            supports_verbose_json: true,
            model: format!("local:{}", st.model),
        });
    }

    let base_url = validate_asr_base_url(&cur.asr_base_url)?;
    let api_key = settings.optional_secret("asrApiKey")?;
    let host = base_url.host_str().unwrap_or("");
    if !is_loopback_host(host) && api_key.is_none() {
        return Err("Store an ASR API key first before testing a remote endpoint.".into());
    }

    let silent_samples = vec![0i16; (SAMPLE_RATE_HZ as usize) / 2]; // 0.5s silent probe
    let probe = AudioChunk {
        index: 0,
        start_sec: 0.0,
        end_sec: 0.5,
        wav_bytes: encode_wav_pcm16_16k(&silent_samples),
    };
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;

    let started = Instant::now();
    let (_, supports_verbose_json) = transcribe_chunk_openai_compatible(
        &client,
        &base_url,
        api_key.as_deref(),
        &cur.asr_model,
        &probe,
    )
    .await?;
    let latency_ms = started.elapsed().as_millis() as u64;
    let model = if cur.asr_model.trim().is_empty() {
        "whisper-large-v3-turbo".into()
    } else {
        cur.asr_model
    };
    Ok(AsrConnectionTestResult {
        latency_ms,
        supports_verbose_json,
        model,
    })
}

struct ActiveJob {
    snapshot: TranscribeJobSnapshot,
    cancelled: Arc<AtomicBool>,
}

pub struct TranscriptionService {
    data_dir: PathBuf,
    store: Arc<MaterialStore>,
    media_cache: MediaCache,
    normalizer: Arc<dyn Normalizer>,
    settings: Arc<SettingsStore>,
    http: reqwest::Client,
    jobs: Arc<Mutex<HashMap<String, ActiveJob>>>,
    on_event: Arc<dyn Fn(TranscribeEvent) + Send + Sync>,
    on_library_changed: Arc<dyn Fn() + Send + Sync>,
}

impl TranscriptionService {
    pub fn new(
        data_dir: impl Into<PathBuf>,
        store: Arc<MaterialStore>,
        media_cache: MediaCache,
        normalizer: Arc<dyn Normalizer>,
        settings: Arc<SettingsStore>,
        on_event: Arc<dyn Fn(TranscribeEvent) + Send + Sync>,
        on_library_changed: Arc<dyn Fn() + Send + Sync>,
    ) -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(90))
            .build()
            .expect("asr reqwest client");
        Self {
            data_dir: data_dir.into(),
            store,
            media_cache,
            normalizer,
            settings,
            http,
            jobs: Arc::new(Mutex::new(HashMap::new())),
            on_event,
            on_library_changed,
        }
    }

    pub fn list_jobs(&self) -> Vec<TranscribeJobSnapshot> {
        self.jobs
            .lock()
            .map(|m| m.values().map(|j| j.snapshot.clone()).collect())
            .unwrap_or_default()
    }

    pub fn cancel(&self, material_id: &str) {
        if let Ok(mut guard) = self.jobs.lock() {
            if let Some(job) = guard.remove(material_id) {
                job.cancelled.store(true, Ordering::Relaxed);
            }
        }
    }

    pub fn start(self: &Arc<Self>, material_id: &str, provider_override: Option<String>) -> Result<TranscribeJobSnapshot, String> {
        if !valid_hex_16(material_id) {
            return Err("IPC_INVALID_ID".into());
        }
        if let Ok(guard) = self.jobs.lock() {
            if let Some(existing) = guard.get(material_id) {
                return Ok(existing.snapshot.clone());
            }
        }
        let record = self
            .store
            .read_stored(material_id)?
            .ok_or_else(|| "Material is not in the library.".to_string())?;
        if record.media.is_none() {
            return Err("This material has no audio or video stream to transcribe.".into());
        }

        let cur_settings = self.settings.get();
        let provider = provider_override
            .filter(|p| p == "local" || p == "openai_compatible")
            .unwrap_or(cur_settings.asr_provider.clone());

        // Pre-flight validate configuration immediately before spawning background job
        if provider == "openai_compatible" {
            let base = validate_asr_base_url(&cur_settings.asr_base_url)?;
            let key = self.settings.optional_secret("asrApiKey")?;
            if !is_loopback_host(base.host_str().unwrap_or("")) && key.is_none() {
                return Err("Configure your ASR API key in Settings › Transcription first.".into());
            }
        } else {
            let st = check_asr_model_status(&self.data_dir, &cur_settings.local_whisper_model);
            if !st.local_runtime_ready || !st.downloaded {
                return Err(
                    "Local Whisper is not ready yet. Download a local model or configure an OpenAI-compatible ASR endpoint in Settings › Transcription.".into(),
                );
            }
        }

        let job_id = random_hex_16();
        let snapshot = TranscribeJobSnapshot {
            job_id: job_id.clone(),
            material_id: material_id.to_string(),
            provider: provider.clone(),
            phase: "preparing".into(),
            completed_chunks: 0,
            total_chunks: 0,
        };
        let cancelled = Arc::new(AtomicBool::new(false));
        {
            let mut guard = self.jobs.lock().map_err(|_| "Transcription lock poisoned".to_string())?;
            guard.insert(
                material_id.to_string(),
                ActiveJob {
                    snapshot: snapshot.clone(),
                    cancelled: cancelled.clone(),
                },
            );
        }

        let svc = self.clone();
        let mid = material_id.to_string();
        tauri::async_runtime::spawn(async move {
            svc.run_job(mid, job_id, provider, cancelled).await;
        });

        Ok(snapshot)
    }

    async fn run_job(
        &self,
        material_id: String,
        job_id: String,
        provider: String,
        cancelled: Arc<AtomicBool>,
    ) {
        (self.on_event)(TranscribeEvent::Preparing {
            job_id: job_id.clone(),
            material_id: material_id.clone(),
        });

        let outcome: Result<(), String> = async {
            let record = self
                .store
                .read_stored(&material_id)?
                .ok_or_else(|| "Material not found.".to_string())?;
            let media = record.media.clone().ok_or_else(|| "Material has no media.".to_string())?;

            // 1. Acquire local media file (use existing offline cache or download temporary copy)
            let work_dir = self.data_dir.join("tmp-asr");
            fs::create_dir_all(&work_dir).map_err(|e| e.to_string())?;
            let mut temp_audio: Option<PathBuf> = None;
            let audio_path = if let Some((cached_path, _, _)) = self.media_cache.stored(&material_id) {
                cached_path
            } else {
                let stream_url = if media.provider == "youtube" {
                    let vid = media
                        .video_id
                        .clone()
                        .or_else(|| crate::youtube::parse_youtube_video_id(&media.stream_url))
                        .ok_or_else(|| "Missing YouTube video id.".to_string())?;
                    crate::youtube::resolve_ytdlp_stream(&vid, None)
                        .await
                        .ok_or_else(|| "Install yt-dlp (`brew install yt-dlp`) to extract audio from YouTube videos without captions.".to_string())?
                } else {
                    media.stream_url.clone()
                };
                let valid = assert_public_http_url(&stream_url).map_err(|e| e.message)?;
                let resp = self
                    .media_cache
                    .client()
                    .get(valid)
                    .header(reqwest::header::USER_AGENT, "Quire/0.2 (+reading-workbench)")
                    .send()
                    .await
                    .map_err(|e| e.to_string())?;
                if !resp.status().is_success() {
                    return Err(format!("Media stream answered HTTP {}.", resp.status().as_u16()));
                }
                let p = work_dir.join(format!("src-{material_id}-{job_id}.bin"));
                let mut f = File::create(&p).map_err(|e| e.to_string())?;
                let mut stream = resp.bytes_stream();
                while let Some(chunk) = stream.next().await {
                    if cancelled.load(Ordering::Relaxed) {
                        drop(f);
                        let _ = fs::remove_file(&p);
                        return Err("Cancelled.".into());
                    }
                    let data = chunk.map_err(|e| e.to_string())?;
                    f.write_all(&data).map_err(|e| e.to_string())?;
                }
                let _ = f.flush();
                temp_audio = Some(p.clone());
                p
            };

            let decode_res = decode_file_to_pcm16_16k(&audio_path, &work_dir).await;
            if let Some(ref tp) = temp_audio {
                let _ = fs::remove_file(tp);
            }
            let samples = decode_res?;
            if cancelled.load(Ordering::Relaxed) {
                return Err("Cancelled.".into());
            }

            let chunks = chunk_pcm16_by_silence(&samples);
            if chunks.is_empty() {
                return Err("Audio stream contained no audible samples.".into());
            }
            let total_chunks = chunks.len() as u32;
            if let Ok(mut guard) = self.jobs.lock() {
                if let Some(j) = guard.get_mut(&material_id) {
                    j.snapshot.phase = "transcribing".into();
                    j.snapshot.total_chunks = total_chunks;
                }
            }

            let cur_settings = self.settings.get();
            let origin = if provider == "local" { "local_asr" } else { "cloud_asr" };
            let mut all_cues: Vec<TranscriptCueDto> = Vec::new();

            if provider == "openai_compatible" {
                let base_url = validate_asr_base_url(&cur_settings.asr_base_url)?;
                let api_key = self.settings.optional_secret("asrApiKey")?;
                let model = cur_settings.asr_model.clone();
                let sem = Arc::new(Semaphore::new(3));

                // Process in ordered batches of 3 so incremental reader updates stay strictly chronological
                for batch in chunks.chunks(3) {
                    if cancelled.load(Ordering::Relaxed) {
                        return Err("Cancelled.".into());
                    }
                    let mut handles = Vec::with_capacity(batch.len());
                    for ch in batch {
                        let sem_c = sem.clone();
                        let client_c = self.http.clone();
                        let base_c = base_url.clone();
                        let key_c = api_key.clone();
                        let mod_c = model.clone();
                        let ch_c = ch.clone();
                        handles.push(tokio::spawn(async move {
                            let _permit = sem_c.acquire().await.ok();
                            let (cues, _) = transcribe_chunk_openai_compatible(
                                &client_c,
                                &base_c,
                                key_c.as_deref(),
                                &mod_c,
                                &ch_c,
                            )
                            .await?;
                            Ok::<(usize, Vec<TranscriptCueDto>), String>((ch_c.index, cues))
                        }));
                    }
                    let mut batch_results = Vec::new();
                    for h in handles {
                        let res = h.await.map_err(|e| e.to_string())??;
                        batch_results.push(res);
                    }
                    batch_results.sort_by_key(|(idx, _)| *idx);
                    let mut last_idx = 0usize;
                    for (idx, cues) in batch_results {
                        last_idx = idx + 1;
                        all_cues.extend(cues);
                    }
                    if !all_cues.is_empty() {
                        self.flush_incremental_transcript(&material_id, &record.title, &media.chapters, &all_cues, origin)
                            .await?;
                    }
                    self.update_job_progress(&material_id, &job_id, last_idx as u32, total_chunks);
                }
            } else {
                for ch in &chunks {
                    if cancelled.load(Ordering::Relaxed) {
                        return Err("Cancelled.".into());
                    }
                    let cues = transcribe_chunk_local_whisper(&self.data_dir, &cur_settings.local_whisper_model, ch).await?;
                    all_cues.extend(cues);
                    if ((ch.index + 1) % 2 == 0 || ch.index + 1 == chunks.len()) && !all_cues.is_empty() {
                        self.flush_incremental_transcript(&material_id, &record.title, &media.chapters, &all_cues, origin)
                            .await?;
                    }
                    self.update_job_progress(&material_id, &job_id, (ch.index + 1) as u32, total_chunks);
                }
            }

            if all_cues.is_empty() {
                return Err("ASR returned no spoken words for this audio.".into());
            }
            self.flush_incremental_transcript(&material_id, &record.title, &media.chapters, &all_cues, origin)
                .await?;
            Ok(())
        }
        .await;

        if let Ok(mut guard) = self.jobs.lock() {
            guard.remove(&material_id);
        }

        match outcome {
            Ok(()) => {
                (self.on_library_changed)();
                (self.on_event)(TranscribeEvent::Completed {
                    job_id,
                    material_id,
                });
            }
            Err(message) => {
                if message != "Cancelled." {
                    (self.on_event)(TranscribeEvent::Failed {
                        job_id,
                        material_id,
                        message,
                    });
                }
            }
        }
    }

    fn update_job_progress(&self, material_id: &str, job_id: &str, completed_chunks: u32, total_chunks: u32) {
        if let Ok(mut guard) = self.jobs.lock() {
            if let Some(j) = guard.get_mut(material_id) {
                j.snapshot.completed_chunks = completed_chunks;
            }
        }
        (self.on_event)(TranscribeEvent::Progress {
            job_id: job_id.to_string(),
            material_id: material_id.to_string(),
            completed_chunks,
            total_chunks,
        });
    }

    async fn flush_incremental_transcript(
        &self,
        material_id: &str,
        title: &str,
        chapters: &Option<Vec<crate::types::MediaChapter>>,
        cues: &[TranscriptCueDto],
        origin: &str,
    ) -> Result<(), String> {
        let tx = self
            .normalizer
            .normalize_transcript(NormalizeTranscriptInput {
                raw_text: None,
                media_type: None,
                cues: Some(cues.to_vec()),
                chapters: chapters.clone(),
                keyframes: None,
                title: Some(title.to_string()),
            })
            .await?;
        self.store
            .save_transcribed_view(material_id, tx, origin, true)?;
        (self.on_library_changed)();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_localhost_http_asr_url_and_blocks_lan_or_plain_remote_http() {
        assert!(validate_asr_base_url("http://127.0.0.1:8000/v1").is_ok());
        assert!(validate_asr_base_url("http://localhost:8080/v1/").is_ok());
        assert!(validate_asr_base_url("https://api.groq.com/openai/v1").is_ok());
        assert!(validate_asr_base_url("https://api.siliconflow.cn/v1").is_ok());

        // Remote HTTP (non-localhost) and private LAN addresses must be rejected
        assert!(validate_asr_base_url("http://api.groq.com/openai/v1").is_err());
        assert!(validate_asr_base_url("http://192.168.1.50:8000/v1").is_err());
        assert!(validate_asr_base_url("https://169.254.169.254/v1").is_err());
    }

    #[test]
    fn encodes_parses_and_vad_chunks_16khz_pcm_at_silence_valley() {
        // Synthesize 75 seconds of 16 kHz audio: 42s speech tone + 0.6s silence valley + 32.4s speech tone
        let sr = SAMPLE_RATE_HZ as usize;
        let mut samples = Vec::with_capacity(75 * sr);
        for i in 0..(42 * sr) {
            let v = if i % 40 < 20 { 3500i16 } else { -3500i16 };
            samples.push(v);
        }
        // 600ms natural pause around 42.0s–42.6s
        samples.extend(std::iter::repeat(0i16).take((sr * 6) / 10));
        for i in 0..((324 * sr) / 10) {
            let v = if i % 40 < 20 { 3200i16 } else { -3200i16 };
            samples.push(v);
        }

        let wav = encode_wav_pcm16_16k(&samples);
        let parsed = parse_wav_pcm16_to_16k_mono(&wav).expect("valid wav");
        assert_eq!(parsed.len(), samples.len());

        let chunks = chunk_pcm16_by_silence(&parsed);
        assert_eq!(chunks.len(), 2);
        // Cut happens cleanly inside the [42.0s, 42.6s] silence valley!
        assert!(chunks[0].end_sec >= 41.9 && chunks[0].end_sec <= 42.7);
        assert_eq!(chunks[1].start_sec, chunks[0].end_sec);
        assert!((chunks[1].end_sec - 75.0).abs() < 0.05);

        // Plain-text fallback (for SenseVoice / gpt-4o-transcribe) stays strictly inside [start_sec, end_sec]
        let cues = cues_from_plain_chunk_text(
            "First sentence from a text-only ASR model. Second sentence right after.",
            chunks[1].start_sec,
            chunks[1].end_sec,
        );
        assert_eq!(cues.len(), 2);
        assert!((cues[0].start_sec - chunks[1].start_sec).abs() < 0.05);
        assert!((cues[1].end_sec - chunks[1].end_sec).abs() < 0.05);
    }
}
