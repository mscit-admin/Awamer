//! Native RDP launch — hand a generated `.rdp` file to the OS's own RDP client.
//!
//! Unlike the in-app guacd viewer, this opens the platform's native Remote
//! Desktop client (mstsc on Windows, Microsoft Remote Desktop on macOS, any
//! `.rdp` handler via `xdg-open` on Linux). A minimal `.rdp` file is written to
//! the temp dir and opened. The password is intentionally NOT embedded (a `.rdp`
//! password blob is Windows-DPAPI-only and per-user); the client prompts for it.
//!
//! Every value is validated before it is written: a `.rdp` file is one
//! `key:type:value` setting per line, so a host or user name containing a line
//! break could otherwise add settings such as `alternate shell` or drive
//! redirection.

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

fn sanitize_filename(s: &str) -> String {
    s.chars()
        .take(64)
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '_' })
        .collect()
}

/// Host name, IPv4 or IPv6 literal: letters, digits, `.`, `-`, `:`, `[`, `]`.
fn valid_host(h: &str) -> bool {
    !h.is_empty()
        && h.len() <= 253
        && h.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':' | '[' | ']'))
}

/// User or domain names: printable, no control characters, bounded length.
fn valid_name(s: &str) -> bool {
    s.len() <= 256 && !s.chars().any(|c| c.is_control())
}

/// Build the `.rdp` file contents from validated connection settings.
fn rdp_file(args: &RdpLaunchArgs) -> Result<String, CommandError> {
    let host = args.host.trim();
    if !valid_host(host) {
        return Err(CommandError::InvalidArgument("invalid host name".into()));
    }
    if args.port == 0 {
        return Err(CommandError::InvalidArgument("invalid port".into()));
    }
    let mut lines = vec![
        format!("full address:s:{}:{}", host, args.port),
        "screen mode id:i:2".to_string(),
        "use multimon:i:0".to_string(),
        "prompt for credentials:i:1".to_string(),
        "authentication level:i:2".to_string(),
        "redirectclipboard:i:1".to_string(),
    ];
    for (key, value) in [("username", &args.username), ("domain", &args.domain)] {
        if let Some(v) = value.as_ref().map(|v| v.trim()).filter(|v| !v.is_empty()) {
            if !valid_name(v) {
                return Err(CommandError::InvalidArgument(format!("invalid {key}")));
            }
            lines.push(format!("{key}:s:{v}"));
        }
    }
    Ok(lines.join("\r\n") + "\r\n")
}

/// Open the given `.rdp` file with the OS's RDP client.
#[cfg(target_os = "windows")]
fn open_with_os(path: &std::path::Path) -> std::io::Result<()> {
    // Call mstsc directly (no `cmd /C start`, so no shell parses the path).
    std::process::Command::new("mstsc").arg(path).spawn().map(|_| ())
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
/// Returns the path written.
#[tauri::command]
pub async fn rdp_launch(args: RdpLaunchArgs) -> Result<String, CommandError> {
    let contents = rdp_file(&args)?;
    let base = args.name.as_deref().filter(|s| !s.trim().is_empty()).unwrap_or(&args.host);
    let path = std::env::temp_dir().join(format!("awamer-{}.rdp", sanitize_filename(base)));

    let mut file = std::fs::File::create(&path)?;
    file.write_all(contents.as_bytes())?;
    drop(file);

    open_with_os(&path)?;
    Ok(path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(host: &str, user: Option<&str>) -> RdpLaunchArgs {
        RdpLaunchArgs { host: host.into(), port: 3389, username: user.map(Into::into), domain: None, name: None }
    }

    #[test]
    fn writes_a_minimal_rdp_file() {
        let f = rdp_file(&args("10.0.0.5", Some("alice"))).unwrap();
        assert!(f.starts_with("full address:s:10.0.0.5:3389\r\n"));
        assert!(f.contains("username:s:alice\r\n"));
        assert!(!f.to_lowercase().contains("password"));
    }

    #[test]
    fn rejects_line_breaks_that_would_add_settings() {
        assert!(rdp_file(&args("10.0.0.5\r\nalternate shell:s:cmd.exe", None)).is_err());
        assert!(rdp_file(&args("10.0.0.5", Some("bob\r\ndrivestoredirect:s:*"))).is_err());
        assert!(rdp_file(&args("", None)).is_err());
        assert!(rdp_file(&args("host name", None)).is_err());
    }

    #[test]
    fn accepts_hostnames_and_ipv6() {
        assert!(rdp_file(&args("win-01.corp.example", None)).is_ok());
        assert!(rdp_file(&args("[fd00::5]", None)).is_ok());
    }

    #[test]
    fn filename_is_sanitised() {
        assert_eq!(sanitize_filename("../../evil name"), ".._.._evil_name");
    }
}
