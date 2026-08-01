// NetSphere Terminal — Tauri runtime.
//
// This crate is intentionally thin in Phase 1: it registers the IPC
// commands the renderer needs (secure token storage, app metadata)
// and wires Tauri plugins. Protocol-specific logic (SSH, SFTP, etc.)
// will live in dedicated crates added in later phases.

mod commands;
mod errors;

use tracing_subscriber::EnvFilter;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .with_target(false)
        .compact()
        .init();

    tracing::info!("NetSphere Terminal starting");

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::keyring::keyring_set,
            commands::keyring::keyring_get,
            commands::keyring::keyring_delete,
            commands::app::app_version,
            commands::app::app_log,
            commands::dialog::dialog_save_file,
            commands::dialog::dialog_open_file,
            commands::dialog::dialog_pick_folder,
            commands::ssh::ssh_connect,
            commands::ssh::ssh_write,
            commands::ssh::ssh_resize,
            commands::ssh::ssh_disconnect,
            commands::ssh::ssh_get_known_host,
            commands::ssh::ssh_forget_known_host,
            commands::ssh::ssh_list_known_hosts,
            commands::sftp::sftp_connect,
            commands::sftp::sftp_list,
            commands::sftp::sftp_download,
            commands::sftp::sftp_disconnect,
            commands::sftp::sftp_list_sessions,
            commands::sftp::sftp_rename,
            commands::sftp::sftp_remove_file,
            commands::sftp::sftp_remove_dir,
            commands::sftp::sftp_mkdir,
            commands::sftp::sftp_read_text,
            commands::sftp::sftp_write_text,
            commands::sftp::sftp_upload,
            commands::sftp::sftp_chmod,
            commands::sftp::sftp_chown,
            commands::sftp::sftp_download_dir,
            commands::vpn::vpn_connect,
            commands::vpn::vpn_disconnect,
            commands::vpn::vpn_status,
            commands::vpn::vpn_list,
        ])
        .setup(|app| {
            #[cfg(debug_assertions)]
            {
                use tauri::Manager;
                if let Some(window) = app.get_webview_window("main") {
                    window.open_devtools();
                }
            }
            tracing::info!(version = env!("CARGO_PKG_VERSION"), "app ready");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
