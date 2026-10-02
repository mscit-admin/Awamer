//! Live SSH regression test for the russh 0.63 migration (RUSTSEC-2026-0153/0154).
//!
//! Drives the REAL desktop SSH code paths — the TOFU `ClientHandler`s from
//! ssh.rs / sftp.rs, the shared known_hosts store and the ssh_auth helpers —
//! against a real OpenSSH server started by `tests/ssh-live-setup.sh`.
//! Skips (passes trivially) when `AWAMER_SSH_TEST_PORT` is not set.
//!
//!   SSH-LIVE-001 first connect pins the host key in OpenSSH known_hosts format
//!   SSH-LIVE-002 ed25519 + RSA public-key auth, password auth (good/bad)
//!   SSH-LIVE-003 encrypted keys map to passphrase_required / invalid_passphrase
//!   SSH-LIVE-004 exec channel round-trips data
//!   SSH-LIVE-005 reconnect with the pinned key matches
//!   SSH-LIVE-006 a CHANGED host key is REFUSED (MITM protection) and reported
//!   SSH-LIVE-007 SFTP subsystem works through the SFTP handler
//!   SSH-LIVE-008 ssh-agent authentication

use std::sync::Arc;

use russh::client::{self, Config};
use russh::ChannelMsg;

use crate::commands::{known_hosts, sftp, ssh, ssh_auth};

struct Live {
    port: u16,
    dir: String,
    user: String,
    password: String,
}

fn live() -> Option<Live> {
    Some(Live {
        port: std::env::var("AWAMER_SSH_TEST_PORT").ok()?.parse().ok()?,
        dir: std::env::var("AWAMER_SSH_TEST_DIR").ok()?,
        user: std::env::var("AWAMER_SSH_TEST_USER").ok()?,
        password: std::env::var("AWAMER_SSH_TEST_PASSWORD").ok()?,
    })
}

fn cfg() -> Arc<Config> {
    Arc::new(Config { inactivity_timeout: Some(std::time::Duration::from_secs(30)), ..Default::default() })
}

async fn connect(l: &Live) -> Result<client::Handle<ssh::ClientHandler>, russh::Error> {
    let h = ssh::ClientHandler { host: "127.0.0.1".into(), port: l.port };
    client::connect(cfg(), ("127.0.0.1", l.port), h).await
}

fn read(path: &str) -> String {
    std::fs::read_to_string(path).unwrap_or_else(|e| panic!("read {path}: {e}"))
}

async fn exec(handle: &client::Handle<ssh::ClientHandler>, cmd: &str) -> String {
    let mut ch = handle.channel_open_session().await.expect("channel");
    ch.exec(true, cmd).await.expect("exec");
    let mut out = Vec::new();
    while let Some(msg) = ch.wait().await {
        match msg {
            ChannelMsg::Data { ref data } => out.extend_from_slice(data),
            ChannelMsg::Eof | ChannelMsg::Close => break,
            _ => {}
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[tokio::test(flavor = "multi_thread")]
async fn ssh_live_regression() {
    let Some(l) = live() else {
        eprintln!("SKIP ssh_live_regression: AWAMER_SSH_TEST_PORT not set (run tests/ssh-live-setup.sh)");
        return;
    };
    // Isolated known_hosts: the store resolves ~/.netsphere/known_hosts.
    let home = format!("{}/home-{}", l.dir, std::process::id());
    std::fs::create_dir_all(&home).unwrap();
    std::env::set_var("HOME", &home);
    let kh_path = format!("{home}/.netsphere/known_hosts");

    // SSH-LIVE-001: TOFU pin, stored exactly as OpenSSH writes the key.
    let mut handle = connect(&l).await.expect("first connect (TOFU) must succeed");
    let host_pub = read(&format!("{}/host_ed25519.pub", l.dir));
    let host_b64 = host_pub.split_whitespace().nth(1).unwrap();
    let kh = read(&kh_path);
    assert!(kh.contains(&format!("[127.0.0.1]:{} ssh-ed25519 {host_b64}", l.port)), "known_hosts entry: {kh}");

    // SSH-LIVE-002/004: public-key auth (ed25519) + exec round-trip.
    let key = ssh_auth::decode_private_key(&read(&format!("{}/user_ed25519", l.dir)), None).unwrap();
    assert!(ssh_auth::authenticate_with_key(&mut handle, &l.user, key).await.unwrap(), "ed25519 key accepted");
    assert_eq!(exec(&handle, "echo awamer-live-ok").await.trim(), "awamer-live-ok");

    // RSA (exercises the rsa-sha2 hash negotiation).
    let mut h2 = connect(&l).await.expect("reconnect (SSH-LIVE-005 match)");
    let rsa = ssh_auth::decode_private_key(&read(&format!("{}/user_rsa", l.dir)), None).unwrap();
    assert!(ssh_auth::authenticate_with_key(&mut h2, &l.user, rsa).await.unwrap(), "RSA key accepted");

    // Password: wrong rejected, right accepted.
    let mut h3 = connect(&l).await.unwrap();
    assert!(!ssh_auth::authenticate_with_password(&mut h3, &l.user, "definitely-wrong").await.unwrap());
    let mut h4 = connect(&l).await.unwrap();
    assert!(ssh_auth::authenticate_with_password(&mut h4, &l.user, &l.password).await.unwrap());

    // SSH-LIVE-003: encrypted key error mapping (renderer contract).
    let enc = read(&format!("{}/user_enc", l.dir));
    assert_eq!(ssh_auth::decode_private_key(&enc, None).unwrap_err().code, "key_passphrase_required");
    assert_eq!(ssh_auth::decode_private_key(&enc, Some("wrong")).unwrap_err().code, "key_invalid_passphrase");
    let mut h5 = connect(&l).await.unwrap();
    let k = ssh_auth::decode_private_key(&enc, Some("correct-pass")).unwrap();
    assert!(ssh_auth::authenticate_with_key(&mut h5, &l.user, k).await.unwrap());

    // SSH-LIVE-007: SFTP through the SFTP module's own TOFU handler.
    let sh = sftp::ClientHandler { host: "127.0.0.1".into(), port: l.port };
    let mut sh = client::connect(cfg(), ("127.0.0.1", l.port), sh).await.expect("sftp connect (pinned key matches)");
    let key = ssh_auth::decode_private_key(&read(&format!("{}/user_ed25519", l.dir)), None).unwrap();
    assert!(ssh_auth::authenticate_with_key(&mut sh, &l.user, key).await.unwrap());
    let ch = sh.channel_open_session().await.unwrap();
    ch.request_subsystem(true, "sftp").await.unwrap();
    let sftp = russh_sftp::client::SftpSession::new(ch.into_stream()).await.expect("sftp handshake");
    assert!(sftp.canonicalize(".").await.unwrap().starts_with('/'));
    let _ = sftp.read_dir("/").await.expect("sftp read_dir");

    // SSH-LIVE-008: ssh-agent (when an agent socket was prepared).
    if let Ok(sock) = std::env::var("AWAMER_SSH_TEST_AGENT_SOCK") {
        let mut h6 = connect(&l).await.unwrap();
        assert!(ssh_auth::authenticate_with_agent(&mut h6, &l.user, &sock).await.unwrap(), "agent identity accepted");
    }

    // SSH-LIVE-006: swap the pinned key for a different one → MITM refusal.
    {
        let store = known_hosts::STORE.clone();
        *store.lock().await = None; // reload from disk below
    }
    let other = read(&format!("{}/user_ed25519.pub", l.dir));
    let other_b64 = other.split_whitespace().nth(1).unwrap();
    std::fs::write(&kh_path, kh.replace(host_b64, other_b64)).unwrap();
    *ssh::LAST_HOST_KEY_CHANGE.lock().unwrap() = None;
    let refused = connect(&l).await;
    assert!(refused.is_err(), "a changed host key MUST be refused");
    let details = ssh::LAST_HOST_KEY_CHANGE.lock().unwrap().clone().expect("host-key change reported");
    assert_eq!(details.stored_fingerprint, known_hosts::fingerprint_sha256(other_b64));
    assert_eq!(details.presented_fingerprint, known_hosts::fingerprint_sha256(host_b64));
    // The SFTP handler refuses too.
    let sh = sftp::ClientHandler { host: "127.0.0.1".into(), port: l.port };
    assert!(client::connect(cfg(), ("127.0.0.1", l.port), sh).await.is_err(), "SFTP must refuse a changed key");
}
