// =====================================================================
// Phase 3b (1.3.0) — Known hosts management (TOFU)
// =====================================================================
//
// Stores server host keys in ~/.netsphere/known_hosts using a format
// compatible with OpenSSH's known_hosts so users can copy/paste lines
// between the two files.
//
// Each line:
//     <hostname>[:port] <key-type> <base64-key>
//
// Example:
//     example.com ssh-rsa AAAAB3NzaC1yc2E...
//     [10.0.0.5]:2222 ssh-ed25519 AAAAC3Nz...
//
// Lookup semantics (TOFU = Trust On First Use):
//   - First connection: no entry → save the server's key, accept connection
//   - Subsequent connection, same key → accept silently
//   - Subsequent connection, DIFFERENT key → reject with HostKeyChanged
//     and require manual `forget_host` to clear before reconnecting.
//
// Phase 3b limitations:
//   - We do NOT support hashed hostnames (`|1|salt|hash` lines from OpenSSH).
//     Hashed entries are parsed as opaque and ignored for matching, but
//     preserved on save so the file stays consistent if the user mixes
//     entries from `ssh-keygen -H`.
//   - We do NOT support negation (`!host`), revocation markers (`@revoked`),
//     or CA markers (`@cert-authority`). These are 1.4.0+ territory.
//   - File-locking on writes is best-effort (open-truncate-write). Concurrent
//     writes from two NetSphere processes would race, but that's not a
//     realistic scenario for a desktop app.
// =====================================================================

use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::sync::Arc;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use once_cell::sync::Lazy;
use russh::keys::key::PublicKey;
use russh_keys::PublicKeyBase64;
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;

use crate::errors::AppError;

// ---------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------

/// One parsed entry from known_hosts.
#[derive(Debug, Clone)]
pub struct KnownHostEntry {
    /// Display label as it appears in the file. For ordinary entries this is
    /// `host[:port]`. For OpenSSH `|1|...` hashed entries this is the raw
    /// hashed prefix — we preserve it on save but never match against it.
    pub label: String,
    /// Key algorithm, e.g. `ssh-rsa`, `ssh-ed25519`, `ecdsa-sha2-nistp256`.
    pub algo: String,
    /// Base64-encoded key bytes (no whitespace).
    pub key_b64: String,
}

impl KnownHostEntry {
    fn matches(&self, host: &str, port: u16) -> bool {
        // OpenSSH defaults to port 22 in plain hostnames. For non-default
        // ports we use the bracketed form, [host]:port.
        if self.label.starts_with("|1|") {
            return false; // hashed entries unsupported in 1.3.0
        }
        let expected_plain = host.to_string();
        let expected_with_port = format!("[{}]:{}", host, port);
        if port == 22 {
            self.label.eq_ignore_ascii_case(&expected_plain) ||
            self.label.eq_ignore_ascii_case(&expected_with_port)
        } else {
            self.label.eq_ignore_ascii_case(&expected_with_port)
        }
    }
}

/// In-process cache of the on-disk file. Keyed by (host, port) for fast
/// lookups; the source-of-truth on disk is rewritten whenever this cache
/// is modified.
pub struct KnownHostsStore {
    path: PathBuf,
    entries: Vec<KnownHostEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VerifyOutcome {
    /// No record exists yet. Caller should accept + save.
    FirstSeen,
    /// Record exists and matches the presented key. Accept silently.
    Match,
    /// Record exists but the key is DIFFERENT. Reject hard.
    Mismatch { stored_fingerprint: String },
}

// ---------------------------------------------------------------------
// Global singleton — one store per process, loaded lazily on first call.
// ---------------------------------------------------------------------

pub static STORE: Lazy<Arc<Mutex<Option<KnownHostsStore>>>> =
    Lazy::new(|| Arc::new(Mutex::new(None)));

#[allow(dead_code)] // public lazy accessor for the known-hosts store (kept for API completeness)
pub async fn store() -> Result<&'static Arc<Mutex<Option<KnownHostsStore>>>, AppError> {
    let mut guard = STORE.lock().await;
    if guard.is_none() {
        *guard = Some(KnownHostsStore::load()?);
    }
    drop(guard);
    Ok(&STORE)
}

// ---------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------

fn default_path() -> Result<PathBuf, AppError> {
    let home = dirs::home_dir().ok_or_else(|| {
        AppError::new("no_home_dir", "could not determine user home directory")
    })?;
    let dir = home.join(".netsphere");
    fs::create_dir_all(&dir).map_err(|e| {
        AppError::new("mkdir_failed", format!("creating {}: {}", dir.display(), e))
    })?;
    Ok(dir.join("known_hosts"))
}

// ---------------------------------------------------------------------
// Store impl
// ---------------------------------------------------------------------

impl KnownHostsStore {
    pub fn load() -> Result<Self, AppError> {
        let path = default_path()?;
        let entries = if path.exists() {
            parse_file(&path)?
        } else {
            Vec::new()
        };
        tracing::info!(
            path = %path.display(),
            count = entries.len(),
            "known_hosts loaded"
        );
        Ok(Self { path, entries })
    }

    /// Look up the stored key (if any) for a given host:port.
    pub fn lookup(&self, host: &str, port: u16) -> Option<&KnownHostEntry> {
        self.entries.iter().find(|e| e.matches(host, port))
    }

    /// Verify the presented key against any stored entry.
    pub fn verify(&self, host: &str, port: u16, presented: &PublicKey) -> VerifyOutcome {
        let presented_b64 = encode_public_key(presented);
        match self.lookup(host, port) {
            None => VerifyOutcome::FirstSeen,
            Some(entry) => {
                if entry.key_b64 == presented_b64 {
                    VerifyOutcome::Match
                } else {
                    VerifyOutcome::Mismatch {
                        stored_fingerprint: fingerprint_sha256(&entry.key_b64),
                    }
                }
            }
        }
    }

    /// Add a brand-new entry. Returns an error if one already exists for
    /// this host (use `forget` first, or `replace`).
    pub fn add(&mut self, host: &str, port: u16, key: &PublicKey) -> Result<(), AppError> {
        if self.lookup(host, port).is_some() {
            return Err(AppError::new(
                "host_already_known",
                format!("entry for {host}:{port} already exists; forget it first"),
            ));
        }
        let label = if port == 22 { host.to_string() } else { format!("[{}]:{}", host, port) };
        let entry = KnownHostEntry {
            label,
            algo: key.name().to_string(),
            key_b64: encode_public_key(key),
        };
        self.entries.push(entry);
        self.persist()
    }

    /// Remove all entries matching a host:port. Returns the number removed.
    pub fn forget(&mut self, host: &str, port: u16) -> Result<usize, AppError> {
        let before = self.entries.len();
        self.entries.retain(|e| !e.matches(host, port));
        let removed = before - self.entries.len();
        if removed > 0 {
            self.persist()?;
        }
        Ok(removed)
    }

    /// Get the SHA256 fingerprint for a stored host, if any.
    pub fn fingerprint(&self, host: &str, port: u16) -> Option<String> {
        self.lookup(host, port).map(|e| fingerprint_sha256(&e.key_b64))
    }

    /// All entries as (host_label, algo, fingerprint) tuples for UI display.
    pub fn list(&self) -> Vec<(String, String, String)> {
        self.entries.iter()
            .map(|e| (e.label.clone(), e.algo.clone(), fingerprint_sha256(&e.key_b64)))
            .collect()
    }

    fn persist(&self) -> Result<(), AppError> {
        let tmp = self.path.with_extension("tmp");
        {
            let mut f = fs::File::create(&tmp).map_err(|e| {
                AppError::new("write_failed", format!("creating {}: {}", tmp.display(), e))
            })?;
            for entry in &self.entries {
                writeln!(f, "{} {} {}", entry.label, entry.algo, entry.key_b64)
                    .map_err(|e| AppError::new("write_failed", format!("writing: {e}")))?;
            }
            f.sync_all().ok();
        }
        fs::rename(&tmp, &self.path).map_err(|e| {
            AppError::new("rename_failed", format!("renaming to {}: {}", self.path.display(), e))
        })?;
        // Restrict permissions on unix (mirror ~/.ssh/known_hosts)
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&self.path, fs::Permissions::from_mode(0o600));
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------
// File parsing
// ---------------------------------------------------------------------

fn parse_file(path: &PathBuf) -> Result<Vec<KnownHostEntry>, AppError> {
    let file = fs::File::open(path).map_err(|e| {
        AppError::new("read_failed", format!("opening {}: {}", path.display(), e))
    })?;
    let reader = BufReader::new(file);
    let mut entries = Vec::new();
    for (idx, line) in reader.lines().enumerate() {
        let line = line.map_err(|e| {
            AppError::new("read_failed", format!("reading {}:{}: {}", path.display(), idx + 1, e))
        })?;
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        // <label> <algo> <key>
        let mut parts = trimmed.splitn(3, char::is_whitespace);
        let (label, algo, key_b64) = match (parts.next(), parts.next(), parts.next()) {
            (Some(a), Some(b), Some(c)) if !c.is_empty() => (a, b, c),
            _ => {
                tracing::warn!(line = idx + 1, "skipping malformed known_hosts line");
                continue;
            }
        };
        entries.push(KnownHostEntry {
            label: label.to_string(),
            algo: algo.to_string(),
            key_b64: key_b64.split_whitespace().next().unwrap_or("").to_string(),
        });
    }
    Ok(entries)
}

// ---------------------------------------------------------------------
// Key encoding helpers
// ---------------------------------------------------------------------

/// SSH public-key wire format → base64. This is what goes after the algo
/// name in a known_hosts line.
fn encode_public_key(key: &PublicKey) -> String {
    // `PublicKeyBase64::public_key_base64()` returns the base64 of the
    // SSH wire-format bytes — exactly what OpenSSH writes after the algo
    // name in known_hosts.
    key.public_key_base64()
}

/// SHA256 fingerprint in the OpenSSH format: "SHA256:<base64 no padding>".
pub fn fingerprint_sha256(key_b64: &str) -> String {
    let bytes = match B64.decode(key_b64) {
        Ok(b) => b,
        Err(_) => return "SHA256:<invalid>".to_string(),
    };
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    let digest = hasher.finalize();
    // OpenSSH-style: base64 without padding
    let no_pad = B64.encode(digest).trim_end_matches('=').to_string();
    format!("SHA256:{}", no_pad)
}

// Silence "unused" warning for less-common helper signatures
#[allow(dead_code)]
fn _unused_marker(_: HashMap<(), ()>) {}
