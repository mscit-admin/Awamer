// =====================================================================
// Phase 3 — SSH client commands (1.2.0: password auth only)
// =====================================================================
//
// Architecture:
//
//   Renderer ──invoke('ssh_connect', {hostId, password})──► this module
//                                                          │
//                                                          ▼
//                                                  russh::client::connect
//                                                          │
//                              ┌───────────────────────────┼──────────┐
//                              ▼                           ▼          ▼
//                       ssh:output:{sid}            session map    auth
//                       event stream                in State<>     ok?
//                              │
//                              ▼
//                       xterm.js in React
//
// One SSH connection per session_id. Output is streamed to the renderer
// via Tauri events; input flows back via ssh_write. Resize and disconnect
// are explicit IPC calls.
//
// Phase 3 limitations (deliberately):
// - Password authentication only. Keys/agent in 1.3.0.
// - No host key verification. Phase 3.x will add known_hosts handling.
// - Single channel per session (the shell). SFTP is Phase 4.
// =====================================================================

use std::collections::HashMap;
use std::sync::Arc;

use once_cell::sync::Lazy;
use russh::client::{self, Config, Handle, Handler, Msg};
use russh::keys::PublicKeyOrCertificate;
use russh::{ChannelMsg, Disconnect};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncWriteExt;
use tokio::sync::{mpsc, Mutex};
use uuid::Uuid;

use crate::errors::AppError;

// ---------------------------------------------------------------------
// Per-session state
// ---------------------------------------------------------------------

/// One live SSH connection. The struct holds:
/// - `handle`: the russh client handle used to send packets
/// - `cmd_tx`: a channel of write/resize commands the I/O task consumes
///
/// The shell channel, host id and history id are owned by the spawned I/O
/// task, not this registry entry.
struct SshSession {
    handle: Handle<ClientHandler>,
    cmd_tx: mpsc::UnboundedSender<SessionCommand>,
}

enum SessionCommand {
    Write(Vec<u8>),
    Resize { cols: u32, rows: u32 },
}

/// Internal: chosen authentication method for a single connect attempt.
enum AuthMethod {
    Password(String),
    PrivateKey { pem: String, passphrase: Option<String> },
    /// SSH agent — talks to $SSH_AUTH_SOCK and tries each identity.
    /// Added in 1.4.0.
    SshAgent,
}

/// Process-wide session registry. We use a single global because the
/// Tauri state API requires `Send + Sync + 'static` and the russh handle
/// types embed lifetimes that make passing them through `State<>` awkward.
static SESSIONS: Lazy<Mutex<HashMap<String, SshSession>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

// ---------------------------------------------------------------------
// russh client handler
// ---------------------------------------------------------------------
//
// The handler is called by russh after the server presents its host key.
// In 1.3.0 we consult `known_hosts`:
//   - First seen → save and accept
//   - Match     → accept silently
//   - Mismatch  → REJECT (return Ok(false))
//
// The mismatch case must propagate a structured signal so the caller can
// render the dedicated "host key changed" screen. We do that via a shared
// `Mutex<Option<HostKeyChangedDetails>>` that ssh_connect inspects after
// the handler runs.

use std::sync::Mutex as StdMutex;

#[derive(Clone, Debug, Serialize)]
pub struct HostKeyChangedDetails {
    pub host: String,
    pub port: u16,
    pub stored_fingerprint: String,
    pub presented_fingerprint: String,
}

pub(crate) static LAST_HOST_KEY_CHANGE: Lazy<StdMutex<Option<HostKeyChangedDetails>>> =
    Lazy::new(|| StdMutex::new(None));

#[derive(Clone)]
pub(crate) struct ClientHandler {
    pub(crate) host: String,
    pub(crate) port: u16,
}

impl Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        presented: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        use crate::commands::known_hosts::{self, VerifyOutcome};
        let server_public_key = &crate::commands::ssh_auth::presented_host_key(presented);

        // Obtain (or initialise) the global store.
        let store_arc = known_hosts::STORE.clone();
        let mut guard = store_arc.lock().await;
        if guard.is_none() {
            match known_hosts::KnownHostsStore::load() {
                Ok(s) => *guard = Some(s),
                Err(e) => {
                    tracing::warn!(?e, "could not load known_hosts; rejecting connection for safety");
                    return Ok(false);
                }
            }
        }
        let store = guard.as_mut().unwrap();

        // Same encoding the store uses (SSH wire-format → base64).
        let presented_b64 = crate::commands::ssh_auth::public_key_base64(server_public_key);
        let presented_fp = known_hosts::fingerprint_sha256(&presented_b64);

        match store.verify(&self.host, self.port, server_public_key) {
            VerifyOutcome::FirstSeen => {
                tracing::info!(host = %self.host, port = self.port, fp = %presented_fp,
                    "first connection — pinning host key");
                if let Err(e) = store.add(&self.host, self.port, server_public_key) {
                    tracing::warn!(?e, "failed to save host key; refusing connection");
                    return Ok(false);
                }
                Ok(true)
            }
            VerifyOutcome::Match => {
                tracing::debug!(host = %self.host, "host key matches known_hosts entry");
                Ok(true)
            }
            VerifyOutcome::Mismatch { stored_fingerprint } => {
                tracing::error!(
                    host = %self.host, port = self.port,
                    stored = %stored_fingerprint,
                    presented = %presented_fp,
                    "host key CHANGED — possible MITM, refusing connection"
                );
                *LAST_HOST_KEY_CHANGE.lock().unwrap() = Some(HostKeyChangedDetails {
                    host: self.host.clone(),
                    port: self.port,
                    stored_fingerprint,
                    presented_fingerprint: presented_fp,
                });
                Ok(false)
            }
        }
    }
}

// ---------------------------------------------------------------------
// IPC payload types
// ---------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct SshConnectArgs {
    /// API base URL of the auth-service (e.g. http://localhost:8081).
    pub api_base_url: String,
    /// Bearer token for the authenticated user.
    pub access_token: String,
    /// Host UUID to connect to.
    pub host_id: String,
    /// If the credential is `none` or interactive, the renderer may pass
    /// a password directly. Otherwise we look it up from the credential.
    pub password_override: Option<String>,
    /// Passphrase typed at connect time for encrypted private keys.
    /// Stored in memory only for the duration of this connect call.
    pub passphrase: Option<String>,
    /// Initial terminal size.
    pub cols: u32,
    pub rows: u32,
}

#[derive(Debug, Serialize)]
pub struct SshConnectResult {
    pub session_id: String,
    pub history_id: Option<i64>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(tag = "type")]
pub enum SshEvent {
    /// Stream of bytes from the remote stdout/stderr. Forwarded to xterm.
    #[serde(rename = "data")]
    Data { bytes: Vec<u8> },
    /// Channel closed cleanly with an exit status.
    #[serde(rename = "exit")]
    Exit { code: u32 },
    /// Connection lost or aborted.
    #[serde(rename = "closed")]
    Closed { reason: String },
}

// ---------------------------------------------------------------------
// Public Tauri commands
// ---------------------------------------------------------------------

#[tauri::command]
pub async fn ssh_connect(
    app: AppHandle,
    args: SshConnectArgs,
) -> Result<SshConnectResult, AppError> {
    tracing::info!(host_id = %args.host_id, "ssh_connect requested");

    // 1. Fetch host details from the backend.
    let host = fetch_host(&args.api_base_url, &args.access_token, &args.host_id).await?;
    if host.protocol != "ssh" {
        return Err(AppError::new("invalid_protocol",
            format!("host protocol is {}, expected ssh", host.protocol)));
    }

    // 2. Resolve auth material. Two paths:
    //
    //    (a) password_override is set → password auth, regardless of credential.
    //        Username comes from the linked credential (if any) or "root".
    //
    //    (b) password_override is None → consult the credential:
    //          - credential_type = "password"    → password auth
    //          - credential_type = "private_key" → key auth (NEW in 1.3.0)
    //          - any other type                  → error (not yet supported)
    let username: String;
    let auth_method: AuthMethod;
    if let Some(p) = args.password_override.as_ref() {
        // Renderer provided a password directly. Username comes from the
        // linked credential (if any) or "root".
        let u = match &host.credential_id {
            Some(cid) => fetch_credential(&args.api_base_url, &args.access_token, cid)
                .await?
                .username
                .unwrap_or_else(|| "root".into()),
            None => "root".into(),
        };
        username = u;
        auth_method = AuthMethod::Password(p.clone());
    } else {
        let cred_id = host.credential_id.as_ref().ok_or_else(|| {
            AppError::new("no_credential",
                "host has no credential and no password was provided")
        })?;
        let cred = fetch_credential_with_secret(
            &args.api_base_url, &args.access_token, cred_id).await?;

        username = cred.username.clone().unwrap_or_else(|| "root".into());

        match cred.credential_type.as_str() {
            "password" => {
                let pw = cred.secret_data.as_ref()
                    .and_then(|v| v.get("password"))
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| AppError::new("credential_missing_password",
                        "credential has no 'password' field in secret_data"))?
                    .to_string();
                auth_method = AuthMethod::Password(pw);
            }
            "private_key" => {
                let pem = cred.secret_data.as_ref()
                    .and_then(|v| v.get("private_key"))
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| AppError::new("credential_missing_key",
                        "credential has no 'private_key' field in secret_data"))?
                    .to_string();
                // Passphrase: try (1) connect-time override, (2) credential's
                // own stored passphrase field, (3) None (= unencrypted key).
                let passphrase = args.passphrase.clone()
                    .or_else(|| cred.secret_data.as_ref()
                        .and_then(|v| v.get("passphrase"))
                        .and_then(|v| v.as_str())
                        .map(String::from));
                auth_method = AuthMethod::PrivateKey { pem, passphrase };
            }
            "ssh_agent" | "agent" => {
                // 1.4.0 — credentials of type ssh_agent carry no secret;
                // the local agent (via $SSH_AUTH_SOCK) provides identities.
                auth_method = AuthMethod::SshAgent;
            }
            other => {
                return Err(AppError::new("unsupported_credential_type",
                    format!("credential type '{other}' not supported (1.4.0: password, private_key, ssh_agent)")));
            }
        }
    }

    // 3. Connect (with the host-aware handler for TOFU).
    let config = Arc::new(Config {
        inactivity_timeout: Some(std::time::Duration::from_secs(3600)),
        ..Default::default()
    });
    let handler = ClientHandler {
        host: host.hostname.clone(),
        port: host.port as u16,
    };

    // Clear any prior host-key-change record so we don't pick up a stale one.
    *LAST_HOST_KEY_CHANGE.lock().unwrap() = None;

    let mut handle = match client::connect(config, (host.hostname.as_str(), host.port as u16), handler).await {
        Ok(h) => h,
        Err(e) => {
            // Check whether our handler rejected on host-key mismatch.
            if let Some(details) = LAST_HOST_KEY_CHANGE.lock().unwrap().clone() {
                return Err(AppError::new("host_key_changed",
                    serde_json::to_string(&details).unwrap_or_default()));
            }
            return Err(AppError::new("ssh_connect_failed", format!("connect: {e}")));
        }
    };

    // 4. Authenticate using the resolved method.
    let auth_ok = match &auth_method {
        AuthMethod::Password(pw) => {
            crate::commands::ssh_auth::authenticate_with_password(&mut handle, &username, pw).await
                .map_err(|e| AppError::new("ssh_auth_failed", format!("authenticate: {e}")))?
        }
        AuthMethod::PrivateKey { pem, passphrase } => {
            // Distinguishes passphrase-required / wrong-passphrase / invalid key.
            let key = crate::commands::ssh_auth::decode_private_key(pem, passphrase.as_deref())?;
            crate::commands::ssh_auth::authenticate_with_key(&mut handle, &username, key).await
                .map_err(|e| AppError::new("ssh_auth_failed", format!("authenticate: {e}")))?
        }
        AuthMethod::SshAgent => {
            // 1.4.0 — connect to the local ssh-agent and try each identity
            // it offers. The first one the server accepts wins.
            let sock = std::env::var("SSH_AUTH_SOCK").map_err(|_| {
                AppError::new("ssh_agent_unavailable",
                    "SSH_AUTH_SOCK is not set — no ssh-agent in the environment")
            })?;
            crate::commands::ssh_auth::authenticate_with_agent(&mut handle, &username, &sock).await?
        }
    };
    if !auth_ok {
        let reason = match &auth_method {
            AuthMethod::Password(_) => "server rejected password",
            AuthMethod::PrivateKey { .. } => "server rejected public key",
            AuthMethod::SshAgent => "server rejected all agent identities",
        };
        return Err(AppError::new("ssh_auth_rejected", reason));
    }

    // 4. Open a shell channel.
    let channel = handle
        .channel_open_session()
        .await
        .map_err(|e| AppError::new("ssh_channel_failed", format!("open channel: {e}")))?;
    channel
        .request_pty(
            true,
            "xterm-256color",
            args.cols, args.rows, 0, 0,
            &[],
        )
        .await
        .map_err(|e| AppError::new("ssh_pty_failed", format!("pty: {e}")))?;
    channel
        .request_shell(true)
        .await
        .map_err(|e| AppError::new("ssh_shell_failed", format!("shell: {e}")))?;

    let session_id = Uuid::new_v4().to_string();

    // 5. Tell the backend a connection has started, so it shows up in history.
    let history_id = start_history(&args.api_base_url, &args.access_token, &args.host_id)
        .await
        .ok();

    // 6. Spawn the I/O task that owns the channel for its lifetime.
    let (cmd_tx, cmd_rx) = mpsc::unbounded_channel::<SessionCommand>();
    let event_channel = format!("ssh:event:{}", session_id);
    spawn_session_task(
        app.clone(),
        session_id.clone(),
        host.id.clone(),
        history_id,
        args.api_base_url.clone(),
        args.access_token.clone(),
        channel,
        cmd_rx,
        event_channel,
    );

    SESSIONS.lock().await.insert(session_id.clone(), SshSession {
        handle,
        cmd_tx,
    });

    // 7. Touch the host so it shows up as recently-used.
    let _ = touch_host(&args.api_base_url, &args.access_token, &args.host_id).await;

    tracing::info!(session_id = %session_id, "ssh session established");
    Ok(SshConnectResult { session_id, history_id })
}

#[tauri::command]
pub async fn ssh_write(session_id: String, data: Vec<u8>) -> Result<(), AppError> {
    let map = SESSIONS.lock().await;
    let sess = map.get(&session_id).ok_or_else(|| {
        AppError::new("session_not_found", format!("no SSH session {session_id}"))
    })?;
    sess.cmd_tx
        .send(SessionCommand::Write(data))
        .map_err(|_| AppError::new("session_dead", "session writer is gone"))?;
    Ok(())
}

#[tauri::command]
pub async fn ssh_resize(session_id: String, cols: u32, rows: u32) -> Result<(), AppError> {
    let map = SESSIONS.lock().await;
    let sess = map.get(&session_id).ok_or_else(|| {
        AppError::new("session_not_found", format!("no SSH session {session_id}"))
    })?;
    sess.cmd_tx
        .send(SessionCommand::Resize { cols, rows })
        .map_err(|_| AppError::new("session_dead", "session writer is gone"))?;
    Ok(())
}

#[tauri::command]
pub async fn ssh_disconnect(session_id: String) -> Result<(), AppError> {
    let mut map = SESSIONS.lock().await;
    if let Some(sess) = map.remove(&session_id) {
        // Best-effort: signal close. The session task will see the channel close
        // and emit its own "closed" event.
        let _ = sess.handle.disconnect(Disconnect::ByApplication, "client disconnect", "").await;
    }
    Ok(())
}

// ---------------------------------------------------------------------
// Known-hosts IPC commands (Phase 3b)
// ---------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct KnownHostFingerprint {
    pub host: String,
    pub port: u16,
    pub algorithm: String,
    pub fingerprint: String,
}

#[tauri::command]
pub async fn ssh_get_known_host(host: String, port: u16) -> Result<Option<String>, AppError> {
    use crate::commands::known_hosts;
    let store_arc = known_hosts::STORE.clone();
    let mut guard = store_arc.lock().await;
    if guard.is_none() {
        *guard = Some(known_hosts::KnownHostsStore::load()?);
    }
    let store = guard.as_ref().unwrap();
    Ok(store.fingerprint(&host, port))
}

#[tauri::command]
pub async fn ssh_forget_known_host(host: String, port: u16) -> Result<usize, AppError> {
    use crate::commands::known_hosts;
    let store_arc = known_hosts::STORE.clone();
    let mut guard = store_arc.lock().await;
    if guard.is_none() {
        *guard = Some(known_hosts::KnownHostsStore::load()?);
    }
    let store = guard.as_mut().unwrap();
    store.forget(&host, port)
}

#[tauri::command]
pub async fn ssh_list_known_hosts() -> Result<Vec<KnownHostFingerprint>, AppError> {
    use crate::commands::known_hosts;
    let store_arc = known_hosts::STORE.clone();
    let mut guard = store_arc.lock().await;
    if guard.is_none() {
        *guard = Some(known_hosts::KnownHostsStore::load()?);
    }
    let store = guard.as_ref().unwrap();
    let entries = store.list();
    Ok(entries.into_iter().map(|(label, algo, fp)| {
        // Parse label back to (host, port).
        let (host, port) = parse_label(&label);
        KnownHostFingerprint { host, port, algorithm: algo, fingerprint: fp }
    }).collect())
}

fn parse_label(label: &str) -> (String, u16) {
    // `[host]:port` or plain host (port 22 implied).
    if let Some(rest) = label.strip_prefix('[') {
        if let Some((host, port_part)) = rest.split_once("]:") {
            let port = port_part.parse().unwrap_or(22);
            return (host.to_string(), port);
        }
    }
    (label.to_string(), 22)
}

// ---------------------------------------------------------------------
// I/O task
// ---------------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
fn spawn_session_task(
    app: AppHandle,
    session_id: String,
    _host_id: String,
    history_id: Option<i64>,
    api_base_url: String,
    access_token: String,
    mut channel: russh::Channel<Msg>,
    mut cmd_rx: mpsc::UnboundedReceiver<SessionCommand>,
    event_channel: String,
) {
    tokio::spawn(async move {
        let emit = |evt: SshEvent| {
            if let Err(e) = app.emit(&event_channel, evt) {
                tracing::warn!(?e, "failed to emit ssh event");
            }
        };

        // make_writer() returns a type that impls tokio::io::AsyncWrite,
        // which is how russh 0.45 expects data to be pushed into the channel.
        let mut writer = channel.make_writer();

        let mut exit_status: Option<u32> = None;
        let mut error_message: Option<String> = None;

        loop {
            tokio::select! {
                // Commands from the renderer
                cmd = cmd_rx.recv() => {
                    match cmd {
                        Some(SessionCommand::Write(bytes)) => {
                            if let Err(e) = writer.write_all(&bytes).await {
                                tracing::warn!(?e, "write_all failed");
                                error_message = Some(format!("write error: {e}"));
                                break;
                            }
                            if let Err(e) = writer.flush().await {
                                tracing::warn!(?e, "flush failed");
                            }
                        }
                        Some(SessionCommand::Resize { cols, rows }) => {
                            if let Err(e) = channel.window_change(cols, rows, 0, 0).await {
                                tracing::warn!(?e, "window_change failed");
                            }
                        }
                        None => {
                            tracing::debug!("cmd channel closed; ending session task");
                            break;
                        }
                    }
                }
                // Bytes from the server
                msg = channel.wait() => {
                    match msg {
                        Some(ChannelMsg::Data { data }) => {
                            emit(SshEvent::Data { bytes: data.to_vec() });
                        }
                        Some(ChannelMsg::ExtendedData { data, .. }) => {
                            // stderr — render inline like a real terminal does.
                            emit(SshEvent::Data { bytes: data.to_vec() });
                        }
                        Some(ChannelMsg::ExitStatus { exit_status: code }) => {
                            exit_status = Some(code);
                        }
                        Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) => {
                            tracing::debug!("channel closed by server");
                            break;
                        }
                        Some(_) => { /* ignore other variants */ }
                        None => break,
                    }
                }
            }
        }

        // Emit terminal status to the renderer
        if let Some(code) = exit_status {
            emit(SshEvent::Exit { code });
        }
        emit(SshEvent::Closed {
            reason: error_message.clone().unwrap_or_else(|| "session ended".into()),
        });

        // Tell the backend the connection ended
        if let Some(hid) = history_id {
            let status = if error_message.is_some() { "failed" } else { "closed" };
            let _ = end_history(&api_base_url, &access_token, hid, status, error_message.as_deref()).await;
        }

        // Remove from registry
        SESSIONS.lock().await.remove(&session_id);
        tracing::info!(session_id = %session_id, "ssh session task finished");
    });
}

// ---------------------------------------------------------------------
// Backend API helpers (reqwest, rustls)
// ---------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub(crate) struct HostJson {
    pub(crate) id: String,
    pub(crate) hostname: String,
    pub(crate) port: i64,
    pub(crate) protocol: String,
    pub(crate) credential_id: Option<String>,
    #[serde(default)]
    pub(crate) name: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct CredentialJson {
    #[serde(rename = "credentialType")]
    pub(crate) credential_type: String,
    pub(crate) username: Option<String>,
    #[serde(default)]
    pub(crate) secret_data: Option<serde_json::Value>,
}

pub(crate) async fn fetch_host(base: &str, token: &str, id: &str) -> Result<HostJson, AppError> {
    http_get_json(&format!("{base}/api/v1/hosts/{id}"), token).await
}

pub(crate) async fn fetch_credential(base: &str, token: &str, id: &str) -> Result<CredentialJson, AppError> {
    http_get_json(&format!("{base}/api/v1/credentials/{id}"), token).await
}

pub(crate) async fn fetch_credential_with_secret(base: &str, token: &str, id: &str) -> Result<CredentialJson, AppError> {
    http_get_json(&format!("{base}/api/v1/credentials/{id}?reveal=true"), token).await
}

async fn start_history(base: &str, token: &str, host_id: &str) -> Result<i64, AppError> {
    #[derive(Deserialize)] struct Resp { id: i64 }
    let body = serde_json::json!({ "host_id": host_id }).to_string();
    let resp: Resp = http_post_json(&format!("{base}/api/v1/history/start"), token, &body).await?;
    Ok(resp.id)
}

async fn end_history(base: &str, token: &str, id: i64, status: &str, err: Option<&str>) -> Result<(), AppError> {
    let body = serde_json::json!({ "status": status, "error_message": err }).to_string();
    http_post_no_response(&format!("{base}/api/v1/history/{id}/end"), token, &body).await
}

async fn touch_host(base: &str, token: &str, id: &str) -> Result<(), AppError> {
    http_post_no_response(&format!("{base}/api/v1/hosts/{id}/touch"), token, "").await
}

// Minimal JSON GET/POST helpers over reqwest (rustls TLS).

async fn http_get_json<T: serde::de::DeserializeOwned>(url: &str, token: &str) -> Result<T, AppError> {
    let client = reqwest::Client::new();
    let resp = client.get(url)
        .header("Authorization", format!("Bearer {token}"))
        .send().await.map_err(|e| AppError::new("http_error", format!("GET {url}: {e}")))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(AppError::new("http_status", format!("GET {url} → {status}: {body}")));
    }
    resp.json::<T>().await.map_err(|e| AppError::new("json_parse", format!("{url}: {e}")))
}

async fn http_post_json<T: serde::de::DeserializeOwned>(url: &str, token: &str, body: &str) -> Result<T, AppError> {
    let client = reqwest::Client::new();
    let resp = client.post(url)
        .header("Authorization", format!("Bearer {token}"))
        .header("Content-Type", "application/json")
        .body(body.to_string())
        .send().await.map_err(|e| AppError::new("http_error", format!("POST {url}: {e}")))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(AppError::new("http_status", format!("POST {url} → {status}: {body}")));
    }
    resp.json::<T>().await.map_err(|e| AppError::new("json_parse", format!("{url}: {e}")))
}

async fn http_post_no_response(url: &str, token: &str, body: &str) -> Result<(), AppError> {
    let client = reqwest::Client::new();
    let resp = client.post(url)
        .header("Authorization", format!("Bearer {token}"))
        .header("Content-Type", "application/json")
        .body(body.to_string())
        .send().await.map_err(|e| AppError::new("http_error", format!("POST {url}: {e}")))?;
    if !resp.status().is_success() {
        let status = resp.status();
        return Err(AppError::new("http_status", format!("POST {url} → {status}")));
    }
    Ok(())
}
