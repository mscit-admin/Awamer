//! Native RDP launch — hand a generated `.rdp` file to the OS's own RDP client.
//!
//! Unlike the in-app guacd viewer, this opens the platform's native Remote
//! Desktop client (mstsc on Windows, Microsoft Remote Desktop on macOS, any
//! `.rdp`/`xdg-open` handler on Linux). We write a minimal `.rdp` file to the
//! temp dir and ask the OS to open it. The password is intentionally NOT
//! embedded (a `.rdp` password blob is Windows-DPAPI-only and per-user); the
//! native client prompts for it.

use crate::errors::CommandError;
use serde::Deserialize;
use std::io::Write;

#[derive(Deserialize)]
pub struct RdpLaunchArgs {
    pub host: String,
    pub port: u16,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub domain: Option<String>,
    /// Display name used for the temp filename only.
    #[serde(default)]
    pub name: Option<String>,
}

fn sanitize(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '_' })
        .collect()
}

/// Build the `.rdp` file contents from the connection settings.
fn rdp_file(args: &RdpLaunchArgs) -> String {
    let mut lines = vec![
        format!("full address:s:{}:{}", args.host, args.port),
        "screen mode id:i:2".to_string(),
        "use multimon:i:0".to_string(),
        "prompt for credentials:i:1".to_string(),
        "authentication level:i:2".to_string(),
        "redirectclipboard:i:1".to_string(),
    ];
    if let Some(u) = args.username.as_ref().filter(|u| !u.is_empty()) {
        lines.push(format!("username:s:{}", u));
    }
    if let Some(d) = args.domain.as_ref().filter(|d| !d.is_empty()) {
        lines.push(format!("domain:s:{}", d));
    }
    lines.join("\r\n") + "\r\n"
}

/// Open the given `.rdp` file with the OS default handler.
#[cfg(target_os = "windows")]
fn open_with_os(path: &std::path::Path) -> std::io::Result<()> {
    // `cmd /C start "" file.rdp` launches mstsc via the file association.
    std::process::Command::new("cmd")
        .args(["/C", "start", "", &path.to_string_lossy()])
        .spawn()
        .map(|_| ())
}

#[cfg(target_os = "macos")]
fn open_with_os(path: &std::path::Path) -> std::io::Result<()> {
    std::process::Command::new("open").arg(path).spawn().map(|_| ())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn open_with_os(path: &std::path::Path) -> std::io::Result<()> {
    std::process::Command::new("xdg-open").arg(path).spawn().map(|_| ())
}

/// Write a `.rdp` file for the host and open it with the native RDP client.
/// Returns the path written (useful for logging/tests).
#[tauri::command]
pub async fn rdp_launch(args: RdpLaunchArgs) -> Result<String, CommandError> {
    if args.host.trim().is_empty() {
        return Err(CommandError::InvalidArgument("host is required".into()));
    }
    let base = args.name.as_deref().filter(|s| !s.is_empty()).unwrap_or(&args.host);
    let filename = format!("awamer-{}.rdp", sanitize(base));
    let path = std::env::temp_dir().join(filename);

    let mut file = std::fs::File::create(&path)?;
    file.write_all(rdp_file(&args).as_bytes())?;
    drop(file);

    open_with_os(&path)?;
    Ok(path.to_string_lossy().to_string())
}
