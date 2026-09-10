# Phase 3 Report — Remote Access Security

**Branch:** `claude/nifty-johnson-u2dwye`
**Scope:** SSH host-key verification, remote path handling, secret redaction,
residual WebSocket token transport.

---

## AWM-SEC-008 — SSH host keys accepted blindly (no verification)

- **Severity:** P2 (→ P1 on a hostile network) · **Status:** FIXED
- **Affected files:** `backend/migrations/021_host_keys.{up,down}.sql`,
  `backend/src/ssh/hostKeys.ts` (new), `backend/src/ssh/gateway.ts`,
  `sftpGateway.ts`, `wsTunnelGateway.ts`, `tunnelManager.ts`,
  `backend/src/server.ts`.
- **Root cause:** all four ssh2 connect sites used `hostVerifier: () => true`,
  accepting **any** server host key on **every** connection and never detecting
  a change — a man-in-the-middle presenting a substitute key was trusted
  silently, defeating SSH's core protection.
- **Fix implemented:** a shared pin store (`host_keys` table, migration 021)
  keyed by `(hostname, port)`. `HostKeyRepository.verify` returns `new` (first
  sighting → pinned, TOFU), `match` (same fingerprint → trusted, `last_seen`
  bumped), or `mismatch` (changed → refused). `makeHostVerifier` (OpenSSH-style
  `SHA256:` fingerprint) is now the `hostVerifier` on the interactive SSH,
  SFTP, WS-tunnel and server-managed tunnel connect paths. A changed key is
  **rejected** with a `SECURITY` log line naming the fingerprint; a legitimate
  rotation is re-pinned by deleting the host's row (documented trusted
  workflow). The pin-store path fails **open** only on a store *error* (a
  pinning-DB outage must not down all remote access); a definite mismatch
  always fails closed.
- **Tests added:** `hostKeys.test.ts` (5, unit — fingerprint determinism +
  accept/pin/refuse/fail-open decisions) and `hostKeys.itest.ts` (1, real PG —
  new→match→mismatch, per-port isolation, re-pin after delete).
- **Test result:** PASS (unit 5/5, integration 1/1).
- **Regression risk:** Low. First connection to any host still succeeds (TOFU);
  only a *changed* key now breaks — which is the intended security behaviour.
- **Remaining concern:** no in-app "trust the new key" button yet (re-pin is a
  DB row delete). Queued as a UX follow-up; the security default (refuse) is
  correct meanwhile.

## AWM-SEC-014 — Secret redaction in logs

- **Severity:** P3 · **Status:** VERIFIED + HARDENED
- **Finding verification:** the pino logger already redacts
  `authorization`/`cookie` headers, `password`, `secret`, `secretData`,
  `secret_data`, `token`, `accessToken`, `refreshToken`, `privateKey`,
  `passphrase`, `config` (both bare and one-level `*.`). A scan of all
  `log.*`/`console.*` calls found **no secret logged via string interpolation**
  (only safe fields: ids, emails, error messages). No plaintext-secret log path
  exists.
- **Hardening:** added defensive redaction for `private_key`, `api_key`/
  `apiKey`, `credential`, `password_hash`, `otp` (bare + `*.`).
- **Test result:** existing suites green; redaction is config-level.

## AWM-SEC-012 — SFTP / remote path traversal

- **Severity:** — · **Status:** FALSE POSITIVE (for backend traversal)
- **Analysis:** SFTP operations (`readFile`/`writeFile`/list) act on the
  **remote host's** filesystem through the user's own SSH session, which the
  target server access-controls; the user already has shell/SFTP rights there,
  so navigating that host's paths is by design for a remote-admin product.
  Awamer's backend never uses a user-supplied path against its **own**
  filesystem, and credential attachments are stored as encrypted **DB blobs**
  (no filesystem path). There is therefore no directory-escape vector on the
  Awamer server. No jail/chroot is part of the product security model, so
  nothing to enforce.

## AWM-SEC-001 (residual) — token still in URL for non-SSH gateways

- **Severity:** P3 (residual) · **Status:** MITIGATED / ACCEPTED this cycle
- **State:** the SSH gateway (which also carried the SSH password) is fully
  converted to channel-auth (Phase 1). The telnet/vnc/sftp/ws-tunnel gateways
  still accept the short-lived (15m) access token as a URL query param.
- **Mitigation in place:** nginx now logs request paths only
  (`log_format noquery`, Phase 1), so no gateway writes a token to the access
  log. Residual exposure is limited to browser history for those endpoints.
- **Decision:** converting the remaining four gateways + their web clients to
  channel-auth is mechanical but broad, and can't be E2E-validated here; queued
  as a follow-up. The password (the only long-lived secret that ever transited
  a URL) is already off the URL entirely.

---

## Phase 3 verification summary

| Check | Result |
| --- | --- |
| Migration 021 apply (real PG 16) | ✅ PASS |
| Backend `tsc --noEmit` | ✅ PASS |
| Backend unit (`npm test`) | ✅ PASS (73/73) |
| Backend integration (real PG) | ✅ PASS (9/9) |
| Host-key change refused | ✅ verified (unit + integration) |
| Secrets in logs | ✅ none; redaction hardened |
