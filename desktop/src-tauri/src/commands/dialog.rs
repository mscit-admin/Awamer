// =====================================================================
// 1.6.1 — Native file dialogs driven from Rust
// =====================================================================
//
// Why these exist:
//   The renderer used to call `save()` / `open()` from the JS
//   `@tauri-apps/plugin-dialog` package directly. On some Tauri 2.x
//   setups the JS plugin and the bundled `@tauri-apps/api` disagree on
//   versions, so the plugin's internal `invoke` reference resolves off
//   an `undefined` global and throws:
//
//       Cannot read properties of undefined (reading 'invoke')
//
//   Driving the dialog from the Rust side sidesteps the JS plugin
//   entirely — the renderer just calls these ordinary IPC commands and
//   gets a path string back. The Rust `tauri-plugin-dialog` API is
//   stable across the 2.x line, so this can't drift the same way.
//
// All three return `Ok(None)` when the user cancels the dialog.
// =====================================================================

use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;
use tokio::sync::oneshot;

use crate::errors::AppError;

/// The native pickers are callback-based; bridge them onto a oneshot so
/// the command can `await` the user's choice without blocking a thread.
async fn await_choice(
    rx: oneshot::Receiver<Option<tauri_plugin_dialog::FilePath>>,
) -> Result<Option<String>, AppError> {
    let picked = rx.await.map_err(|e| {
        AppError::new("dialog_failed", format!("dialog channel closed: {e}"))
    })?;
    Ok(picked
        .and_then(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned()))
}

/// "Save as…" dialog. `default_name` pre-fills the filename field.
#[tauri::command]
pub async fn dialog_save_file(
    app: AppHandle,
    default_name: Option<String>,
) -> Result<Option<String>, AppError> {
    let (tx, rx) = oneshot::channel();
    let mut builder = app.dialog().file();
    if let Some(name) = default_name {
        builder = builder.set_file_name(name);
    }
    builder.save_file(move |path| {
        let _ = tx.send(path);
    });
    await_choice(rx).await
}

/// "Open file…" dialog (single selection).
#[tauri::command]
pub async fn dialog_open_file(app: AppHandle) -> Result<Option<String>, AppError> {
    let (tx, rx) = oneshot::channel();
    app.dialog().file().pick_file(move |path| {
        let _ = tx.send(path);
    });
    await_choice(rx).await
}

/// "Choose folder…" dialog — used to pick a download destination for
/// recursive folder downloads.
#[tauri::command]
pub async fn dialog_pick_folder(app: AppHandle) -> Result<Option<String>, AppError> {
    let (tx, rx) = oneshot::channel();
    app.dialog().file().pick_folder(move |path| {
        let _ = tx.send(path);
    });
    await_choice(rx).await
}
