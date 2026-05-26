use crate::errors::CommandResult;
use serde::Serialize;

#[derive(Serialize)]
pub struct AppVersion {
    pub version: &'static str,
    pub build: &'static str,
}

/// Returns the current app version.
#[tauri::command]
pub async fn app_version() -> CommandResult<AppVersion> {
    Ok(AppVersion {
        version: env!("CARGO_PKG_VERSION"),
        build: option_env!("APP_BUILD").unwrap_or("dev"),
    })
}

/// Forwards a log message from the renderer to the host's tracing layer
/// so it shows up in the Rust logs alongside backend events.
#[tauri::command]
pub async fn app_log(level: String, message: String) -> CommandResult<()> {
    match level.as_str() {
        "error" => tracing::error!(target: "renderer", "{}", message),
        "warn" => tracing::warn!(target: "renderer", "{}", message),
        "info" => tracing::info!(target: "renderer", "{}", message),
        "debug" => tracing::debug!(target: "renderer", "{}", message),
        _ => tracing::trace!(target: "renderer", "{}", message),
    }
    Ok(())
}
