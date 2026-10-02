//! SSH client helpers shared by the terminal (ssh.rs) and SFTP (sftp.rs)
//! connections — the only place that touches version-specific russh APIs
//! (russh 0.63: keys live in `russh::keys`, host keys arrive as
//! `PublicKeyOrCertificate`, authentication returns `AuthResult`).

use std::sync::Arc;

use russh::client::{Handle, Handler};
use russh::keys::{PrivateKey, PrivateKeyWithHashAlg, PublicKey, PublicKeyOrCertificate};

use crate::errors::AppError;

/// The key to pin / verify for TOFU. russh 0.45 only ever negotiated plain
/// host keys; 0.63 may receive an OpenSSH host *certificate*. TOFU pins the
/// certificate's underlying public key, so known_hosts semantics are unchanged.
pub fn presented_host_key(k: &PublicKeyOrCertificate) -> PublicKey {
    match k {
        PublicKeyOrCertificate::PublicKey { key, .. } => key.clone(),
        PublicKeyOrCertificate::Certificate(cert) => PublicKey::new(cert.public_key().clone(), ""),
    }
}

/// SSH wire-format → base64: exactly the field OpenSSH writes after the
/// algorithm name in known_hosts / *.pub (format-compatible with entries
/// pinned by earlier releases).
pub fn public_key_base64(key: &PublicKey) -> String {
    let openssh = key.to_openssh().unwrap_or_default();
    openssh.split_whitespace().nth(1).unwrap_or_default().to_string()
}

/// Decode a PEM/OpenSSH private key, mapping the common failures to the
/// error codes the renderer understands.
pub fn decode_private_key(pem: &str, passphrase: Option<&str>) -> Result<PrivateKey, AppError> {
    russh::keys::decode_secret_key(pem, passphrase).map_err(|e| {
        let code = match e {
            russh::keys::Error::KeyIsEncrypted => "key_passphrase_required",
            russh::keys::Error::CouldNotReadKey => "key_invalid_passphrase",
            // russh 0.63 surfaces a wrong passphrase on an OpenSSH-encrypted key
            // as an ssh-key decryption error (0.45 said CouldNotReadKey): if a
            // passphrase was given and the key is encrypted, it was wrong.
            _ if passphrase.is_some()
                && matches!(russh::keys::decode_secret_key(pem, None), Err(russh::keys::Error::KeyIsEncrypted)) =>
            {
                "key_invalid_passphrase"
            }
            _ => "key_decode_failed",
        };
        AppError::new(code, format!("decode key: {e}"))
    })
}

/// Public-key authentication (negotiates the RSA signature hash the server
/// supports; ignored for non-RSA keys). Ok(true) = accepted.
pub async fn authenticate_with_key<H: Handler>(
    handle: &mut Handle<H>,
    user: &str,
    key: PrivateKey,
) -> Result<bool, russh::Error> {
    let hash = handle.best_supported_rsa_hash().await?.flatten();
    let res = handle
        .authenticate_publickey(user, PrivateKeyWithHashAlg::new(Arc::new(key), hash))
        .await?;
    Ok(res.success())
}

/// Password authentication. Ok(true) = accepted.
pub async fn authenticate_with_password<H: Handler>(
    handle: &mut Handle<H>,
    user: &str,
    password: &str,
) -> Result<bool, russh::Error> {
    Ok(handle.authenticate_password(user, password).await?.success())
}

/// ssh-agent authentication: try each identity the agent offers; the first
/// one the server accepts wins. Ok(false) = all rejected.
pub async fn authenticate_with_agent<H: Handler>(
    handle: &mut Handle<H>,
    user: &str,
    sock: &str,
) -> Result<bool, AppError> {
    let mut agent = russh::keys::agent::client::AgentClient::connect_uds(sock)
        .await
        .map_err(|e| AppError::new("ssh_agent_connect_failed", format!("could not connect to ssh-agent at {sock}: {e}")))?;
    let identities = agent
        .request_identities()
        .await
        .map_err(|e| AppError::new("ssh_agent_query_failed", format!("failed to list agent identities: {e}")))?;
    if identities.is_empty() {
        return Err(AppError::new(
            "ssh_agent_no_identities",
            "ssh-agent has no keys loaded (try `ssh-add ~/.ssh/id_ed25519`)",
        ));
    }
    let hash = handle
        .best_supported_rsa_hash()
        .await
        .map_err(|e| AppError::new("ssh_agent_auth_failed", format!("authenticate via agent: {e}")))?
        .flatten();
    for ident in &identities {
        let key = ident.public_key().into_owned();
        match handle.authenticate_publickey_with(user, key, hash, &mut agent).await {
            Ok(r) if r.success() => return Ok(true),
            Ok(_) => { /* try the next identity */ }
            Err(e) => {
                return Err(AppError::new("ssh_agent_auth_failed", format!("authenticate via agent: {e:?}")));
            }
        }
    }
    Ok(false)
}
