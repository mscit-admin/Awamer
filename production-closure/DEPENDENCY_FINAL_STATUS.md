# Dependency Final Status

Tools executed this phase:
- `npm audit --json` and `npm audit --omit=dev --json` for `backend/` and `desktop/`;
- `cargo audit` 0.22.2 against the RustSec advisory DB for `desktop/src-tauri/Cargo.lock`.

## Summary

| Ecosystem | Critical | High | Moderate | Runtime-reachable High/Critical in production |
|---|---:|---:|---:|---|
| Backend runtime (npm) | 0 | 2 | 1 | **none** (below) |
| Frontend runtime (npm) | 0 | 0 | 2 | — |
| Frontend dev tooling (npm) | 1 | 1 | 3 | none (dev only) |
| Desktop Rust (cargo) | — | 2 (quick-xml) | 1 (rsa, CVSS 5.9) | **none.** The **russh advisories are closed** |

## Change this phase: russh 0.45 → 0.63.3 (`RUSTSEC-2026-0153`, `RUSTSEC-2026-0154`)

- **Advisory.**
  - Unbounded 32-bit allocation (russh) and unchecked `CryptoVec` growth (russh-cryptovec).
  - Patched in ≥ 0.60.3.
  - Verified independently: `cargo info russh` shows 0.63.3 as latest, and `cargo audit` shows the advisories against 0.45.0.
- **Exploit precondition.** The user connects the desktop native SSH/SFTP client to a malicious or compromised SSH server.
- **Affected component.** The desktop client only (`desktop/src-tauri/src/commands/{ssh,sftp,known_hosts}.rs`). The server side uses `ssh2` in Node.
- **Exposure.** Client-side denial of service (memory exhaustion).
- **Feasibility.** Assessed by trial-compiling against 0.63 in a scratch copy: 11 errors, all mechanical.
- **Change.**
  - The version-specific APIs live in one new module, `ssh_auth.rs`:
    - keys via `russh::keys`;
    - host key received as `PublicKeyOrCertificate`, pinning the certificate's key so TOFU semantics are unchanged;
    - `AuthResult`;
    - agent `Signer`.
  - The `russh-keys` crate was removed.
  - known_hosts encoding uses the OpenSSH key-blob format.
- **Verification.**
  - `cargo check --locked` is clean with no warnings.
  - **Live test against OpenSSH 9** (`ssh_live_test.rs` with `tests/ssh-live-setup.sh`):
    - TOFU pin is byte-identical to OpenSSH's `.pub` blob, so existing known_hosts entries keep matching;
    - ed25519, RSA (rsa-sha2), encrypted-key, password and **ssh-agent** auth;
    - exec round-trip;
    - SFTP subsystem;
    - a **changed host key is refused** by both the SSH and SFTP handlers, and the correct fingerprints are reported.
  - The test caught one migration regression, which was fixed: a wrong passphrase was mis-reported as `key_decode_failed`.
  - The test is wired into CI.
- **Side effect to note.** russh 0.63 depends on **prerelease** crypto crates (`ssh-key 0.7.0-rc.11`, `rsa 0.10.0-rc.18`). This is upstream's choice. Re-evaluate when stable releases ship (OR-06).

## Remaining advisories

| Package | Installed | Severity | Runtime reachable? | Production impact | Fix available? | Breaking? | Action |
|---|---|---|---|---|---|---|---|
| @fastify/static (via @fastify/swagger-ui) | 9.3.0 | High | **No.** Production now **refuses** `ENABLE_API_DOCS` at startup, and the Swagger modules are **imported only when docs are enabled**, so the code is never loaded in production | none | swagger-ui 6.1.1 | major | Upgrade in a maintenance window (dev-only feature) |
| @fastify/swagger-ui | 5.2.6 | Moderate | No (same) | none | 6.1.1 | major | same |
| node-forge | 1.4.0 | High (RSA PKCS#1 **signature verification**) | **No.** Production code only creates and signs certificates; the only `verify` call is in a test | none | **no upstream fix** | — | Accept; consider moving the PKI to `node:crypto` / `@peculiar/x509` (OR-07) |
| react-router / react-router-dom | 6.30.6 | Moderate (backslash open redirect; SSR hydration) | Not with attacker input: every navigation target is a constant or a server UUID; no SSR | low | 7.18.4 | major | Plan the v7 migration |
| vitest / @vitest/mocker / vite-node | 2.1.9 | Critical / moderate | **No.** Dev/test tooling | none | vitest 5 | major | Toolchain upgrade |
| vite / esbuild | 5.4.21 | High / moderate | **No.** Dev server only; production ships static files | none | vite 8 | major | Toolchain upgrade |
| quick-xml | 0.39.4 | High (A:H) | **No.** Build-time `plist` inside Tauri codegen | none | ≥0.41 via Tauri | — | Upgrade with Tauri |
| rsa | 0.10.0-rc.18 | Medium, RUSTSEC-2023-0071 (Marvin; CVSS 5.9, AC:H) | Desktop RSA client-key signing | Needs many timed private-key operations; negligible for interactive SSH auth | **none upstream** | — | Accept; recommend Ed25519 client keys |

## CI gate

- **Blocking:**
  - `npm audit --omit=dev --audit-level=critical` for backend and desktop;
  - `cargo check --locked`;
  - the live SSH test.
- **Report-only:** HIGH runtime npm advisories and `cargo audit`. These are reviewed against this triage.
