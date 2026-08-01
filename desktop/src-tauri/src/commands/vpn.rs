// =====================================================================
// OpenVPN client commands (desktop runtime — migration 017)
// =====================================================================
//
// For a `runtime = "desktop"` VPN profile the openvpn client process runs
// here, on the user's machine, so the native SSH/SFTP connectors can reach
// assets that live behind the tunnel. Multiple tunnels can be up at once
// (different zones / configs), keyed by profile id.
//
//   Renderer ──invoke('vpn_connect', {profileId, config, ...})──► this module
//                                                              │
//                                                              ▼
//                                          spawn `openvpn --config <tmp>`
//                                                              │
//                                    parse stdout for "Initialization
//                                    Sequence Completed" → connected
//
// Bringing up a tun device needs the `openvpn` binary on PATH and elevated
// privileges; when either is missing the command fails with a clear code
// (`vpn_openvpn_unavailable` / the OS error) rather than a silent no-op.
// =====================================================================

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex as StdMutex};

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::{mpsc, oneshot, Mutex};
use uuid::Uuid;

use crate::errors::AppError;

const READY_MARKER: &str = "Initialization Sequence Completed";
const CONNECT_TIMEOUT_SECS: u64 = 30;

#[derive(Clone, Serialize)]
pub struct VpnStatus {
    pub profile_id: String,
    pub name: String,
    /// "connecting" | "connected" | "error" | "closed"
    pub state: String,
    pub error: Option<String>,
}

struct VpnProc {
    status: Arc<StdMutex<VpnStatus>>,
    stop: mpsc::UnboundedSender<()>,
    dir: PathBuf,
}

/// Live desktop tunnels, keyed by profile id.
static VPN: Lazy<Mutex<HashMap<String, VpnProc>>> = Lazy::new(|| Mutex::new(HashMap::new()));

#[derive(Deserialize)]
pub struct VpnConnectArgs {
    pub profile_id: String,
    pub name: String,
    /// Assembled .ovpn config text (from the backend `/config` endpoint).
    pub config: String,
    /// "none" | "userpass"
    #[serde(default)]
    pub auth_mode: Option<String>,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
}

fn snapshot(status: &Arc<StdMutex<VpnStatus>>) -> VpnStatus {
    status.lock().unwrap().clone()
}

fn set_state(status: &Arc<StdMutex<VpnStatus>>, state: &str, error: Option<String>) {
    let mut s = status.lock().unwrap();
    s.state = state.to_string();
    s.error = error;
}

fn write_secure(path: &PathBuf, contents: &str) -> Result<(), AppError> {
    std::fs::write(path, contents).map_err(|e| AppError::new("vpn_io", e.to_string()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// Bring up (or reuse) a desktop OpenVPN tunnel for a profile.
#[tauri::command]
pub async fn vpn_connect(args: VpnConnectArgs) -> Result<VpnStatus, AppError> {
    // Reuse a tunnel that is already up or coming up for this profile.
    {
        let map = VPN.lock().await;
        if let Some(p) = map.get(&args.profile_id) {
            let st = snapshot(&p.status);
            if st.state == "connected" || st.state == "connecting" {
                return Ok(st);
            }
        }
    }

    if args.config.trim().is_empty() {
        return Err(AppError::new("vpn_config_missing", "profile has no OpenVPN configuration"));
    }

    // Stage config (+ auth file) in a private temp dir.
    let dir = std::env::temp_dir().join(format!("awamer-vpn-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&dir).map_err(|e| AppError::new("vpn_io", e.to_string()))?;
    let config_path = dir.join("client.ovpn");
    write_secure(&config_path, &args.config)?;

    let mut cmd = Command::new("openvpn");
    cmd.arg("--config").arg(&config_path);
    if args.auth_mode.as_deref() == Some("userpass") {
        let auth_path = dir.join("auth.txt");
        let body = format!(
            "{}\n{}\n",
            args.username.clone().unwrap_or_default(),
            args.password.clone().unwrap_or_default()
        );
        write_secure(&auth_path, &body)?;
        cmd.arg("--auth-user-pass").arg(&auth_path).arg("--auth-nocache");
    }
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);

    let mut child = cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            AppError::new("vpn_openvpn_unavailable", "the openvpn binary was not found on PATH")
        } else {
            AppError::new("vpn_spawn_failed", e.to_string())
        }
    })?;

    let status = Arc::new(StdMutex::new(VpnStatus {
        profile_id: args.profile_id.clone(),
        name: args.name.clone(),
        state: "connecting".into(),
        error: None,
    }));

    // Merge stdout + stderr into one line stream.
    let (line_tx, mut line_rx) = mpsc::unbounded_channel::<String>();
    if let Some(out) = child.stdout.take() {
        let tx = line_tx.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(out).lines();
            while let Ok(Some(l)) = lines.next_line().await {
                if tx.send(l).is_err() {
                    break;
                }
            }
        });
    }
    if let Some(err) = child.stderr.take() {
        let tx = line_tx.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(err).lines();
            while let Ok(Some(l)) = lines.next_line().await {
                if tx.send(l).is_err() {
                    break;
                }
            }
        });
    }
    drop(line_tx);

    let (stop_tx, mut stop_rx) = mpsc::unbounded_channel::<()>();
    let (ready_tx, ready_rx) = oneshot::channel::<Result<(), String>>();

    // Monitor task owns the child; it reports readiness and keeps the shared
    // status live until the process exits or a stop is requested.
    let mon_status = status.clone();
    let mon_dir = dir.clone();
    tokio::spawn(async move {
        let mut ready_tx = Some(ready_tx);
        let mut became_ready = false;
        loop {
            tokio::select! {
                _ = stop_rx.recv() => {
                    let _ = child.start_kill();
                    let _ = child.wait().await;
                    set_state(&mon_status, "closed", None);
                    break;
                }
                exit = child.wait() => {
                    let msg = match exit {
                        Ok(code) => format!("openvpn exited ({code})"),
                        Err(e) => format!("openvpn wait failed: {e}"),
                    };
                    if let Some(tx) = ready_tx.take() {
                        let _ = tx.send(Err(msg.clone()));
                    }
                    set_state(&mon_status, if became_ready { "closed" } else { "error" }, Some(msg));
                    break;
                }
                line = line_rx.recv() => {
                    match line {
                        Some(l) => {
                            if !became_ready && l.contains(READY_MARKER) {
                                became_ready = true;
                                set_state(&mon_status, "connected", None);
                                if let Some(tx) = ready_tx.take() {
                                    let _ = tx.send(Ok(()));
                                }
                            }
                        }
                        None => { /* streams closed; wait() will resolve */ }
                    }
                }
            }
        }
        let _ = std::fs::remove_dir_all(&mon_dir);
    });

    {
        let mut map = VPN.lock().await;
        map.insert(
            args.profile_id.clone(),
            VpnProc { status: status.clone(), stop: stop_tx.clone(), dir: dir.clone() },
        );
    }

    // Wait for the tunnel to come up (or fail) within the timeout.
    let waited = tokio::time::timeout(
        std::time::Duration::from_secs(CONNECT_TIMEOUT_SECS),
        ready_rx,
    )
    .await;

    match waited {
        Ok(Ok(Ok(()))) => Ok(snapshot(&status)),
        Ok(Ok(Err(msg))) => {
            VPN.lock().await.remove(&args.profile_id);
            Err(AppError::new("vpn_connect_failed", msg))
        }
        Ok(Err(_recv)) => {
            VPN.lock().await.remove(&args.profile_id);
            Err(AppError::new("vpn_connect_failed", "monitor closed unexpectedly"))
        }
        Err(_timeout) => {
            let _ = stop_tx.send(());
            VPN.lock().await.remove(&args.profile_id);
            Err(AppError::new(
                "vpn_connect_timeout",
                format!("openvpn did not connect within {CONNECT_TIMEOUT_SECS}s"),
            ))
        }
    }
}

/// Stop a desktop tunnel and forget it.
#[tauri::command]
pub async fn vpn_disconnect(profile_id: String) -> Result<(), AppError> {
    let entry = VPN.lock().await.remove(&profile_id);
    if let Some(p) = entry {
        let _ = p.stop.send(());
        let _ = std::fs::remove_dir_all(&p.dir);
        Ok(())
    } else {
        Err(AppError::new("vpn_connection_not_found", "no active tunnel for this profile"))
    }
}

/// Current status of one profile's tunnel, or null if none.
#[tauri::command]
pub async fn vpn_status(profile_id: String) -> Result<Option<VpnStatus>, AppError> {
    let map = VPN.lock().await;
    Ok(map.get(&profile_id).map(|p| snapshot(&p.status)))
}

/// All live desktop tunnels.
#[tauri::command]
pub async fn vpn_list() -> Result<Vec<VpnStatus>, AppError> {
    let map = VPN.lock().await;
    Ok(map.values().map(|p| snapshot(&p.status)).collect())
}
