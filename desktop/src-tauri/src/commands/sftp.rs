// =====================================================================
// Phase 4 (1.5.0) — SFTP file browser
// =====================================================================
//
// Architecture:
//   - sftp_connect opens an SSH connection (reusing the same auth path
//     as ssh.rs), then requests an "sftp" subsystem channel on it.
//   - sftp_list, sftp_download issue protocol commands against that
//     channel and stream results back to the renderer.
//
// Why a separate module rather than reusing ssh.rs's SshSession:
//   - SFTP and the shell channel are independent — same SSH conn,
//     different channels. Keeping them separate avoids cross-contamination.
//   - SFTP doesn't need PTY/resize/window-change logic.
//   - The renderer treats SFTP sessions and terminal sessions as
//     distinct entities anyway (different UI, different mental model).
//
// Limitations in 1.5.0 (deliberate scope cut):
//   - Read-only browsing. No upload, no edit, no rename, no delete.
//   - Single file download. No recursive folder download.
//   - No drag-drop. The user picks a save location via a system dialog.
//   - No progress for tiny files (we still emit start + done events
//     for consistency, just no intermediate ticks).
// =====================================================================

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use once_cell::sync::Lazy;
use russh::client::{self, Config};
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::FileType;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::errors::AppError;

// ---------------------------------------------------------------------
// Session registry — independent of ssh.rs's terminal sessions
// ---------------------------------------------------------------------

struct SftpSessionState {
    sftp: SftpSession,
    /// Keep the SSH client handle alive — when it drops, the underlying
    /// connection closes and the SFTP channel becomes useless.
    _handle: russh::client::Handle<ClientHandler>,
    host_label: String,
}

static SESSIONS: Lazy<Mutex<HashMap<String, SftpSessionState>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

// ---------------------------------------------------------------------
// A trust-everything host-key handler for now.
//
// SFTP shares the same SSH connection layer as the terminal, so in a
// later patch we'll reuse the TOFU-enforcing ClientHandler from ssh.rs.
// For 1.5.0 we keep a separate, simpler handler so the modules don't
// have a tight coupling — easy refactor in 1.5.1 if we want unified TOFU.
// ---------------------------------------------------------------------

#[derive(Clone)]
struct ClientHandler {
    host: String,
    port: u16,
}

#[async_trait::async_trait]
impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &russh::keys::key::PublicKey,
    ) -> Result<bool, Self::Error> {
        use crate::commands::known_hosts::{self, VerifyOutcome};

        let store_arc = known_hosts::STORE.clone();
        let mut guard = store_arc.lock().await;
        if guard.is_none() {
            match known_hosts::KnownHostsStore::load() {
                Ok(s) => *guard = Some(s),
                Err(e) => {
                    tracing::warn!(?e, "could not load known_hosts; rejecting SFTP for safety");
                    return Ok(false);
                }
            }
        }
        let store = guard.as_mut().unwrap();

        match store.verify(&self.host, self.port, server_public_key) {
            VerifyOutcome::FirstSeen => {
                tracing::info!(host = %self.host, "SFTP: pinning host key on first connect");
                let _ = store.add(&self.host, self.port, server_public_key);
                Ok(true)
            }
            VerifyOutcome::Match => Ok(true),
            VerifyOutcome::Mismatch { .. } => {
                tracing::error!(host = %self.host,
                    "SFTP: host key CHANGED — refusing connection (use the terminal to forget the old key)");
                Ok(false)
            }
        }
    }
}

// ---------------------------------------------------------------------
// IPC payload types
// ---------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct SftpConnectArgs {
    pub api_base_url: String,
    pub access_token: String,
    pub host_id: String,
    pub password_override: Option<String>,
    pub passphrase: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct SftpConnectResult {
    pub session_id: String,
    /// The remote $HOME path (or "/" if we couldn't resolve it).
    pub initial_path: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct RemoteEntry {
    pub name: String,
    pub path: String, // absolute, server-side
    pub kind: String, // "file" | "dir" | "symlink" | "other"
    pub size: u64,
    pub mtime: i64, // unix seconds
    pub mode: u32,  // POSIX mode bits
    pub uid: Option<u32>,
    pub gid: Option<u32>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(tag = "type")]
pub enum SftpProgressEvent {
    #[serde(rename = "start")]
    Start { total_bytes: u64 },
    #[serde(rename = "progress")]
    Progress { bytes_done: u64 },
    #[serde(rename = "done")]
    Done { bytes_done: u64 },
    #[serde(rename = "error")]
    Error { message: String },
}

// ---------------------------------------------------------------------
// Public Tauri commands
// ---------------------------------------------------------------------

#[tauri::command]
pub async fn sftp_connect(args: SftpConnectArgs) -> Result<SftpConnectResult, AppError> {
    use crate::commands::ssh::fetch_host;

    tracing::info!(host_id = %args.host_id, "sftp_connect requested");

    let host = fetch_host(&args.api_base_url, &args.access_token, &args.host_id).await?;
    if host.protocol != "ssh" {
        return Err(AppError::new("invalid_protocol",
            format!("host protocol is {}, expected ssh (SFTP runs over SSH)", host.protocol)));
    }

    // Resolve auth — same logic as ssh.rs::ssh_connect. Duplicated for now;
    // a follow-up should refactor it into shared helper.
    let (username, auth) = resolve_auth(&host, &args).await?;

    // Open SSH connection
    let config = Arc::new(Config {
        inactivity_timeout: Some(Duration::from_secs(3600)),
        ..Default::default()
    });
    let handler = ClientHandler {
        host: host.hostname.clone(),
        port: host.port as u16,
    };
    let mut handle = client::connect(config, (host.hostname.as_str(), host.port as u16), handler).await
        .map_err(|e| AppError::new("sftp_connect_failed", format!("connect: {e}")))?;

    // Authenticate
    let auth_ok = match &auth {
        ResolvedAuth::Password(pw) => {
            handle.authenticate_password(&username, pw).await
                .map_err(|e| AppError::new("sftp_auth_failed", format!("authenticate: {e}")))?
        }
        ResolvedAuth::PrivateKey { pem, passphrase } => {
            let key = russh_keys::decode_secret_key(pem, passphrase.as_deref())
                .map_err(|e| {
                    let code = if let russh_keys::Error::KeyIsEncrypted = e {
                        "key_passphrase_required"
                    } else if matches!(e, russh_keys::Error::CouldNotReadKey) {
                        "key_invalid_passphrase"
                    } else {
                        "key_decode_failed"
                    };
                    AppError::new(code, format!("decode key: {e}"))
                })?;
            handle.authenticate_publickey(&username, Arc::new(key)).await
                .map_err(|e| AppError::new("sftp_auth_failed", format!("authenticate: {e}")))?
        }
        ResolvedAuth::SshAgent => {
            let sock = std::env::var("SSH_AUTH_SOCK").map_err(|_|
                AppError::new("ssh_agent_unavailable", "SSH_AUTH_SOCK is not set"))?;
            let mut agent = russh_keys::agent::client::AgentClient::connect_uds(&sock).await
                .map_err(|e| AppError::new("ssh_agent_connect_failed",
                    format!("ssh-agent connect: {e}")))?;
            let identities = agent.request_identities().await
                .map_err(|e| AppError::new("ssh_agent_query_failed",
                    format!("list identities: {e}")))?;
            if identities.is_empty() {
                return Err(AppError::new("ssh_agent_no_identities", "ssh-agent has no keys loaded"));
            }
            let mut ok = false;
            for ident in &identities {
                let (agent_back, result) =
                    handle.authenticate_future(&username, ident.clone(), agent).await;
                agent = agent_back;
                match result {
                    Ok(true) => { ok = true; break; }
                    Ok(false) => {}
                    Err(e) => return Err(AppError::new("ssh_agent_auth_failed",
                        format!("authenticate via agent: {e}"))),
                }
            }
            ok
        }
    };
    if !auth_ok {
        return Err(AppError::new("sftp_auth_rejected", "server rejected authentication"));
    }

    // Open SFTP subsystem
    let channel = handle.channel_open_session().await
        .map_err(|e| AppError::new("sftp_channel_failed", format!("open channel: {e}")))?;
    channel.request_subsystem(true, "sftp").await
        .map_err(|e| AppError::new("sftp_subsystem_failed",
            format!("server didn't honor sftp subsystem: {e}")))?;
    let sftp = SftpSession::new(channel.into_stream()).await
        .map_err(|e| AppError::new("sftp_handshake_failed",
            format!("sftp handshake: {e}")))?;

    // Resolve initial path (try $HOME, fall back to /)
    let initial_path = sftp.canonicalize(".").await.unwrap_or_else(|_| "/".to_string());

    let session_id = Uuid::new_v4().to_string();
    let label = host.name.clone().unwrap_or_else(|| host.hostname.clone());
    SESSIONS.lock().await.insert(session_id.clone(), SftpSessionState {
        sftp,
        _handle: handle,
        host_label: label,
    });

    tracing::info!(session_id = %session_id, path = %initial_path, "sftp session established");
    Ok(SftpConnectResult { session_id, initial_path })
}

#[tauri::command]
pub async fn sftp_list(session_id: String, path: String) -> Result<Vec<RemoteEntry>, AppError> {
    let map = SESSIONS.lock().await;
    let session = map.get(&session_id).ok_or_else(|| {
        AppError::new("sftp_session_not_found", format!("no SFTP session {session_id}"))
    })?;

    let canonical = session.sftp.canonicalize(&path).await
        .map_err(|e| AppError::new("sftp_canonicalize_failed",
            format!("could not resolve {path}: {e}")))?;

    let entries_raw = session.sftp.read_dir(&canonical).await
        .map_err(|e| AppError::new("sftp_readdir_failed",
            format!("could not list {canonical}: {e}")))?;

    let mut result = Vec::new();
    for e in entries_raw {
        // Skip "." and ".." entries (some servers return them, some don't)
        if e.file_name() == "." || e.file_name() == ".." {
            continue;
        }
        let attrs = e.metadata();
        let kind = match attrs.file_type() {
            FileType::File => "file",
            FileType::Dir => "dir",
            FileType::Symlink => "symlink",
            _ => "other",
        };
        let entry_path = format!("{}/{}",
            canonical.trim_end_matches('/'),
            e.file_name());
        result.push(RemoteEntry {
            name: e.file_name(),
            path: entry_path,
            kind: kind.to_string(),
            size: attrs.size.unwrap_or(0),
            mtime: attrs.mtime.unwrap_or(0) as i64,
            mode: attrs.permissions.unwrap_or(0),
            uid: attrs.uid,
            gid: attrs.gid,
        });
    }

    // Sort: directories first, then files, alphabetical within each group
    result.sort_by(|a, b| {
        match (a.kind.as_str(), b.kind.as_str()) {
            ("dir", "dir") | ("file", "file") => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
            ("dir", _) => std::cmp::Ordering::Less,
            (_, "dir") => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        }
    });

    Ok(result)
}

#[tauri::command]
pub async fn sftp_download(
    app: AppHandle,
    session_id: String,
    remote_path: String,
    local_path: String,
) -> Result<u64, AppError> {
    let event_channel = format!("sftp:progress:{}", session_id);
    let emit = |evt: SftpProgressEvent| {
        let _ = app.emit(&event_channel, evt);
    };

    let map = SESSIONS.lock().await;
    let session = map.get(&session_id).ok_or_else(|| {
        AppError::new("sftp_session_not_found", format!("no SFTP session {session_id}"))
    })?;

    // Stat the file first so we know total size for progress reporting.
    let metadata = session.sftp.metadata(&remote_path).await
        .map_err(|e| AppError::new("sftp_stat_failed",
            format!("could not stat {remote_path}: {e}")))?;
    let total = metadata.size.unwrap_or(0);

    emit(SftpProgressEvent::Start { total_bytes: total });

    let mut remote_file = session.sftp.open(&remote_path).await
        .map_err(|e| AppError::new("sftp_open_failed",
            format!("could not open {remote_path}: {e}")))?;

    let local_pb = PathBuf::from(&local_path);
    // Ensure parent directory exists (user picked via dialog so it usually does;
    // belt-and-suspenders for absolute path entries via path bar).
    if let Some(parent) = local_pb.parent() {
        let _ = tokio::fs::create_dir_all(parent).await;
    }
    let mut local_file = tokio::fs::File::create(&local_pb).await
        .map_err(|e| {
            let err = AppError::new("local_create_failed",
                format!("could not create {}: {}", local_pb.display(), e));
            emit(SftpProgressEvent::Error { message: err.message.clone() });
            err
        })?;

    // Stream in 64 KiB chunks, emit a progress event every ~64 KiB until done.
    let mut buf = vec![0u8; 64 * 1024];
    let mut bytes_done: u64 = 0;
    loop {
        let n = remote_file.read(&mut buf).await
            .map_err(|e| AppError::new("sftp_read_failed", format!("read: {e}")))?;
        if n == 0 { break; }
        local_file.write_all(&buf[..n]).await
            .map_err(|e| AppError::new("local_write_failed", format!("write: {e}")))?;
        bytes_done += n as u64;
        emit(SftpProgressEvent::Progress { bytes_done });
    }
    local_file.flush().await.ok();

    emit(SftpProgressEvent::Done { bytes_done });
    tracing::info!(session_id = %session_id, %remote_path, bytes = bytes_done,
        "sftp_download complete");
    Ok(bytes_done)
}

// =====================================================================
// 1.6.0 — Write operations (rename, delete, mkdir, upload, read, write)
// =====================================================================

#[tauri::command]
pub async fn sftp_rename(session_id: String, from: String, to: String) -> Result<(), AppError> {
    let map = SESSIONS.lock().await;
    let session = map.get(&session_id).ok_or_else(|| {
        AppError::new("sftp_session_not_found", format!("no SFTP session {session_id}"))
    })?;
    session.sftp.rename(&from, &to).await
        .map_err(|e| AppError::new("sftp_rename_failed",
            format!("rename {from} → {to}: {e}")))?;
    tracing::info!(session_id = %session_id, %from, %to, "sftp rename");
    Ok(())
}

#[tauri::command]
pub async fn sftp_remove_file(session_id: String, path: String) -> Result<(), AppError> {
    let map = SESSIONS.lock().await;
    let session = map.get(&session_id).ok_or_else(|| {
        AppError::new("sftp_session_not_found", format!("no SFTP session {session_id}"))
    })?;
    session.sftp.remove_file(&path).await
        .map_err(|e| AppError::new("sftp_remove_failed", format!("remove {path}: {e}")))?;
    tracing::info!(session_id = %session_id, %path, "sftp remove file");
    Ok(())
}

#[tauri::command]
pub async fn sftp_remove_dir(
    session_id: String,
    path: String,
    recursive: bool,
) -> Result<u64, AppError> {
    let map = SESSIONS.lock().await;
    let session = map.get(&session_id).ok_or_else(|| {
        AppError::new("sftp_session_not_found", format!("no SFTP session {session_id}"))
    })?;
    let removed = if recursive {
        remove_dir_recursive(&session.sftp, &path).await?
    } else {
        session.sftp.remove_dir(&path).await
            .map_err(|e| AppError::new("sftp_remove_dir_failed",
                format!("rmdir {path} (non-empty? use recursive): {e}")))?;
        1
    };
    tracing::info!(session_id = %session_id, %path, recursive, removed,
        "sftp remove dir");
    Ok(removed)
}

/// Walks the tree depth-first, deleting files and then directories.
/// Boxed because we recurse via async fn (otherwise the future type is
/// infinitely-recursive and the compiler refuses).
fn remove_dir_recursive<'a>(
    sftp: &'a SftpSession,
    path: &'a str,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<u64, AppError>> + Send + 'a>> {
    Box::pin(async move {
        let entries = sftp.read_dir(path).await
            .map_err(|e| AppError::new("sftp_readdir_failed",
                format!("read_dir {path} during recursive delete: {e}")))?;
        let mut count: u64 = 0;
        for e in entries {
            let name = e.file_name();
            if name == "." || name == ".." { continue; }
            let child = format!("{}/{}", path.trim_end_matches('/'), name);
            let kind = e.metadata().file_type();
            match kind {
                FileType::Dir => {
                    count += remove_dir_recursive(sftp, &child).await?;
                }
                _ => {
                    sftp.remove_file(&child).await
                        .map_err(|err| AppError::new("sftp_remove_failed",
                            format!("remove {child}: {err}")))?;
                    count += 1;
                }
            }
        }
        sftp.remove_dir(path).await
            .map_err(|e| AppError::new("sftp_remove_dir_failed",
                format!("rmdir {path}: {e}")))?;
        count += 1;
        Ok(count)
    })
}

#[tauri::command]
pub async fn sftp_mkdir(session_id: String, path: String) -> Result<(), AppError> {
    let map = SESSIONS.lock().await;
    let session = map.get(&session_id).ok_or_else(|| {
        AppError::new("sftp_session_not_found", format!("no SFTP session {session_id}"))
    })?;
    session.sftp.create_dir(&path).await
        .map_err(|e| AppError::new("sftp_mkdir_failed", format!("mkdir {path}: {e}")))?;
    tracing::info!(session_id = %session_id, %path, "sftp mkdir");
    Ok(())
}

/// Read a (small) text file into memory. Refuses files larger than the
/// `max_bytes` argument so we never load a multi-GB log into the UI.
#[tauri::command]
pub async fn sftp_read_text(
    session_id: String,
    path: String,
    max_bytes: u64,
) -> Result<String, AppError> {
    let map = SESSIONS.lock().await;
    let session = map.get(&session_id).ok_or_else(|| {
        AppError::new("sftp_session_not_found", format!("no SFTP session {session_id}"))
    })?;
    let attrs = session.sftp.metadata(&path).await
        .map_err(|e| AppError::new("sftp_stat_failed", format!("stat {path}: {e}")))?;
    let size = attrs.size.unwrap_or(0);
    if size > max_bytes {
        return Err(AppError::new("file_too_large",
            format!("file is {size} bytes; refusing to load (max {max_bytes})")));
    }
    let mut f = session.sftp.open(&path).await
        .map_err(|e| AppError::new("sftp_open_failed", format!("open {path}: {e}")))?;
    let mut buf = Vec::with_capacity(size as usize);
    f.read_to_end(&mut buf).await
        .map_err(|e| AppError::new("sftp_read_failed", format!("read {path}: {e}")))?;
    String::from_utf8(buf)
        .map_err(|_| AppError::new("not_utf8",
            "file contains non-UTF-8 bytes; only text files can be edited in-place"))
}

#[tauri::command]
pub async fn sftp_write_text(
    session_id: String,
    path: String,
    content: String,
) -> Result<u64, AppError> {
    let map = SESSIONS.lock().await;
    let session = map.get(&session_id).ok_or_else(|| {
        AppError::new("sftp_session_not_found", format!("no SFTP session {session_id}"))
    })?;
    // Open with truncate semantics: we want to fully replace the file's
    // contents, not append. russh-sftp 2.x exposes `create()` for this.
    let mut f = session.sftp.create(&path).await
        .map_err(|e| AppError::new("sftp_open_failed",
            format!("open {path} for writing: {e}")))?;
    f.write_all(content.as_bytes()).await
        .map_err(|e| AppError::new("sftp_write_failed",
            format!("write {path}: {e}")))?;
    f.flush().await.ok();
    let len = content.len() as u64;
    tracing::info!(session_id = %session_id, %path, len, "sftp write text");
    Ok(len)
}

/// Upload a local file to a remote path. Streams in 64 KiB chunks and
/// emits progress events on `sftp:progress:{session_id}` so the renderer
/// can show a progress bar — identical event shape to downloads.
#[tauri::command]
pub async fn sftp_upload(
    app: AppHandle,
    session_id: String,
    local_path: String,
    remote_path: String,
) -> Result<u64, AppError> {
    let event_channel = format!("sftp:progress:{}", session_id);
    let emit = |evt: SftpProgressEvent| {
        let _ = app.emit(&event_channel, evt);
    };

    let map = SESSIONS.lock().await;
    let session = map.get(&session_id).ok_or_else(|| {
        AppError::new("sftp_session_not_found", format!("no SFTP session {session_id}"))
    })?;

    let local_pb = PathBuf::from(&local_path);
    let metadata = tokio::fs::metadata(&local_pb).await
        .map_err(|e| AppError::new("local_stat_failed",
            format!("could not stat {}: {}", local_pb.display(), e)))?;
    let total = metadata.len();

    emit(SftpProgressEvent::Start { total_bytes: total });

    let mut local_file = tokio::fs::File::open(&local_pb).await
        .map_err(|e| AppError::new("local_open_failed",
            format!("open {}: {}", local_pb.display(), e)))?;
    let mut remote_file = session.sftp.create(&remote_path).await
        .map_err(|e| {
            let err = AppError::new("sftp_create_failed",
                format!("create {remote_path}: {e}"));
            emit(SftpProgressEvent::Error { message: err.message.clone() });
            err
        })?;

    let mut buf = vec![0u8; 64 * 1024];
    let mut bytes_done: u64 = 0;
    loop {
        let n = local_file.read(&mut buf).await
            .map_err(|e| AppError::new("local_read_failed", format!("read: {e}")))?;
        if n == 0 { break; }
        remote_file.write_all(&buf[..n]).await
            .map_err(|e| AppError::new("sftp_write_failed", format!("write: {e}")))?;
        bytes_done += n as u64;
        emit(SftpProgressEvent::Progress { bytes_done });
    }
    remote_file.flush().await.ok();
    drop(remote_file);

    emit(SftpProgressEvent::Done { bytes_done });
    tracing::info!(session_id = %session_id, %remote_path, bytes = bytes_done,
        "sftp_upload complete");
    Ok(bytes_done)
}

// =====================================================================
// End 1.6.0 additions
// =====================================================================

// ---------------------------------------------------------------------
// 1.7.0 — chmod / chown
// ---------------------------------------------------------------------
//
// Both operations go through SFTP's SETSTAT (russh-sftp's
// `set_metadata`). We send only the fields we want to change so the
// server doesn't accidentally clobber unrelated attributes — the
// protocol uses a bitmask on the wire and the crate constructs that
// bitmask from `Some(_)` fields.
//
// `mode` is taken as the low 12 bits of the supplied u32 (rwxrwxrwx
// plus setuid/setgid/sticky). We mask before sending so a caller
// passing a full 16-bit st_mode (including file-type bits) still does
// the right thing — file-type bits are not writable via SETSTAT
// anyway, but masking avoids a confused server.
//
// chown takes raw numeric uid/gid because translating names → ids
// over SFTP would need either an extra shell round-trip or scraping
// `/etc/passwd`, both of which we'd rather not do silently. The UI
// shows the current numeric ids and lets the user override them.

/// Change the POSIX mode bits on `path`. `mode` is masked to 0o7777.
#[tauri::command]
pub async fn sftp_chmod(
    session_id: String,
    path: String,
    mode: u32,
) -> Result<(), AppError> {
    let map = SESSIONS.lock().await;
    let session = map.get(&session_id).ok_or_else(|| {
        AppError::new("sftp_session_not_found", format!("no SFTP session {session_id}"))
    })?;
    let mut attrs = russh_sftp::protocol::FileAttributes::default();
    attrs.permissions = Some(mode & 0o7777);
    session.sftp.set_metadata(&path, attrs).await
        .map_err(|e| AppError::new("sftp_chmod_failed",
            format!("chmod {path} -> {:o}: {e}", mode & 0o7777)))?;
    tracing::info!(session_id = %session_id, %path, mode = format!("{:o}", mode & 0o7777),
        "sftp chmod");
    Ok(())
}

/// Change owner / group on `path`. Either side may be `None` to leave
/// that side unchanged. If both are `None` this is a no-op success.
#[tauri::command]
pub async fn sftp_chown(
    session_id: String,
    path: String,
    uid: Option<u32>,
    gid: Option<u32>,
) -> Result<(), AppError> {
    if uid.is_none() && gid.is_none() {
        return Ok(());
    }
    let map = SESSIONS.lock().await;
    let session = map.get(&session_id).ok_or_else(|| {
        AppError::new("sftp_session_not_found", format!("no SFTP session {session_id}"))
    })?;
    let mut attrs = russh_sftp::protocol::FileAttributes::default();
    attrs.uid = uid;
    attrs.gid = gid;
    session.sftp.set_metadata(&path, attrs).await
        .map_err(|e| AppError::new("sftp_chown_failed",
            format!("chown {path} -> uid={uid:?} gid={gid:?}: {e}")))?;
    tracing::info!(session_id = %session_id, %path, ?uid, ?gid, "sftp chown");
    Ok(())
}

// =====================================================================
// End 1.7.0 additions
// =====================================================================

#[tauri::command]
pub async fn sftp_disconnect(session_id: String) -> Result<(), AppError> {
    let mut map = SESSIONS.lock().await;
    if map.remove(&session_id).is_some() {
        tracing::info!(session_id = %session_id, "sftp session closed");
    }
    Ok(())
}

#[tauri::command]
pub async fn sftp_list_sessions() -> Result<Vec<(String, String)>, AppError> {
    let map = SESSIONS.lock().await;
    Ok(map.iter().map(|(id, st)| (id.clone(), st.host_label.clone())).collect())
}

// ---------------------------------------------------------------------
// Auth resolution — duplicates ssh.rs logic until we refactor a shared helper.
// ---------------------------------------------------------------------

enum ResolvedAuth {
    Password(String),
    PrivateKey { pem: String, passphrase: Option<String> },
    SshAgent,
}

async fn resolve_auth(
    host: &crate::commands::ssh::HostJson,
    args: &SftpConnectArgs,
) -> Result<(String, ResolvedAuth), AppError> {
    use crate::commands::ssh::{fetch_credential, fetch_credential_with_secret};

    if let Some(p) = args.password_override.as_ref() {
        let username = match &host.credential_id {
            Some(cid) => fetch_credential(&args.api_base_url, &args.access_token, cid).await?
                .username.unwrap_or_else(|| "root".into()),
            None => "root".into(),
        };
        return Ok((username, ResolvedAuth::Password(p.clone())));
    }

    let cred_id = host.credential_id.as_ref().ok_or_else(||
        AppError::new("no_credential", "host has no credential and no password was provided"))?;
    let cred = fetch_credential_with_secret(&args.api_base_url, &args.access_token, cred_id).await?;
    let username = cred.username.clone().unwrap_or_else(|| "root".into());

    let auth = match cred.credential_type.as_str() {
        "password" => {
            let pw = cred.secret_data.as_ref()
                .and_then(|v| v.get("password"))
                .and_then(|v| v.as_str())
                .ok_or_else(|| AppError::new("credential_missing_password",
                    "credential has no 'password' field"))?
                .to_string();
            ResolvedAuth::Password(pw)
        }
        "private_key" => {
            let pem = cred.secret_data.as_ref()
                .and_then(|v| v.get("private_key"))
                .and_then(|v| v.as_str())
                .ok_or_else(|| AppError::new("credential_missing_key",
                    "credential has no 'private_key' field"))?
                .to_string();
            let passphrase = args.passphrase.clone()
                .or_else(|| cred.secret_data.as_ref()
                    .and_then(|v| v.get("passphrase"))
                    .and_then(|v| v.as_str())
                    .map(String::from));
            ResolvedAuth::PrivateKey { pem, passphrase }
        }
        "ssh_agent" | "agent" => ResolvedAuth::SshAgent,
        other => return Err(AppError::new("unsupported_credential_type",
            format!("credential type '{other}' not supported"))),
    };
    Ok((username, auth))
}
