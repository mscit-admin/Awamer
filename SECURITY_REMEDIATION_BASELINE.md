# Security Remediation Baseline

Captured before any code change. Production decision at start: **NOT APPROVED FOR
PRODUCTION** until all mandatory gates pass.

## Repository state

- **Git commit:** `9b22cee` (branch `claude/nifty-johnson-u2dwye`).
- **Migrations:** 26 (`backend/migrations/001..026`).
- **Baseline test counts (all passing):**
  - Backend unit (`npm test`): **99**
  - Backend integration (`npm run test:integration`): **108**
  - Frontend (`vitest run`): **16**
  - Deployment: evidence **31**, install-sim **33**, security-port **81**

## Security architecture (must be preserved — non-regression, §1)

Argon2id hashing; JWT access/refresh secret separation (HS256, `jwt/index.ts`);
refresh rotation + reuse detection (`usecases/refresh.ts`); HttpOnly/Secure/
SameSite=Strict refresh cookie; live auth-state check (`middleware/auth.ts`
`assertAuthState`, AWM-SEC-021); `ActiveSessionManager` (`session/activeSessions.ts`,
AWM-SEC-022) revoking SSH/Telnet/Tunnel/VNC; tenant-aware host/note sharing;
custom-role privilege ceiling; role/company session revocation; migration
integrity; dynamic HTTPS port; installation evidence redaction; bootstrap
password non-display; TLS PARTIAL; support-bundle secret scanning.

## Findings — current vs expected behavior + affected files

### SEC-RESET-001 — reset link host/origin poisoning  (P1)
- **Current:** `routes/passwordReset.ts` `originOf(req)` derives a fallback base
  URL from `Origin`/`Referer`/`X-Forwarded-Proto`/`X-Forwarded-Host`/`Host`;
  `usecases/passwordReset.ts:48,52` uses `mailer.baseUrl() || fallback`, so when
  the DB `app_base_url` setting is blank, the emailed reset link host is
  attacker-controlled. No `APP_PUBLIC_BASE_URL` env exists (`config/index.ts`).
- **Expected:** reset link base comes ONLY from a validated trusted config
  (`APP_PUBLIC_BASE_URL` env, or validated DB `app_base_url`); request headers
  are never used; production fails closed when no trusted base URL is available;
  URL must be https, valid host, no embedded creds / `javascript:`/`file:`/`data:`.
- **Files:** `config/index.ts`, `usecases/passwordReset.ts`, `routes/passwordReset.ts`,
  `email/mailer.ts`.

### SEC-TENANT-001 — null-company tenant escape  (P0)
- **Current:** a non-super user with `company_id=NULL` collapses to the same
  `null`/`undefined` sentinel super-admins use for "global":
  - `repos/userRepo.ts:list` — `companyId != null` → null = unscoped (ALL users).
    Callers `routes/admin.ts:78`, `routes/users.ts:57`.
  - `repos/otherRepos.ts:AuditRepository.list` — truthy `if(opts.companyId)` →
    null = unscoped (ALL audit). Caller `routes/audit.ts:36-40`.
  - `repos/roleRepo.ts:listForCompany` — `companyId == null` → `listAll()`.
    Caller `routes/roles.ts:77`.
  - Residual: `HostRepository.setShares`/`NotesRepository.setShares`
    `company_id IS NOT DISTINCT FROM $2` lets null-company users share with all
    other null-company users.
  - Safe already: hosts/notes/ai/credentials/vpn/org (SQL `= NULL` → no rows).
- **Expected:** explicit scope — SUPER_ADMIN → global; user+company → that
  company; user+NULL company → **empty/forbidden**, never global. Repository
  scope API must make global access explicit and fail closed.
- **Files:** `repos/userRepo.ts`, `repos/otherRepos.ts`, `repos/roleRepo.ts`,
  `repos/sessionRepos.ts`, `repos/notesRepo.ts`, callers in `routes/*`.

### SEC-SESSION-001 — security changes don't invalidate all sessions  (P0)
- **Current:** no `auth_version` in claims/DB. `changePassword.execute`,
  `changePassword.adminReset`, `passwordReset.resetPassword` revoke refresh
  tokens only — active SSH/Telnet/Tunnel/VNC survive; old access tokens remain
  valid until their ≤15m TTL.
- **Expected:** per-user `auth_version` in the users table and access-token
  claim; middleware rejects on mismatch; version increments + refresh revoke +
  `ActiveSessionManager.revokeUser` on password change / reset / admin reset /
  MFA enroll-complete / MFA replace / MFA disable.
- **Files:** new migration, `jwt/index.ts`, `middleware/auth.ts`,
  `repos/userRepo.ts`, `usecases/changePassword.ts`, `usecases/passwordReset.ts`,
  `usecases/mfa.ts`, `routes/*`, `server.ts` wiring.

### SEC-MFA-001 — TOTP secrets stored plaintext  (P0)
- **Current:** `mfa_devices.secret_enc BYTEA` holds the raw base32 secret as
  UTF-8 (`usecases/mfa.ts:61` write, `:73`/`:102` read; `repos/otherRepos.ts:37-49`).
  No encryption despite the column name.
- **Expected:** encrypt at rest with the existing AES-256-GCM envelope
  (`crypto/secretBox.ts` `sealBytes`/`openBytes`), authenticated, random nonce,
  no plaintext fallback in production; idempotent migration of legacy rows;
  fail-closed if key unavailable; never log the seed.
- **Files:** `usecases/mfa.ts`, `repos/otherRepos.ts`, new migration, `server.ts`.

### SEC-MFA-002 — MFA change lacks step-up auth  (P1)
- **Current:** `POST /auth/mfa/enroll` and `/auth/mfa/activate` require only a
  normal access token (`routes/users.ts:110,129`); disable requires password.
- **Expected:** MFA enroll/activate/replace/disable require recent
  re-authentication (password, plus existing MFA when enabled) via a short-lived
  single-purpose step-up token.
- **Files:** `usecases/mfa.ts`, `routes/users.ts`, `routes/auth.ts`, `jwt/index.ts`.

### SEC-SSRF-001 — AI provider SSRF via redirect / DNS rebinding  (P0)
- **Current:** `ai/providers.ts` uses global `fetch()` with no timeout, no size
  cap, `redirect: follow`. `routes/ai.ts:isPublicHttpUrl` blocks literal private
  IPs at store time only; DNS names allowed (rebinding out of scope), redirects
  followed unchecked.
- **Expected:** central SSRF-safe outbound client — protocol allowlist (https;
  http only in dev), DNS-resolve + validate every candidate IP (block loopback/
  private/link-local/metadata/reserved/mapped/multicast), pin the connection to
  the validated IP (rebinding-safe) while preserving Host/SNI, manual redirects
  re-validated per hop with a cap, connect+request timeouts, response-size limit.
- **Files:** new `ai/safeFetch.ts`, `ai/providers.ts`, `routes/ai.ts`.

### SEC-NET-001 — network diagnostics too broad  (P1)
- **Current:** `routes/network.ts` gated by `sessions:connect` (held by the
  built-in `user` role); ping/traceroute/dns/port-check/scan reach any resolvable
  host with no private/metadata block.
- **Expected:** dedicated `network:diagnose` permission (Super Admin + Admin,
  not standard user/auditor), block infra-sensitive targets by default
  (loopback/link-local/metadata/private) unless allowlisted, keep CIDR/port/rate
  limits, audit each action.
- **Files:** `domain/permissions.ts`, `desktop/src/shared/lib/permissions.ts`,
  `routes/network.ts`, `modules/dashboard/DashboardLayout.tsx` (nav), CHANGELOG.

### SEC-AUDIT-001 — audit failures silent  (P1)
- **Current:** `repos/otherRepos.ts:AuditRepository.log` `catch {}` swallows all
  errors with no log/metric; `mapAction` rewrites unknown actions to
  `config_change`.
- **Expected:** on audit-write failure emit an application error log (request id,
  actor, action, resource, timestamp, error category — no secrets) and increment
  an `audit_write_failures_total` metric; documented sensitive-action policy;
  recognize the real action set.
- **Files:** `repos/otherRepos.ts`, a small metrics helper, `routes`/health.

### SEC-INFRA-001 — API container root + NET_ADMIN  (P1)
- **Current:** `deploy/docker-compose.production.yml` `auth-service` runs
  `user: "0:0"` with `cap_add: NET_ADMIN` and `/dev/net/tun` because openvpn is
  spawned in-process (`vpn/vpnManager.ts`, `vpn/vpnServerManager.ts`).
- **Expected:** privileged OpenVPN/TUN in a dedicated minimal helper; API
  container non-root, no NET_ADMIN/TUN. If the split is too large for this cycle,
  document as ACCEPTED TEMPORARY ARCHITECTURAL RISK with mitigations (§43) — not
  a fake fix.
- **Files:** `deploy/docker-compose.production.yml`, `vpn/*` (assessment).

### SEC-DEP-001 — vulnerable @xmldom/xmldom in runtime chain  (P1)
- **Current:** `desktop` → `kdbxweb@2.1.1` → `@xmldom/xmldom@0.7.13`
  (`desktop/src/modules/users/keepassImport.ts` `Kdbx.load` parses attacker-
  supplied KDBX inner XML client-side).
- **Expected:** upgrade/override to a non-vulnerable xmldom verified compatible,
  with KDBX import regression tests (valid/invalid/malformed/large/corrupt/
  wrong-password) and no entity/network loading. If no safe compatible version,
  document reachability + risk.
- **Files:** `desktop/package.json`, KDBX import tests.

## Files modified per phase

Recorded incrementally in `SECURITY_REMEDIATION_CHANGELOG.md` as each phase lands.
