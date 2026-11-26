use crate::types::Settings;
use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

pub const MIN_SYNC_MINUTES: u32 = 5;
pub const MAX_SYNC_MINUTES: u32 = 1440;
pub const MAX_MODEL_LENGTH: usize = 64;
pub const MAX_API_KEY_LENGTH: usize = 512;
const MAX_YOUTUBE_COOKIES_LENGTH: usize = 256 * 1024;
const MAX_PATH_LENGTH: usize = 1024;

pub trait SecretEncryptor: Send + Sync {
    fn available(&self) -> bool;
    fn encrypt(&self, plain: &str) -> Result<String, String>;
    fn decrypt(&self, sealed: &str) -> Result<String, String>;
}

pub struct KeychainAesEncryptor {
    service: String,
    account: String,
    cached_key: Mutex<Option<[u8; 32]>>,
}

impl Default for KeychainAesEncryptor {
    fn default() -> Self {
        Self::new("app.quire.desktop", "settings-master-key")
    }
}

impl KeychainAesEncryptor {
    pub fn new(service: impl Into<String>, account: impl Into<String>) -> Self {
        Self {
            service: service.into(),
            account: account.into(),
            cached_key: Mutex::new(None),
        }
    }

    #[cfg(target_os = "macos")]
    fn get_or_create_key(&self) -> Result<[u8; 32], String> {
        if let Ok(guard) = self.cached_key.lock() {
            if let Some(k) = *guard {
                return Ok(k);
            }
        }
        use security_framework::passwords::{get_generic_password, set_generic_password};
        if let Ok(existing) = get_generic_password(&self.service, &self.account) {
            if let Ok(decoded) = base64::engine::general_purpose::STANDARD.decode(&existing) {
                if decoded.len() == 32 {
                    let mut key = [0u8; 32];
                    key.copy_from_slice(&decoded);
                    if let Ok(mut guard) = self.cached_key.lock() {
                        *guard = Some(key);
                    }
                    return Ok(key);
                }
            }
        }
        let mut key = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut key);
        let encoded = base64::engine::general_purpose::STANDARD.encode(key);
        set_generic_password(&self.service, &self.account, encoded.as_bytes())
            .map_err(|e| format!("macOS Keychain unavailable: {e}"))?;
        if let Ok(mut guard) = self.cached_key.lock() {
            *guard = Some(key);
        }
        Ok(key)
    }

    #[cfg(not(target_os = "macos"))]
    fn get_or_create_key(&self) -> Result<[u8; 32], String> {
        Err("Keychain encryption is only configured on macOS.".into())
    }
}

impl SecretEncryptor for KeychainAesEncryptor {
    fn available(&self) -> bool {
        cfg!(target_os = "macos")
    }

    fn encrypt(&self, plain: &str) -> Result<String, String> {
        let key = self.get_or_create_key()?;
        let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| e.to_string())?;
        let mut nonce_bytes = [0u8; 12];
        rand::thread_rng().fill_bytes(&mut nonce_bytes);
        let ciphertext = cipher
            .encrypt(Nonce::from_slice(&nonce_bytes), plain.as_bytes())
            .map_err(|e| format!("AES-GCM encrypt failed: {e}"))?;
        let mut combined = Vec::with_capacity(12 + ciphertext.len());
        combined.extend_from_slice(&nonce_bytes);
        combined.extend_from_slice(&ciphertext);
        Ok(format!(
            "v1:{}",
            base64::engine::general_purpose::STANDARD.encode(combined)
        ))
    }

    fn decrypt(&self, sealed: &str) -> Result<String, String> {
        let b64 = sealed
            .strip_prefix("v1:")
            .ok_or_else(|| "Unsupported secret format (legacy Electron safeStorage blob)".to_string())?;
        let combined = base64::engine::general_purpose::STANDARD
            .decode(b64)
            .map_err(|_| "Corrupted base64 ciphertext".to_string())?;
        if combined.len() <= 12 {
            return Err("Ciphertext too short".into());
        }
        let key = self.get_or_create_key()?;
        let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| e.to_string())?;
        let plain_bytes = cipher
            .decrypt(Nonce::from_slice(&combined[..12]), &combined[12..])
            .map_err(|_| "Authentication tag mismatch".to_string())?;
        String::from_utf8(plain_bytes).map_err(|e| e.to_string())
    }
}

pub fn expand_codex_path(raw: &str, home: &str) -> String {
    let trimmed = raw.trim();
    if trimmed == "~" {
        return home.to_string();
    }
    if let Some(rest) = trimmed.strip_prefix("~/") {
        return Path::new(home).join(rest).to_string_lossy().to_string();
    }
    trimmed.to_string()
}

pub fn codex_binary_at(path: &str, exists: impl Fn(&Path) -> bool) -> Option<String> {
    if path.is_empty() {
        return None;
    }
    let p = Path::new(path);
    let in_dir = p.join("codex");
    if exists(&in_dir) {
        return Some(in_dir.to_string_lossy().to_string());
    }
    if exists(p) {
        return Some(path.to_string());
    }
    None
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredSettings {
    sync_interval_minutes: u32,
    keep_capture: bool,
    codex_path: String,
    agent_model: String,
    agent_reasoning_effort: String,
    check_updates_automatically: bool,
    reflow_judge: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    typesafe_api_key_encrypted: Option<String>,
    #[serde(default = "default_asr_provider")]
    asr_provider: String,
    #[serde(default = "default_asr_base_url")]
    asr_base_url: String,
    #[serde(default = "default_asr_model")]
    asr_model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    asr_api_key_encrypted: Option<String>,
    #[serde(default = "default_local_whisper_model")]
    local_whisper_model: String,
    #[serde(default)]
    remove_cached_media_after_finish: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    youtube_cookies_encrypted: Option<String>,
}

fn default_asr_provider() -> String {
    "local".into()
}
fn default_asr_base_url() -> String {
    "https://api.groq.com/openai/v1".into()
}
fn default_asr_model() -> String {
    "whisper-large-v3-turbo".into()
}
fn default_local_whisper_model() -> String {
    "base".into()
}

impl Default for StoredSettings {
    fn default() -> Self {
        Self {
            sync_interval_minutes: 30,
            keep_capture: true,
            codex_path: String::new(),
            agent_model: String::new(),
            agent_reasoning_effort: String::new(),
            check_updates_automatically: true,
            reflow_judge: "rules".into(),
            typesafe_api_key_encrypted: None,
            asr_provider: default_asr_provider(),
            asr_base_url: default_asr_base_url(),
            asr_model: default_asr_model(),
            asr_api_key_encrypted: None,
            local_whisper_model: default_local_whisper_model(),
            remove_cached_media_after_finish: false,
            youtube_cookies_encrypted: None,
        }
    }
}

pub struct SettingsStore {
    path: PathBuf,
    data_directory: String,
    home: String,
    encryptor: Arc<dyn SecretEncryptor>,
    current: Mutex<StoredSettings>,
}

impl SettingsStore {
    pub fn open(
        path: impl Into<PathBuf>,
        data_directory: impl Into<String>,
        home: impl Into<String>,
        encryptor: Arc<dyn SecretEncryptor>,
    ) -> Result<Self, String> {
        let path_buf = path.into();
        let data_dir_str = data_directory.into();
        let home_str = home.into();
        let loaded = Self::load_file(&path_buf, &home_str)?;
        Ok(Self {
            path: path_buf,
            data_directory: data_dir_str,
            home: home_str,
            encryptor,
            current: Mutex::new(loaded),
        })
    }

    fn load_file(path: &Path, home: &str) -> Result<StoredSettings, String> {
        let text = match fs::read_to_string(path) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(StoredSettings::default()),
            Err(e) => return Err(e.to_string()),
        };
        let val: serde_json::Value = serde_json::from_str(&text)
            .map_err(|e| format!("The settings file {} is not valid JSON ({e}). Fix or remove it.", path.display()))?;
        let obj = val
            .as_object()
            .ok_or_else(|| format!("The settings file {} must hold a JSON object. Fix or remove it.", path.display()))?;

        let mut s = StoredSettings::default();
        if let Some(sealed) = obj.get("typesafeApiKeyEncrypted").and_then(|v| v.as_str()) {
            if !sealed.is_empty() {
                s.typesafe_api_key_encrypted = Some(sealed.to_string());
            }
        }
        if let Some(v) = obj.get("syncIntervalMinutes") {
            if let Ok(n) = Self::valid_sync_interval(v) {
                s.sync_interval_minutes = n;
            }
        }
        if let Some(v) = obj.get("keepCapture").and_then(|v| v.as_bool()) {
            s.keep_capture = v;
        }
        if let Some(v) = obj.get("codexPath") {
            if let Ok(p) = Self::valid_codex_path(v, home) {
                s.codex_path = p;
            }
        }
        if let Some(v) = obj.get("agentModel") {
            if let Ok(m) = Self::valid_model(v) {
                s.agent_model = m;
            }
        }
        if let Some(v) = obj.get("agentReasoningEffort") {
            if let Ok(eff) = Self::valid_effort(v) {
                s.agent_reasoning_effort = eff;
            }
        }
        if let Some(v) = obj.get("checkUpdatesAutomatically").and_then(|v| v.as_bool()) {
            s.check_updates_automatically = v;
        }
        if let Some(v) = obj.get("reflowJudge") {
            if let Ok(j) = Self::valid_judge(v, s.typesafe_api_key_encrypted.is_some()) {
                s.reflow_judge = j;
            }
        }
        if let Some(sealed) = obj.get("asrApiKeyEncrypted").and_then(|v| v.as_str()) {
            if !sealed.is_empty() {
                s.asr_api_key_encrypted = Some(sealed.to_string());
            }
        }
        if let Some(v) = obj.get("asrProvider").and_then(|v| v.as_str()) {
            if matches!(v, "local" | "openai_compatible") {
                s.asr_provider = v.to_string();
            }
        }
        if let Some(v) = obj.get("asrBaseUrl").and_then(|v| v.as_str()) {
            if crate::transcribe::validate_asr_base_url(v).is_ok() {
                s.asr_base_url = v.trim().trim_end_matches('/').to_string();
            }
        }
        if let Some(v) = obj.get("asrModel").and_then(|v| v.as_str()) {
            let trimmed = v.trim();
            if trimmed.chars().count() <= 128 {
                s.asr_model = trimmed.to_string();
            }
        }
        if let Some(v) = obj.get("localWhisperModel").and_then(|v| v.as_str()) {
            if matches!(v, "base" | "small" | "large-v3-turbo") {
                s.local_whisper_model = v.to_string();
            }
        }
        if let Some(v) = obj.get("removeCachedMediaAfterFinish").and_then(|v| v.as_bool()) {
            s.remove_cached_media_after_finish = v;
        }
        if let Some(sealed) = obj.get("youtubeCookiesEncrypted").and_then(|v| v.as_str()) {
            if !sealed.is_empty() {
                s.youtube_cookies_encrypted = Some(sealed.to_string());
            }
        }
        Ok(s)
    }

    fn valid_sync_interval(val: &serde_json::Value) -> Result<u32, String> {
        let n = val.as_u64().ok_or_else(|| {
            format!("syncIntervalMinutes must be a whole number of minutes between {MIN_SYNC_MINUTES} and {MAX_SYNC_MINUTES}.")
        })?;
        if n < MIN_SYNC_MINUTES as u64 || n > MAX_SYNC_MINUTES as u64 {
            return Err(format!(
                "syncIntervalMinutes must be a whole number of minutes between {MIN_SYNC_MINUTES} and {MAX_SYNC_MINUTES}."
            ));
        }
        Ok(n as u32)
    }

    fn valid_flag(name: &str, val: &serde_json::Value) -> Result<bool, String> {
        val.as_bool().ok_or_else(|| format!("{name} must be true or false."))
    }

    fn valid_model(val: &serde_json::Value) -> Result<String, String> {
        let s = val.as_str().ok_or_else(|| {
            format!("agentModel must be at most {MAX_MODEL_LENGTH} characters, or empty for Codex's default.")
        })?;
        let trimmed = s.trim();
        if trimmed.chars().count() > MAX_MODEL_LENGTH {
            return Err(format!(
                "agentModel must be at most {MAX_MODEL_LENGTH} characters, or empty for Codex's default."
            ));
        }
        Ok(trimmed.to_string())
    }

    fn valid_effort(val: &serde_json::Value) -> Result<String, String> {
        let s = val
            .as_str()
            .ok_or_else(|| "agentReasoningEffort must be \"\", \"low\", \"medium\" or \"high\".".to_string())?;
        if !matches!(s, "" | "low" | "medium" | "high") {
            return Err("agentReasoningEffort must be \"\", \"low\", \"medium\" or \"high\".".into());
        }
        Ok(s.to_string())
    }

    fn valid_judge(val: &serde_json::Value, has_secret: bool) -> Result<String, String> {
        let s = val
            .as_str()
            .ok_or_else(|| "reflowJudge must be \"rules\" or \"jev\".".to_string())?;
        if !matches!(s, "rules" | "jev") {
            return Err("reflowJudge must be \"rules\" or \"jev\".".into());
        }
        if s == "jev" && !has_secret {
            return Err("reflowJudge \"jev\" needs a TypeSafe API key: store the key first (Settings › Agent), then choose Jev.".into());
        }
        Ok(s.to_string())
    }

    fn valid_codex_path(val: &serde_json::Value, home: &str) -> Result<String, String> {
        let s = val.as_str().ok_or_else(|| {
            format!("codexPath must be a path of at most {MAX_PATH_LENGTH} characters, or empty to auto-detect.")
        })?;
        if s.chars().count() > MAX_PATH_LENGTH {
            return Err(format!(
                "codexPath must be a path of at most {MAX_PATH_LENGTH} characters, or empty to auto-detect."
            ));
        }
        let expanded = expand_codex_path(s, home);
        if expanded.is_empty() {
            return Ok(String::new());
        }
        codex_binary_at(&expanded, |p| p.exists()).ok_or_else(|| {
            format!("codexPath points to {expanded}, which does not exist. Leave it empty to auto-detect the codex binary.")
        })
    }

    pub fn get(&self) -> Settings {
        let cur = self.current.lock().expect("settings lock").clone();
        Settings {
            sync_interval_minutes: cur.sync_interval_minutes,
            keep_capture: cur.keep_capture,
            codex_path: cur.codex_path,
            agent_model: cur.agent_model,
            agent_reasoning_effort: cur.agent_reasoning_effort,
            data_directory: self.data_directory.clone(),
            check_updates_automatically: cur.check_updates_automatically,
            reflow_judge: cur.reflow_judge,
            typesafe_api_key_set: cur.typesafe_api_key_encrypted.is_some(),
            asr_provider: cur.asr_provider,
            asr_base_url: cur.asr_base_url,
            asr_model: cur.asr_model,
            asr_api_key_set: cur.asr_api_key_encrypted.is_some(),
            local_whisper_model: cur.local_whisper_model,
            remove_cached_media_after_finish: cur.remove_cached_media_after_finish,
            youtube_connected: cur.youtube_cookies_encrypted.is_some(),
        }
    }

    pub fn update(&self, patch: &serde_json::Map<String, serde_json::Value>) -> Result<Settings, String> {
        let allowed = [
            "syncIntervalMinutes",
            "keepCapture",
            "codexPath",
            "agentModel",
            "agentReasoningEffort",
            "checkUpdatesAutomatically",
            "reflowJudge",
            "typesafeApiKey",
            "asrProvider",
            "asrBaseUrl",
            "asrModel",
            "asrApiKey",
            "localWhisperModel",
            "removeCachedMediaAfterFinish",
        ];
        let unknown: Vec<&str> = patch
            .keys()
            .map(String::as_str)
            .filter(|k| !allowed.contains(k))
            .collect();
        if !unknown.is_empty() {
            return Err(format!("Unknown or read-only setting(s): {}.", unknown.join(", ")));
        }

        let mut next = self.current.lock().map_err(|_| "Settings lock poisoned".to_string())?.clone();

        if let Some(raw_key) = patch.get("typesafeApiKey") {
            let k = raw_key.as_str().ok_or_else(|| {
                format!("typesafeApiKey must be a string of at most {MAX_API_KEY_LENGTH} characters, or empty to remove the stored key.")
            })?;
            if k.chars().count() > MAX_API_KEY_LENGTH {
                return Err(format!(
                    "typesafeApiKey must be a string of at most {MAX_API_KEY_LENGTH} characters, or empty to remove the stored key."
                ));
            }
            let trimmed = k.trim();
            if trimmed.is_empty() {
                next.typesafe_api_key_encrypted = None;
                if next.reflow_judge == "jev" {
                    next.reflow_judge = "rules".into();
                }
            } else {
                if !self.encryptor.available() {
                    return Err("This machine cannot encrypt secrets (Keychain is unavailable), so the key was not stored.".into());
                }
                let sealed = self.encryptor.encrypt(trimmed)?;
                next.typesafe_api_key_encrypted = Some(sealed);
            }
        }

        if let Some(v) = patch.get("syncIntervalMinutes") {
            next.sync_interval_minutes = Self::valid_sync_interval(v)?;
        }
        if let Some(v) = patch.get("keepCapture") {
            next.keep_capture = Self::valid_flag("keepCapture", v)?;
        }
        if let Some(v) = patch.get("codexPath") {
            next.codex_path = Self::valid_codex_path(v, &self.home)?;
        }
        if let Some(v) = patch.get("agentModel") {
            next.agent_model = Self::valid_model(v)?;
        }
        if let Some(v) = patch.get("agentReasoningEffort") {
            next.agent_reasoning_effort = Self::valid_effort(v)?;
        }
        if let Some(v) = patch.get("checkUpdatesAutomatically") {
            next.check_updates_automatically = Self::valid_flag("checkUpdatesAutomatically", v)?;
        }
        if let Some(v) = patch.get("reflowJudge") {
            next.reflow_judge = Self::valid_judge(v, next.typesafe_api_key_encrypted.is_some())?;
        }
        if let Some(raw_asr_key) = patch.get("asrApiKey") {
            let k = raw_asr_key.as_str().ok_or_else(|| {
                format!("asrApiKey must be a string of at most {MAX_API_KEY_LENGTH} characters, or empty to remove the stored key.")
            })?;
            if k.chars().count() > MAX_API_KEY_LENGTH {
                return Err(format!(
                    "asrApiKey must be a string of at most {MAX_API_KEY_LENGTH} characters, or empty to remove the stored key."
                ));
            }
            let trimmed = k.trim();
            if trimmed.is_empty() {
                next.asr_api_key_encrypted = None;
            } else {
                if !self.encryptor.available() {
                    return Err("This machine cannot encrypt secrets (Keychain is unavailable), so the ASR key was not stored.".into());
                }
                next.asr_api_key_encrypted = Some(self.encryptor.encrypt(trimmed)?);
            }
        }
        if let Some(v) = patch.get("asrProvider") {
            let s = v
                .as_str()
                .ok_or_else(|| "asrProvider must be \"local\" or \"openai_compatible\".".to_string())?;
            if !matches!(s, "local" | "openai_compatible") {
                return Err("asrProvider must be \"local\" or \"openai_compatible\".".into());
            }
            next.asr_provider = s.to_string();
        }
        if let Some(v) = patch.get("asrBaseUrl") {
            let s = v
                .as_str()
                .ok_or_else(|| "asrBaseUrl must be a URL string.".to_string())?;
            crate::transcribe::validate_asr_base_url(s)?;
            next.asr_base_url = s.trim().trim_end_matches('/').to_string();
        }
        if let Some(v) = patch.get("asrModel") {
            let s = v
                .as_str()
                .ok_or_else(|| "asrModel must be a string of at most 128 characters.".to_string())?;
            let trimmed = s.trim();
            if trimmed.chars().count() > 128 {
                return Err("asrModel must be at most 128 characters.".into());
            }
            next.asr_model = trimmed.to_string();
        }
        if let Some(v) = patch.get("localWhisperModel") {
            let s = v
                .as_str()
                .ok_or_else(|| "localWhisperModel must be \"base\", \"small\" or \"large-v3-turbo\".".to_string())?;
            if !matches!(s, "base" | "small" | "large-v3-turbo") {
                return Err("localWhisperModel must be \"base\", \"small\" or \"large-v3-turbo\".".into());
            }
            next.local_whisper_model = s.to_string();
        }
        if let Some(v) = patch.get("removeCachedMediaAfterFinish") {
            next.remove_cached_media_after_finish = Self::valid_flag("removeCachedMediaAfterFinish", v)?;
        }

        self.persist(next)
    }

    fn persist(&self, next: StoredSettings) -> Result<Settings, String> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let temp = self.path.with_extension("json.tmp");
        let json = serde_json::to_string_pretty(&next).map_err(|e| e.to_string())?;
        fs::write(&temp, json).map_err(|e| e.to_string())?;
        fs::rename(&temp, &self.path).map_err(|e| e.to_string())?;

        *self.current.lock().map_err(|_| "Settings lock poisoned".to_string())? = next;
        Ok(self.get())
    }

    pub fn set_youtube_cookies(&self, cookies_json: Option<&str>) -> Result<Settings, String> {
        let mut next = self
            .current
            .lock()
            .map_err(|_| "Settings lock poisoned".to_string())?
            .clone();
        match cookies_json.map(str::trim).filter(|s| !s.is_empty()) {
            Some(raw) => {
                if raw.len() > MAX_YOUTUBE_COOKIES_LENGTH {
                    return Err("YouTube session cookies exceeded the maximum storage size.".into());
                }
                if !self.encryptor.available() {
                    return Err(
                        "This machine cannot encrypt secrets (Keychain is unavailable), so the YouTube session was not stored."
                            .into(),
                    );
                }
                next.youtube_cookies_encrypted = Some(self.encryptor.encrypt(raw)?);
            }
            None => {
                next.youtube_cookies_encrypted = None;
            }
        }
        self.persist(next)
    }

    pub fn optional_secret(&self, name: &str) -> Result<Option<String>, String> {
        let cur = self.current.lock().map_err(|_| "Settings lock poisoned".to_string())?;
        let sealed = match name {
            "asrApiKey" => cur.asr_api_key_encrypted.clone(),
            "youtubeCookies" => cur.youtube_cookies_encrypted.clone(),
            _ => cur.typesafe_api_key_encrypted.clone(),
        };
        drop(cur);
        let Some(s) = sealed else {
            return Ok(None);
        };
        if !self.encryptor.available() {
            return Err(format!("The stored {name} cannot be decrypted right now: Keychain is unavailable."));
        }
        let plain = self
            .encryptor
            .decrypt(&s)
            .map_err(|e| format!("The stored {name} could not be decrypted ({e}). Remove it and enter it again."))?;
        if plain.is_empty() {
            return Ok(None);
        }
        Ok(Some(plain))
    }

    pub fn secret(&self, name: &str) -> Result<String, String> {
        self.optional_secret(name)?.ok_or_else(|| {
            if name == "asrApiKey" {
                "No asrApiKey is stored. Enter the ASR API key in Settings › Transcription.".into()
            } else if name == "youtubeCookies" {
                "No YouTube account is connected. Sign in to YouTube in Settings › Sources.".into()
            } else {
                format!("No {name} is stored. Enter the TypeSafe API key in Settings › Agent.")
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct MemEnc;
    impl SecretEncryptor for MemEnc {
        fn available(&self) -> bool {
            true
        }
        fn encrypt(&self, plain: &str) -> Result<String, String> {
            Ok(format!("enc:{plain}"))
        }
        fn decrypt(&self, sealed: &str) -> Result<String, String> {
            sealed.strip_prefix("enc:").map(String::from).ok_or_else(|| "bad".into())
        }
    }

    #[test]
    fn validates_and_persists_settings_and_secret() {
        let tmp = tempfile::tempdir().unwrap();
        let store = SettingsStore::open(
            tmp.path().join("settings.json"),
            tmp.path().to_string_lossy(),
            "/Users/test",
            Arc::new(MemEnc),
        )
        .unwrap();
        assert_eq!(store.get().sync_interval_minutes, 30);
        assert!(!store.get().typesafe_api_key_set);

        // Jev without API key fails
        let bad = serde_json::json!({ "reflowJudge": "jev" });
        assert!(store.update(bad.as_object().unwrap()).is_err());

        // Store API key + enable jev
        let patch = serde_json::json!({ "typesafeApiKey": "ts-secret-123", "reflowJudge": "jev", "syncIntervalMinutes": 15 });
        let updated = store.update(patch.as_object().unwrap()).unwrap();
        assert!(updated.typesafe_api_key_set);
        assert_eq!(updated.reflow_judge, "jev");
        assert_eq!(store.secret("typesafeApiKey").unwrap(), "ts-secret-123");

        // Clearing API key resets reflowJudge to rules
        let clear = serde_json::json!({ "typesafeApiKey": "" });
        let after = store.update(clear.as_object().unwrap()).unwrap();
        assert!(!after.typesafe_api_key_set);
        assert_eq!(after.reflow_judge, "rules");

        // Encrypted YouTube cookie jar round-trip
        assert!(!store.get().youtube_connected);
        let yt_set = store
            .set_youtube_cookies(Some(r#"[{"name":"SAPISID","value":"abc"}]"#))
            .unwrap();
        assert!(yt_set.youtube_connected);
        assert_eq!(
            store.optional_secret("youtubeCookies").unwrap().as_deref(),
            Some(r#"[{"name":"SAPISID","value":"abc"}]"#)
        );
        let yt_cleared = store.set_youtube_cookies(None).unwrap();
        assert!(!yt_cleared.youtube_connected);
        assert!(store.optional_secret("youtubeCookies").unwrap().is_none());
    }
}
