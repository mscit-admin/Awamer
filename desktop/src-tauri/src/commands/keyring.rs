// Secure token storage backed by the OS-native credential store
// (macOS Keychain, Windows Credential Manager, libsecret on Linux).
//
// We *never* persist refresh tokens to disk in plain text; localStorage
// in the webview is also forbidden for credentials. The renderer talks
// to these commands instead.

use crate::errors::{CommandError, CommandResult};

const SERVICE: &str = "io.netsphere.terminal";

/// Store a secret in the OS keyring.
#[tauri::command]
pub async fn keyring_set(key: String, value: String) -> CommandResult<()> {
    if key.is_empty() {
        return Err(CommandError::InvalidArgument("key must not be empty".into()));
    }
    let entry = keyring::Entry::new(SERVICE, &key)?;
    entry.set_password(&value)?;
    Ok(())
}

/// Retrieve a secret from the OS keyring.
/// Returns an Err with NotFound when no entry exists.
#[tauri::command]
pub async fn keyring_get(key: String) -> CommandResult<String> {
    let entry = keyring::Entry::new(SERVICE, &key)?;
    match entry.get_password() {
        Ok(v) => Ok(v),
        Err(keyring::Error::NoEntry) => Err(CommandError::NotFound),
        Err(e) => Err(CommandError::Keyring(e)),
    }
}

/// Delete a secret from the OS keyring (e.g. on logout).
#[tauri::command]
pub async fn keyring_delete(key: String) -> CommandResult<()> {
    let entry = keyring::Entry::new(SERVICE, &key)?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()), // idempotent
        Err(e) => Err(CommandError::Keyring(e)),
    }
}
