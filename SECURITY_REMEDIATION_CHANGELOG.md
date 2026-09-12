# Security Remediation Changelog

Per-finding record of the remediation program. Baseline in
`SECURITY_REMEDIATION_BASELINE.md`.

---

## SEC-RESET-001 — Password-reset link host/origin poisoning  (Phase 1)

- **Files modified:**
  - `backend/src/usecases/publicBaseUrl.ts` (new) — trusted base URL validation
    + resolution + startup assertion.
  - `backend/src/config/index.ts` — `APP_PUBLIC_BASE_URL` env; validated
    `config.publicBaseUrl` (invalid value fails startup).
  - `backend/src/usecases/passwordReset.ts` — resolve link base from trusted
    config only; production fail-closed when none; removed header fallback param.
  - `backend/src/routes/passwordReset.ts` — removed `originOf()`; no request
    headers passed to the usecase.
  - `backend/src/server.ts` — pass config to the usecase; startup fail-closed
    assertion (`assertResetEmailBaseUrl`).
  - `backend/src/crypto/secretBox.test.ts` — Config literal updated.
  - `deploy/scripts/install.sh`, `deploy/.env.production.example` — installer
    sets `APP_PUBLIC_BASE_URL` from the selected domain+port.
- **Root cause:** reset-link base URL fell back to attacker-controllable request
  headers (`Origin`/`Referer`/`Host`/`X-Forwarded-Host`/`X-Forwarded-Proto`)
  when the DB `app_base_url` setting was blank.
- **Fix:** reset links are built ONLY from a validated trusted base URL
  (`APP_PUBLIC_BASE_URL` env, else a valid `app_base_url` setting). Request
  headers are never consulted. Production fails closed (no email, audited) when
  no trusted base is configured; dev/test uses an explicit localhost default.
  URL validation requires https (http only in dev), a real hostname, and rejects
  embedded credentials and non-http(s) schemes.
- **Tests added:** RESET-HOST-001..008 (+ precedence) — 7 tests,
  `backend/src/usecases/passwordResetHost.test.ts`.
- **Test result:** PASS (7/7). Backend unit 99→106, integration 108 unchanged;
  deploy install-sim + security-port PASS.
- **Migration required:** none.
- **Operational impact:** production deployments should set `APP_PUBLIC_BASE_URL`
  (the installer now does so automatically from the chosen domain+port). If email
  is enabled in production without it, reset requests fail closed.
- **Remaining risk:** none for this vector; reset links can no longer be poisoned.

---

## SEC-TENANT-001 — Null-company tenant escape  (Phase 2)

- **Files modified:** `backend/src/domain/tenantScope.ts` (new — explicit
  `TenantScope` type + `tenantScopeForActor`); `backend/src/repos/userRepo.ts`
  (`list` takes explicit scope); `backend/src/repos/otherRepos.ts`
  (`AuditRepository.list` takes explicit scope, fails closed on none);
  `backend/src/repos/roleRepo.ts` (`listForScope` replaces `listForCompany`;
  none → built-ins only); `backend/src/repos/sessionRepos.ts` +
  `backend/src/repos/notesRepo.ts` (`setShares` forbids null-company sharing —
  no more `IS NOT DISTINCT FROM NULL`); callers `routes/admin.ts`,
  `routes/users.ts`, `routes/audit.ts`, `routes/roles.ts`.
- **Root cause:** a non-super user with `company_id=NULL` collapsed onto the
  same `null`/`undefined` sentinel Super Admins used for "global", so the
  company filter was dropped and every tenant's rows were returned (users,
  audit, custom roles); `setShares` `IS NOT DISTINCT FROM NULL` let null-company
  users share across the "null tenant".
- **Fix:** global access is now EXPLICIT via `TenantScope` (global | company |
  none). A non-super actor with no company resolves to `none`, which the
  repositories treat as an EMPTY/forbidden result — never global. Super Admin
  global access is preserved; company users remain confined to their company.
- **Tests added:** TENANT-NULL-001..010 (+ residual null-company share) — 10
  tests, `backend/src/repos/tenantNullScope.itest.ts`.
- **Test result:** PASS (10/10). Backend unit 106, integration 108→118. Existing
  tenant-isolation / RBAC suites unchanged and green.
- **Migration required:** none.
- **Operational impact:** a non-super account with no company now sees nothing
  tenant-scoped (previously it saw everything). Assign such accounts a company.
- **Remaining risk:** none for the null-company escape; global access requires an
  explicit permission-derived scope.

---

## SEC-SESSION-001 — Security changes invalidate all sessions  (Phase 3)

- **Files modified:** migration `027_auth_version.{up,down}.sql` (new);
  `backend/src/domain/index.ts` (User.authVersion); `backend/src/repos/userRepo.ts`
  (auth_version column + `incrementAuthVersion`); `backend/src/jwt/index.ts`
  (access-token `av` claim; `issuePair(..,authVersion)`); `backend/src/middleware/auth.ts`
  (AuthUserState.authVersion + live `av` comparison → session_invalidated);
  `backend/src/usecases/{login,refresh}.ts` (thread live authVersion);
  `backend/src/usecases/changePassword.ts`, `passwordReset.ts`, `mfa.ts`
  (increment auth_version + revoke refresh + `ActiveSessionManager.revokeUser`);
  `backend/src/session/activeSessions.ts` (`SessionRevoker` iface +
  `CREDENTIALS_CHANGED` reason); `server.ts` wiring; test mocks updated.
- **Root cause:** password change / forgot-reset / admin reset revoked refresh
  tokens only — old access tokens stayed valid up to 15m and live
  SSH/Telnet/Tunnel/VNC sessions survived; MFA changes did neither.
- **Fix:** per-user `auth_version` pinned into access tokens (`av`) and compared
  live on every request; a security-sensitive change (password change/reset/
  admin reset, MFA activation/replacement/disable) increments it, revokes all
  refresh sessions, and terminates live remote sessions. `av` is signed →
  cannot be forged or downgraded by the client.
- **Tests added:** AUTH-INVALIDATE-001..015 — 12 tests,
  `backend/src/usecases/authInvalidate.itest.ts` (real DB + real
  ActiveSessionManager + real auth middleware).
- **Test result:** PASS (12/12). Backend unit 106, integration 118→130.
- **Migration required:** yes — `027_auth_version` adds `users.auth_version`
  (default 1; safe/idempotent). On deploy, tokens issued before the change keep
  working (legacy tokens map to av=1) until the next credential change.
- **Operational impact:** after any credential/MFA change users must re-login
  everywhere; live remote sessions drop immediately.
- **Remaining risk:** none for this vector.

---

## SEC-MFA-001 — TOTP secrets encrypted at rest  (Phase 4)

- **Files modified:** `backend/src/crypto/secretBox.ts` (`isSealedBytes`);
  `backend/src/usecases/mfa.ts` (seal on enroll / open on verify, fail-closed);
  `backend/src/repos/otherRepos.ts` (`listAllSecrets`, `updateSecret`);
  `backend/src/usecases/mfaMigration.ts` (new — idempotent startup re-encryption);
  `backend/src/server.ts` (inject secretBox; run migration at startup).
- **Root cause:** `mfa_devices.secret_enc` stored the raw base32 TOTP secret as
  UTF-8 (plaintext) despite its name.
- **Fix:** the secret is sealed with the existing AES-256-GCM binary envelope
  (`sealBytes`, random nonce, AEAD integrity) and opened on verify. Legacy rows
  are detected (`isSealedBytes`) and re-encrypted in place by an idempotent,
  restart-safe startup migration that logs only counts (never seed content). In
  production the encryption key is mandatory (`resolveSecretKey` throws), so a
  missing/wrong key fails closed — no plaintext fallback.
- **Tests added:** MFA-CRYPT-001..008 — 6 tests, `mfaCrypt.itest.ts`.
- **Test result:** PASS. Backend integration 130→(with MFA-STEPUP)144.
- **Migration required:** in-code startup migration (no SQL migration needed).
- **Operational impact:** existing authenticators keep working (secrets migrated
  transparently on first boot after upgrade).
- **Remaining risk:** none; secrets are AEAD-encrypted at rest.

## SEC-MFA-002 — Step-up authentication for MFA changes  (Phase 4)

- **Files modified:** `backend/src/jwt/index.ts` (`step_up` token type +
  `issueStepUp`/`verifyStepUp`); `backend/src/usecases/stepUp.ts` (new —
  short-lived, single-purpose, single-use step-up tokens);
  `backend/src/usecases/mfa.ts` (`disableAfterStepUp`); `backend/src/routes/users.ts`
  (`POST /auth/step-up`; enroll + disable require step-up); `server.ts` wiring.
- **Root cause:** MFA enroll/activate required only a normal access token, so a
  stolen access token could add/replace an authenticator.
- **Fix:** MFA enroll and disable now require a step-up token obtained from
  `POST /auth/step-up`, which re-verifies the password AND the current MFA code
  (when MFA is enabled). Step-up tokens are 5-minute, purpose-bound
  (`mfa_change`), user-bound, and single-use (consumed jti set).
- **Tests added:** MFA-STEPUP-001..008 — 8 tests, `mfaStepUp.itest.ts`.
- **Test result:** PASS (8/8).
- **Migration required:** none.
- **Operational impact:** the desktop MFA-enroll/disable UI must first call
  `POST /auth/step-up` (password [+ current OTP]) and send the returned
  `step_up_token` (header `x-step-up-token` or body) — a follow-up UI change.
- **Remaining risk:** step-up single-use is per-instance (matches the documented
  single-instance deployment); a shared store would be needed for multi-instance.

---

## SEC-SSRF-001 — AI provider SSRF (redirect / DNS rebinding)  (Phase 5)

- **Files modified:** `backend/src/ai/safeFetch.ts` (new — SSRF-safe client);
  `backend/src/ai/providers.ts` (use `safeFetch` for all three provider calls).
- **Root cause:** provider calls used global `fetch()` with `redirect: follow`,
  no timeout, no size cap; the store-time `isPublicHttpUrl` guard validated only
  the literal string and allowed DNS names (rebinding) and followed redirects to
  internal targets.
- **Fix:** a central `safeFetch` on node:http/https with a custom socket
  `lookup` as the single resolution point (rebinding-safe): protocol allowlist
  (https; http only in dev), DNS-resolve + validate EVERY candidate address
  (loopback/private/link-local/metadata/CGNAT/reserved/multicast + IPv4-mapped
  IPv6), pin the connection to the validated IP while preserving Host/SNI,
  manual redirects re-validated per hop with a cap, connect/request timeouts,
  and a response-size limit. An explicit off-by-default `allowLoopback` permits
  only localhost for local-dev AI (e.g. Ollama).
- **Tests added:** AI-SSRF-001..015 — 16 tests, `backend/src/ai/safeFetch.test.ts`.
- **Test result:** PASS (16/16). Backend unit 106→122.
- **Migration required:** none.
- **Operational impact:** custom AI providers must be https public endpoints
  (loopback only via the dev option); redirects to internal targets are refused.
- **Remaining risk:** none for the covered vectors.

---

## SEC-NET-001 — Network diagnostics scoped + restricted  (Phase 6)

- **Files modified:** `backend/src/domain/permissions.ts` (+`network:diagnose`
  permission + label; granted to super_admin & admin via ALL/ADMIN_ALL, NOT the
  user/readonly/auditor roles); `desktop/src/shared/lib/permissions.ts` (mirror);
  `backend/src/routes/network.ts` (gate on `network:diagnose`; block
  infra-sensitive targets; per-user rate limit; audit each op);
  `backend/src/repos/otherRepos.ts` (`network_diagnose` valid action);
  `backend/src/server.ts` (pass audit); `desktop/.../DashboardLayout.tsx`
  (nav gated on `network:diagnose`).
- **Root cause:** ping/traceroute/DNS/port-check/scan were gated only by
  `sessions:connect` (held by every standard user) with no target restriction.
- **Fix:** a dedicated `network:diagnose` permission (Super Admin + Admin only);
  loopback, unspecified, link-local + cloud-metadata (169.254.169.254), and
  multicast/reserved targets are refused by default (RFC1918 LAN still allowed
  as the tool's purpose); CIDR (≤/24) and port (≤12) caps retained; a per-user
  request-frequency limit added; every diagnostic action is audited.
- **Tests added:** NET-SCOPE-001..010 — 9 tests, `backend/src/routes/netScope.itest.ts`.
- **Test result:** PASS. Backend integration 144→153; desktop tsc + tests green.
- **Migration required:** none (built-in roles reconciled from code at startup).
- **Operational impact:** standard users lose ad-hoc network scanning; grant a
  role with `network:diagnose` where needed.
- **Remaining risk:** per-tenant target allowlists (beyond infra-block) remain a
  future enhancement.

---

## SEC-AUDIT-001 — Audit failures observable, not silent  (Phase 7)

- **Files modified:** `backend/src/repos/otherRepos.ts` (AuditRepository: failure
  metric + non-secret error log; `mapAction` preserves real actions);
  `backend/src/domain/index.ts` (`AuditEvent.requestId`); `backend/src/server.ts`
  (inject logger).
- **Root cause:** `AuditRepository.log` swallowed all write errors (`catch {}`)
  with no log or metric; `mapAction` silently rewrote unknown actions to
  `config_change`, erasing the true action.
- **Fix:** an audit-write failure still never crashes the request path
  (fail-open for availability) but is now observable: it increments
  `getAuditWriteFailuresTotal()` and emits an application error log with
  correlation fields (requestId, userId, action, resource, error category) and
  NO secret payload (the `details` object is never logged). `mapAction`
  preserves the real action verbatim (the column is free TEXT).
- **Tests added:** AUDIT-DURABILITY-001..006 — 6 tests,
  `backend/src/repos/auditDurability.test.ts`.
- **Test result:** PASS. Backend unit 122→128.
- **Migration required:** none.
- **Operational impact:** audit-write failures now surface in logs/metrics; wire
  `getAuditWriteFailuresTotal()` into monitoring.
- **Remaining risk:** audit remains fail-open by design (documented); a durable
  outbox for the most sensitive actions is a possible future hardening.

---

## SEC-INFRA-001 — Main API container root + NET_ADMIN  (Phase 8)  — ACCEPTED TEMPORARY ARCHITECTURAL RISK

- **Status:** NOT FIXED — accepted, documented risk (per §43). See
  `docs/SECURITY_SEC-INFRA-001.md`.
- **Root cause:** the `auth-service` container runs root + `NET_ADMIN` +
  `/dev/net/tun` because the backend spawns OpenVPN in-process.
- **Decision:** the correct fix is an architectural split into a dedicated,
  minimally-privileged `vpn-helper` service (IPC over a Unix socket, structured
  allowlisted commands) leaving the API container unprivileged. That split
  cannot be built AND runtime-verified in this environment (no Docker daemon, no
  `/dev/net/tun`, no live OpenVPN), and shipping it unverified would be a fake
  fix the program forbids. It is therefore documented and scheduled, not faked.
- **Existing mitigations (retained):** `cap_drop: ALL` + only `NET_ADMIN`;
  `no-new-privileges`; not `--privileged`; backend bound to 127.0.0.1; OpenVPN
  spawned with an arg array (no shell); `assertSafeOvpnConfig` dangerous-directive
  filtering + forced `--script-security 1`; admin-gated VPN routes.
- **Files modified:** `docs/SECURITY_SEC-INFRA-001.md` (new — risk, blast radius,
  mitigations, required future architecture). No runtime privilege change (would
  break VPN without the helper).
- **Tests added:** none (documentation/risk-acceptance).
- **Remaining risk:** an API RCE/escape runs as root with NET_ADMIN + TUN;
  mitigated as above; full remediation requires the helper split in a dedicated
  cycle with a real Docker + TUN test host.
