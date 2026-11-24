use crate::normalizer_bridge::BoxFuture;
use crate::settings::{codex_binary_at, expand_codex_path};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, Command};
use tokio::sync::{mpsc, oneshot};

const INSTALL_HINT: &str = "Install Codex CLI (npm i -g @openai/codex) or set CODEX_PATH to the codex binary.";
const THREAD_BUSY: &str = "The agent is still answering in this conversation; wait for it or interrupt it.";

#[derive(Debug, Clone)]
pub struct CodexError {
    pub code: String,
    pub message: String,
}

impl CodexError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DynamicTool {
    pub name: String,
    pub description: String,
    pub input_schema: serde_json::Value,
}

#[derive(Debug, Clone)]
pub struct ToolCall {
    pub tool: String,
    pub arguments: serde_json::Value,
    pub call_id: String,
}

#[derive(Debug, Clone)]
pub struct ToolReply {
    pub success: bool,
    pub text: String,
    pub summary: Option<String>,
    pub stop_turn: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ToolProgress {
    pub tool: String,
    pub status: String,
    pub summary: Option<String>,
}

#[derive(Debug, Clone)]
pub struct TurnOutcome {
    pub thread_id: String,
    pub turn_id: String,
    pub text: String,
}

pub type ToolCallHandler = Arc<dyn Fn(ToolCall) -> BoxFuture<'static, ToolReply> + Send + Sync>;

pub struct TurnOptions {
    pub cwd: PathBuf,
    pub thread_id: Option<String>,
    pub prompt: String,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub dynamic_tools: Vec<DynamicTool>,
    pub on_tool_call: ToolCallHandler,
    pub on_started: Box<dyn Fn(String, String) + Send + Sync>,
    pub on_delta: Box<dyn Fn(String) + Send + Sync>,
    pub on_tool: Box<dyn Fn(ToolProgress) + Send + Sync>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexAccount {
    #[serde(rename = "type")]
    pub account_type: String,
    pub email: Option<String>,
    pub plan_type: Option<String>,
}

pub fn resolve_codex_binary(configured_path: &str) -> Result<String, CodexError> {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/Users".into());
    let from_settings = expand_codex_path(configured_path, &home);
    if !from_settings.is_empty() {
        return codex_binary_at(&from_settings, |p| p.exists()).ok_or_else(|| {
            CodexError::new(
                "AGENT_UNAVAILABLE",
                format!("The Codex path in Settings ({from_settings}) does not exist. Fix it or clear it to auto-detect."),
            )
        });
    }
    let env_codex = std::env::var("CODEX_PATH").unwrap_or_default();
    let expanded_env = expand_codex_path(&env_codex, &home);
    if !expanded_env.is_empty() {
        return codex_binary_at(&expanded_env, |p| p.exists()).ok_or_else(|| {
            CodexError::new(
                "AGENT_UNAVAILABLE",
                format!("CODEX_PATH points to {expanded_env}, which does not exist. {INSTALL_HINT}"),
            )
        });
    }
    for fixed in ["/opt/homebrew/bin/codex", "/usr/local/bin/codex"] {
        if Path::new(fixed).exists() {
            return Ok(fixed.to_string());
        }
    }
    if let Ok(path_var) = std::env::var("PATH") {
        for dir in path_var.split(':').filter(|s| !s.is_empty()) {
            let cand = Path::new(dir).join("codex");
            if cand.exists() {
                return Ok(cand.to_string_lossy().to_string());
            }
        }
    }
    Err(CodexError::new(
        "AGENT_UNAVAILABLE",
        format!("Codex CLI was not found. {INSTALL_HINT}"),
    ))
}

struct TurnState {
    turn_id: Option<String>,
    closed: bool,
    interrupt_requested: bool,
    final_text: String,
    early_events: Vec<serde_json::Value>,
    on_tool_call: ToolCallHandler,
    on_started: Box<dyn Fn(String, String) + Send + Sync>,
    on_delta: Box<dyn Fn(String) + Send + Sync>,
    on_tool: Box<dyn Fn(ToolProgress) + Send + Sync>,
    done_tx: Option<oneshot::Sender<Result<TurnOutcome, CodexError>>>,
}

struct ServerHandle {
    stdin_tx: mpsc::UnboundedSender<String>,
    kill_tx: Option<oneshot::Sender<()>>,
    initialized: bool,
}

pub struct CodexClient {
    configured_path: Arc<dyn Fn() -> String + Send + Sync>,
    codex_home: PathBuf,
    next_id: AtomicU64,
    server: tokio::sync::Mutex<Option<ServerHandle>>,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Result<serde_json::Value, CodexError>>>>>,
    turns: Arc<Mutex<HashMap<String, Arc<Mutex<TurnState>>>>>,
    cached_version: Mutex<Option<String>>,
    cached_account: Mutex<Option<Option<CodexAccount>>>,
}

impl CodexClient {
    pub fn new(
        configured_path: Arc<dyn Fn() -> String + Send + Sync>,
        codex_home: impl Into<PathBuf>,
    ) -> Self {
        Self {
            configured_path,
            codex_home: codex_home.into(),
            next_id: AtomicU64::new(1),
            server: tokio::sync::Mutex::new(None),
            pending: Arc::new(Mutex::new(HashMap::new())),
            turns: Arc::new(Mutex::new(HashMap::new())),
            cached_version: Mutex::new(None),
            cached_account: Mutex::new(None),
        }
    }

    pub fn running_count(&self) -> u32 {
        self.turns.lock().map(|t| t.len() as u32).unwrap_or(0)
    }

    fn binary(&self) -> Result<String, CodexError> {
        resolve_codex_binary(&(self.configured_path)())
    }

    pub async fn version(&self) -> Result<String, CodexError> {
        if let Ok(guard) = self.cached_version.lock() {
            if let Some(ref v) = *guard {
                return Ok(v.clone());
            }
        }
        let bin = self.binary()?;
        let output = Command::new(&bin)
            .arg("--version")
            .env("CODEX_HOME", &self.codex_home)
            .env("NO_COLOR", "1")
            .output()
            .await
            .map_err(|e| CodexError::new("AGENT_UNAVAILABLE", format!("Could not run {bin}: {e}")))?;
        let text = String::from_utf8_lossy(&output.stdout);
        let re = Regex::new(r"(?i)codex(?:-cli)?\s+v?(\d+\.\d+\.\d+\S*)").unwrap();
        if let Some(v) = re.captures(&text).and_then(|c| c.get(1)).map(|m| m.as_str().to_string()) {
            if let Ok(mut guard) = self.cached_version.lock() {
                *guard = Some(v.clone());
            }
            Ok(v)
        } else {
            Err(CodexError::new(
                "AGENT_UNAVAILABLE",
                format!(
                    "codex --version exited with {:?} and printed {:?}.",
                    output.status.code(),
                    text.trim().chars().take(120).collect::<String>()
                ),
            ))
        }
    }

    async fn ensure_started(&self) -> Result<mpsc::UnboundedSender<String>, CodexError> {
        let mut guard = self.server.lock().await;
        if let Some(ref h) = *guard {
            if !h.stdin_tx.is_closed() {
                return Ok(h.stdin_tx.clone());
            }
        }
        fs::create_dir_all(&self.codex_home).map_err(|e| {
            CodexError::new(
                "AGENT_UNAVAILABLE",
                format!("Could not create Quire's Codex home {}: {e}", self.codex_home.display()),
            )
        })?;
        let bin = self.binary()?;
        let mut child = Command::new(&bin)
            .arg("app-server")
            .env("CODEX_HOME", &self.codex_home)
            .env("NO_COLOR", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| CodexError::new("APP_SERVER_EXITED", format!("codex app-server could not run: {e}")))?;

        let mut stdin: ChildStdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();

        let (stdin_tx, mut stdin_rx) = mpsc::unbounded_channel::<String>();
        let (kill_tx, mut kill_rx) = oneshot::channel::<()>();

        tokio::spawn(async move {
            while let Some(line) = stdin_rx.recv().await {
                if stdin.write_all(line.as_bytes()).await.is_err() {
                    break;
                }
                let _ = stdin.flush().await;
            }
        });

        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if !line.trim().is_empty() {
                    eprintln!("[agent] {line}");
                }
            }
        });

        let pending_map = self.pending.clone();
        let turns_map = self.turns.clone();
        let stdin_reply_tx = stdin_tx.clone();

        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            loop {
                tokio::select! {
                    _ = &mut kill_rx => {
                        let _ = child.kill().await;
                        break;
                    }
                    line_res = lines.next_line() => {
                        match line_res {
                            Ok(Some(line)) => {
                                handle_server_line(&line, &stdin_reply_tx, &pending_map, &turns_map);
                            }
                            _ => {
                                let _ = child.wait().await;
                                break;
                            }
                        }
                    }
                }
            }
            fail_all_pending(&pending_map, &turns_map, CodexError::new("APP_SERVER_EXITED", "codex app-server exited."));
        });

        *guard = Some(ServerHandle {
            stdin_tx: stdin_tx.clone(),
            kill_tx: Some(kill_tx),
            initialized: false,
        });
        Ok(stdin_tx)
    }

    async fn request(
        &self,
        method: &str,
        params: serde_json::Value,
        timeout_ms: u64,
    ) -> Result<serde_json::Value, CodexError> {
        let stdin_tx = self.ensure_started().await?;
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        {
            self.pending.lock().unwrap().insert(id, tx);
        }
        let msg = serde_json::json!({
            "id": id,
            "method": method,
            "params": params,
        });
        if stdin_tx.send(format!("{msg}\n")).is_err() {
            self.pending.lock().unwrap().remove(&id);
            return Err(CodexError::new("APP_SERVER_EXITED", "codex app-server is not running."));
        }
        match tokio::time::timeout(Duration::from_millis(timeout_ms), rx).await {
            Ok(Ok(res)) => res,
            Ok(Err(_)) => Err(CodexError::new("APP_SERVER_EXITED", "codex app-server closed.")),
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);
                Err(CodexError::new(
                    "APP_SERVER_TIMEOUT",
                    format!("codex app-server did not answer {method} within {}s.", timeout_ms / 1000),
                ))
            }
        }
    }

    pub async fn initialize(&self) -> Result<(), CodexError> {
        {
            let guard = self.server.lock().await;
            if let Some(ref h) = *guard {
                if h.initialized && !h.stdin_tx.is_closed() {
                    return Ok(());
                }
            }
        }
        self.request(
            "initialize",
            serde_json::json!({
                "clientInfo": { "name": "quire", "title": "Quire", "version": "0.2.0" },
                "capabilities": { "experimentalApi": true }
            }),
            120_000,
        )
        .await?;
        let mut guard = self.server.lock().await;
        if let Some(ref mut h) = *guard {
            let init_notif = serde_json::json!({ "method": "initialized", "params": {} });
            let _ = h.stdin_tx.send(format!("{init_notif}\n"));
            h.initialized = true;
        }
        Ok(())
    }

    pub async fn account(&self) -> Result<Option<CodexAccount>, CodexError> {
        self.initialize().await?;
        let res = self
            .request("account/read", serde_json::json!({ "refreshToken": false }), 30_000)
            .await?;
        let acc = res
            .get("account")
            .and_then(|v| serde_json::from_value::<CodexAccount>(v.clone()).ok());
        if let Ok(mut cache) = self.cached_account.lock() {
            *cache = Some(acc.clone());
        }
        Ok(acc)
    }

    /// Reads the account once and shuts down the idle `codex app-server` subprocess when no
    /// turns are active, saving ~60 MiB RSS during quiet reading.
    pub async fn status_account(&self) -> Result<Option<CodexAccount>, CodexError> {
        if let Ok(cache) = self.cached_account.lock() {
            if let Some(ref known) = *cache {
                return Ok(known.clone());
            }
        }
        let acc = self.account().await?;
        self.stop_if_idle().await;
        Ok(acc)
    }

    pub async fn stop_if_idle(&self) {
        if self.running_count() > 0 || !self.pending.lock().map(|p| p.is_empty()).unwrap_or(false) {
            return;
        }
        let mut guard = self.server.lock().await;
        if self.running_count() > 0 || !self.pending.lock().map(|p| p.is_empty()).unwrap_or(false) {
            return;
        }
        if let Some(mut h) = guard.take() {
            if let Some(kill) = h.kill_tx.take() {
                let _ = kill.send(());
            }
        }
    }

    pub async fn login(&self) -> Result<String, CodexError> {
        if let Ok(mut cache) = self.cached_account.lock() {
            *cache = None;
        }
        self.initialize().await?;
        let res = self
            .request(
                "account/login/start",
                serde_json::json!({ "type": "chatgpt", "useHostedLoginSuccessPage": true }),
                30_000,
            )
            .await?;
        res.get("authUrl")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(String::from)
            .ok_or_else(|| CodexError::new("AUTH_REQUIRED", "codex app-server did not return a login URL."))
    }

    pub async fn wait_for_account(&self) -> Result<CodexAccount, CodexError> {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(180);
        loop {
            if let Some(acc) = self.account().await? {
                return Ok(acc);
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(CodexError::new(
                    "AUTH_REQUIRED",
                    "The sign-in did not complete within three minutes. Finish it in the browser and try again.",
                ));
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    }

    async fn thread_for(&self, opts: &TurnOptions) -> Result<String, CodexError> {
        let tools_val: Vec<serde_json::Value> = opts
            .dynamic_tools
            .iter()
            .map(|t| {
                serde_json::json!({
                    "type": "function",
                    "name": t.name,
                    "description": t.description,
                    "inputSchema": t.input_schema,
                })
            })
            .collect();

        let mut common = serde_json::json!({
            "approvalPolicy": "never",
            "approvalsReviewer": "user",
            "cwd": opts.cwd.to_string_lossy(),
            "sandboxPolicy": { "type": "readOnly" },
            "dynamicTools": tools_val,
        });
        if let Some(ref m) = opts.model {
            if !m.is_empty() {
                common["model"] = serde_json::Value::String(m.clone());
            }
        }

        if let Some(ref tid) = opts.thread_id {
            let mut resume_params = common.clone();
            resume_params["threadId"] = serde_json::Value::String(tid.clone());
            if let Ok(resumed) = self.request("thread/resume", resume_params, 120_000).await {
                if let Some(id) = resumed.get("thread").and_then(|t| t.get("id")).and_then(|v| v.as_str()) {
                    if !id.is_empty() {
                        return Ok(id.to_string());
                    }
                }
            }
        }

        let mut start_params = common;
        start_params["serviceName"] = serde_json::Value::String("quire".into());
        let started = self.request("thread/start", start_params, 120_000).await?;
        started
            .get("thread")
            .and_then(|t| t.get("id"))
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(String::from)
            .ok_or_else(|| CodexError::new("TURN_FAILED", "codex app-server started a thread without an id."))
    }

    pub async fn run_turn(self: &Arc<Self>, opts: TurnOptions) -> Result<TurnOutcome, CodexError> {
        if let Some(ref tid) = opts.thread_id {
            if self.turns.lock().unwrap().contains_key(tid) {
                return Err(CodexError::new("TURN_RUNNING", THREAD_BUSY));
            }
        }
        if self.account().await?.is_none() {
            return Err(CodexError::new("AUTH_REQUIRED", "Sign in to ChatGPT to use the agent."));
        }
        let thread_id = self.thread_for(&opts).await?;
        let (done_tx, done_rx) = oneshot::channel();

        let turn_state = Arc::new(Mutex::new(TurnState {
            turn_id: None,
            closed: false,
            interrupt_requested: false,
            final_text: String::new(),
            early_events: Vec::new(),
            on_tool_call: opts.on_tool_call,
            on_started: opts.on_started,
            on_delta: opts.on_delta,
            on_tool: opts.on_tool,
            done_tx: Some(done_tx),
        }));

        {
            let mut turns = self.turns.lock().unwrap();
            if turns.contains_key(&thread_id) {
                return Err(CodexError::new("TURN_RUNNING", THREAD_BUSY));
            }
            turns.insert(thread_id.clone(), turn_state.clone());
        }

        let mut start_params = serde_json::json!({
            "threadId": thread_id,
            "cwd": opts.cwd.to_string_lossy(),
            "approvalPolicy": "never",
            "approvalsReviewer": "user",
            "sandboxPolicy": { "type": "readOnly" },
            "input": [{ "type": "text", "text": opts.prompt }],
        });
        if let Some(ref m) = opts.model {
            if !m.is_empty() {
                start_params["model"] = serde_json::Value::String(m.clone());
            }
        }
        if let Some(ref eff) = opts.effort {
            if !eff.is_empty() {
                start_params["effort"] = serde_json::Value::String(eff.clone());
            }
        }

        match self.request("turn/start", start_params, 120_000).await {
            Ok(res) => {
                let Some(turn_id) = res
                    .get("turn")
                    .and_then(|t| t.get("id"))
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .map(String::from)
                else {
                    fail_turn(&self.turns, &thread_id, CodexError::new("TURN_FAILED", "codex app-server started a turn without an id."));
                    return done_rx.await.unwrap_or_else(|_| Err(CodexError::new("TURN_FAILED", "Turn closed.")));
                };

                let maybe_ready = {
                    let mut st = turn_state.lock().unwrap();
                    if st.closed {
                        None
                    } else {
                        st.turn_id = Some(turn_id.clone());
                        (st.on_started)(thread_id.clone(), turn_id.clone());
                        let early = std::mem::take(&mut st.early_events);
                        let intr = st.interrupt_requested;
                        Some((early, intr))
                    }
                };
                let Some((early, do_interrupt)) = maybe_ready else {
                    return done_rx.await.unwrap_or_else(|_| Err(CodexError::new("TURN_FAILED", "Turn closed.")));
                };

                if do_interrupt {
                    let _ = self.interrupt(&thread_id).await;
                }

                if let Some(ref h) = *self.server.lock().await {
                    for ev in early {
                        dispatch_turn_message(&ev, &h.stdin_tx, &self.turns, self);
                    }
                }
            }
            Err(err) => {
                fail_turn(&self.turns, &thread_id, err);
                return done_rx.await.unwrap_or_else(|_| Err(CodexError::new("TURN_FAILED", "Turn closed.")));
            }
        }

        let client_ref = self.clone();
        let tid_timeout = thread_id.clone();
        let timeout_handle = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(600)).await;
            let _ = client_ref.interrupt(&tid_timeout).await;
            fail_turn(
                &client_ref.turns,
                &tid_timeout,
                CodexError::new("TURN_TIMEOUT", "The agent did not finish within 10 minutes and was stopped."),
            );
        });

        let outcome = done_rx
            .await
            .unwrap_or_else(|_| Err(CodexError::new("TURN_FAILED", "Turn channel closed.")));
        timeout_handle.abort();

        let idle_client = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(30)).await;
            idle_client.stop_if_idle().await;
        });

        outcome
    }

    pub async fn interrupt(&self, thread_id: &str) -> Result<(), CodexError> {
        let turn_id_opt = {
            let turns = self.turns.lock().unwrap();
            let Some(st_arc) = turns.get(thread_id) else {
                return Ok(());
            };
            let mut st = st_arc.lock().unwrap();
            if st.closed {
                return Ok(());
            }
            if st.turn_id.is_none() {
                st.interrupt_requested = true;
                None
            } else {
                st.turn_id.clone()
            }
        };
        if let Some(turn_id) = turn_id_opt {
            let _ = self
                .request(
                    "turn/interrupt",
                    serde_json::json!({ "threadId": thread_id, "turnId": turn_id }),
                    10_000,
                )
                .await;
        }
        Ok(())
    }

    pub fn stop(&self) {
        if let Ok(mut v) = self.cached_version.lock() {
            *v = None;
        }
        if let Ok(mut a) = self.cached_account.lock() {
            *a = None;
        }
        if let Ok(mut guard) = self.server.try_lock() {
            if let Some(mut h) = guard.take() {
                if let Some(kill) = h.kill_tx.take() {
                    let _ = kill.send(());
                }
            }
        }
        fail_all_pending(
            &self.pending,
            &self.turns,
            CodexError::new("APP_SERVER_EXITED", "codex app-server was stopped."),
        );
    }
}

fn fail_all_pending(
    pending: &Mutex<HashMap<u64, oneshot::Sender<Result<serde_json::Value, CodexError>>>>,
    turns: &Mutex<HashMap<String, Arc<Mutex<TurnState>>>>,
    err: CodexError,
) {
    if let Ok(mut map) = pending.lock() {
        for (_, tx) in map.drain() {
            let _ = tx.send(Err(err.clone()));
        }
    }
    let drained: Vec<Arc<Mutex<TurnState>>> = turns
        .lock()
        .map(|mut m| m.drain().map(|(_, v)| v).collect())
        .unwrap_or_default();
    for st_arc in drained {
        if let Ok(mut st) = st_arc.lock() {
            st.closed = true;
            if let Some(tx) = st.done_tx.take() {
                let _ = tx.send(Err(err.clone()));
            }
        }
    }
}

fn fail_turn(
    turns: &Mutex<HashMap<String, Arc<Mutex<TurnState>>>>,
    thread_id: &str,
    err: CodexError,
) {
    let removed = turns.lock().ok().and_then(|mut m| m.remove(thread_id));
    if let Some(st_arc) = removed {
        if let Ok(mut st) = st_arc.lock() {
            st.closed = true;
            if let Some(tx) = st.done_tx.take() {
                let _ = tx.send(Err(err));
            }
        }
    }
}

fn reply_to_tool(stdin_tx: &mpsc::UnboundedSender<String>, id: &serde_json::Value, success: bool, text: &str) {
    let msg = serde_json::json!({
        "id": id,
        "result": {
            "contentItems": [{ "type": "inputText", "text": text }],
            "success": success,
        }
    });
    let _ = stdin_tx.send(format!("{msg}\n"));
}

fn handle_server_line(
    line: &str,
    stdin_tx: &mpsc::UnboundedSender<String>,
    pending: &Arc<Mutex<HashMap<u64, oneshot::Sender<Result<serde_json::Value, CodexError>>>>>,
    turns: &Arc<Mutex<HashMap<String, Arc<Mutex<TurnState>>>>>,
) {
    let Ok(msg) = serde_json::from_str::<serde_json::Value>(line) else {
        return;
    };
    let Some(obj) = msg.as_object() else {
        return;
    };

    if let Some(id_num) = obj.get("id").and_then(|v| v.as_u64()) {
        if !obj.contains_key("method") {
            let sender = pending.lock().ok().and_then(|mut m| m.remove(&id_num));
            if let Some(tx) = sender {
                if let Some(err_obj) = obj.get("error").and_then(|e| e.as_object()) {
                    let message = err_obj
                        .get("message")
                        .and_then(|m| m.as_str())
                        .unwrap_or("codex app-server rejected the request.");
                    let _ = tx.send(Err(CodexError::new("APP_SERVER_REQUEST_FAILED", message)));
                } else {
                    let result = obj.get("result").cloned().unwrap_or(serde_json::Value::Null);
                    let _ = tx.send(Ok(result));
                }
            }
            return;
        }
    }

    let Some(method) = obj.get("method").and_then(|v| v.as_str()) else {
        return;
    };

    if let Some(req_id) = obj.get("id") {
        if method == "item/tool/call" {
            dispatch_tool_call(&msg, stdin_tx, turns);
            return;
        }
        if method.contains("requestApproval") {
            let reply = serde_json::json!({ "id": req_id, "result": { "decision": "decline" } });
            let _ = stdin_tx.send(format!("{reply}\n"));
            return;
        }
        if method.contains("requestUserInput") {
            let reply = serde_json::json!({ "id": req_id, "result": { "answers": {} } });
            let _ = stdin_tx.send(format!("{reply}\n"));
            return;
        }
        let reply = serde_json::json!({
            "id": req_id,
            "error": { "code": -32601, "message": "Quire does not implement this request." }
        });
        let _ = stdin_tx.send(format!("{reply}\n"));
        return;
    }

    dispatch_notification(&msg, turns);
}

fn dispatch_turn_message(
    msg: &serde_json::Value,
    stdin_tx: &mpsc::UnboundedSender<String>,
    turns: &Arc<Mutex<HashMap<String, Arc<Mutex<TurnState>>>>>,
    _client: &CodexClient,
) {
    if msg.get("method").and_then(|v| v.as_str()) == Some("item/tool/call") {
        dispatch_tool_call(msg, stdin_tx, turns);
    } else {
        dispatch_notification(msg, turns);
    }
}

fn dispatch_tool_call(
    msg: &serde_json::Value,
    stdin_tx: &mpsc::UnboundedSender<String>,
    turns: &Arc<Mutex<HashMap<String, Arc<Mutex<TurnState>>>>>,
) {
    let req_id = msg.get("id").cloned().unwrap_or(serde_json::Value::Null);
    let params = msg.get("params").and_then(|p| p.as_object());
    let thread_id = params.and_then(|p| p.get("threadId")).and_then(|v| v.as_str()).unwrap_or("");
    let turn_id = params.and_then(|p| p.get("turnId")).and_then(|v| v.as_str()).unwrap_or("");

    let Some(st_arc) = turns.lock().ok().and_then(|m| m.get(thread_id).cloned()) else {
        reply_to_tool(stdin_tx, &req_id, false, "No turn is running on that thread; the tool call was ignored.");
        return;
    };

    let handler = {
        let mut st = st_arc.lock().unwrap();
        if st.closed || turn_id.is_empty() {
            reply_to_tool(stdin_tx, &req_id, false, "The tool call does not belong to the running turn.");
            return;
        }
        let Some(ref active_turn) = st.turn_id else {
            st.early_events.push(msg.clone());
            return;
        };
        if active_turn != turn_id {
            reply_to_tool(stdin_tx, &req_id, false, "The tool call belongs to another turn.");
            return;
        }
        let tool_name = params.and_then(|p| p.get("tool")).and_then(|v| v.as_str()).unwrap_or("").to_string();
        (st.on_tool)(ToolProgress {
            tool: tool_name,
            status: "running".into(),
            summary: None,
        });
        st.on_tool_call.clone()
    };

    let call = ToolCall {
        tool: params.and_then(|p| p.get("tool")).and_then(|v| v.as_str()).unwrap_or("").to_string(),
        arguments: params.and_then(|p| p.get("arguments")).cloned().unwrap_or(serde_json::Value::Null),
        call_id: params.and_then(|p| p.get("callId")).and_then(|v| v.as_str()).unwrap_or("").to_string(),
    };
    let stdin_clone = stdin_tx.clone();
    let turns_clone = turns.clone();
    let tid_owned = thread_id.to_string();
    let active_turn_owned = turn_id.to_string();

    tokio::spawn(async move {
        let tool_name = call.tool.clone();
        let reply = handler(call).await;
        reply_to_tool(&stdin_clone, &req_id, reply.success, &reply.text);
        if let Ok(st) = st_arc.lock() {
            if !st.closed {
                (st.on_tool)(ToolProgress {
                    tool: tool_name,
                    status: if reply.success { "done".into() } else { "failed".into() },
                    summary: reply.summary,
                });
            }
        }
        if let Some(stop_reason) = reply.stop_turn {
            let intr = serde_json::json!({
                "id": 999_999_999u64,
                "method": "turn/interrupt",
                "params": { "threadId": tid_owned, "turnId": active_turn_owned }
            });
            let _ = stdin_clone.send(format!("{intr}\n"));
            fail_turn(&turns_clone, &tid_owned, CodexError::new("TURN_FAILED", stop_reason));
        }
    });
}

fn dispatch_notification(
    msg: &serde_json::Value,
    turns: &Arc<Mutex<HashMap<String, Arc<Mutex<TurnState>>>>>,
) {
    let method = msg.get("method").and_then(|v| v.as_str()).unwrap_or("");
    if !matches!(method, "item/agentMessage/delta" | "item/completed" | "turn/completed") {
        return;
    }
    let Some(params) = msg.get("params").and_then(|p| p.as_object()) else {
        return;
    };
    let Some(thread_id) = params.get("threadId").and_then(|v| v.as_str()) else {
        return;
    };
    let turn_obj = params.get("turn").and_then(|t| t.as_object());
    let turn_id = if method == "turn/completed" {
        turn_obj.and_then(|t| t.get("id")).and_then(|v| v.as_str())
    } else {
        params.get("turnId").and_then(|v| v.as_str())
    };
    let Some(turn_id) = turn_id else {
        return;
    };

    let Some(st_arc) = turns.lock().ok().and_then(|m| m.get(thread_id).cloned()) else {
        return;
    };

    let mut finish_outcome: Option<Result<TurnOutcome, CodexError>> = None;
    {
        let mut st = st_arc.lock().unwrap();
        if st.closed {
            return;
        }
        let Some(ref active_turn) = st.turn_id else {
            st.early_events.push(msg.clone());
            return;
        };
        if active_turn != turn_id {
            return;
        }
        if method == "item/agentMessage/delta" {
            if let Some(delta) = params.get("delta").and_then(|v| v.as_str()) {
                (st.on_delta)(delta.to_string());
            }
        } else if method == "item/completed" {
            if let Some(item) = params.get("item").and_then(|i| i.as_object()) {
                if item.get("type").and_then(|v| v.as_str()) == Some("agentMessage") {
                    if let Some(txt) = item.get("text").and_then(|v| v.as_str()) {
                        st.final_text = txt.to_string();
                    }
                }
            }
        } else if method == "turn/completed" {
            st.closed = true;
            let status = turn_obj.and_then(|t| t.get("status")).and_then(|v| v.as_str()).unwrap_or("unknown");
            finish_outcome = Some(match status {
                "completed" => Ok(TurnOutcome {
                    thread_id: thread_id.to_string(),
                    turn_id: turn_id.to_string(),
                    text: if st.final_text.is_empty() {
                        "The agent completed without a text response.".into()
                    } else {
                        st.final_text.clone()
                    },
                }),
                "interrupted" => Err(CodexError::new("TURN_INTERRUPTED", "The agent was interrupted.")),
                _ => {
                    let detail = turn_obj
                        .and_then(|t| t.get("error"))
                        .and_then(|e| e.get("message"))
                        .and_then(|v| v.as_str())
                        .map(String::from)
                        .unwrap_or_else(|| format!("The agent's turn ended with status {status}."));
                    Err(CodexError::new("TURN_FAILED", detail))
                }
            });
        }
    }

    if let Some(outcome) = finish_outcome {
        let _ = turns.lock().map(|mut m| m.remove(thread_id));
        if let Ok(mut st) = st_arc.lock() {
            if let Some(tx) = st.done_tx.take() {
                let _ = tx.send(outcome);
            }
        }
    }
}
