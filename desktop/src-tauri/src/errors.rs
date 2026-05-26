use serde::{Serialize, Serializer};
use thiserror::Error;

/// Errors that can be returned from Tauri commands to the renderer.
///
/// We implement Serialize manually so the JS side receives a plain
/// string instead of a tagged union, which is friendlier to consume.
#[derive(Debug, Error)]
pub enum CommandError {
    #[error("keyring error: {0}")]
    Keyring(#[from] keyring::Error),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("invalid argument: {0}")]
    InvalidArgument(String),

    #[error("not found")]
    NotFound,
}

impl Serialize for CommandError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

pub type CommandResult<T> = Result<T, CommandError>;

/// Structured error for IPC commands that want to carry both a stable
/// machine code and a human-readable message. The renderer can switch on
/// `code` to localise or special-case handling.
#[derive(Debug, Serialize)]
pub struct AppError {
    pub code: String,
    pub message: String,
}

impl AppError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self { code: code.into(), message: message.into() }
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for AppError {}
