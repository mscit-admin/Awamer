# AWAMER FINAL SECURITY ASSESSMENT

**Release:** not single-versioned: backend 1.8.0 / desktop & Tauri 1.7.0 (see `RELEASE_VERSION_MATRIX.md`)
**Commit:** baseline assessed `8a8fb5b6949ebcc7143e636f81a1e9c6fe64c233`; remediation = the commit on branch `claude/determined-fermat-zf9h5p` that adds this file
**Assessment date:** 2026-10-02

**Production decision:** **PRODUCTION SECURITY ACCEPTED WITH CONDITIONS** (remediated code). The baseline `8a8fb5b` would be **REJECTED**.

| Severity | Confirmed in this assessment | Fixed | Open |
|---|---|---|---|
| **Critical** | 1 | 1 | **0** |
| **High** | 6 | 6 | **0** |
| **Medium** | 11 | 6 | **5** (R-01…R-05) |
| **Low** | 19 | 7 | **12** (R-06…R-17) |
| **Informational** | 3 | 0 | **3** (R-18…R-20) |

**Tests:** 525 executed (backend unit 282, backend integration 220 on real PostgreSQL 16, frontend 23)
**Passed:** 525
**Failed:** 0
**Skipped:** 0

---

## 1. Executive Summary

The repository had been through many remediation cycles. Its own latest reports said
"APPROVED FOR PRODUCTION". This assessment re-derived everything from the current code, using
five parallel code reviews, executed test suites, real PostgreSQL, and dependency scanners. It
found that the baseline was **not** production-safe. These classes of issue were present and
exploitable:

1. **Critical. A tenant admin could get root code execution in the VPN helper.** The helper
   runs as root with NET_ADMIN on the host network namespace and holds the database
   credentials. Cause: the VPN-server `cipher` field was free text interpolated into an
   OpenVPN config that runs with `script-security 2`.
2. **High. MFA bypass.** The post-password MFA challenge token was a normal access JWT. For
   MFA accounts whose `auth_version` was still 1, it opened a full session without the code.
3. **High. Cross-tenant account takeover.** Any company admin could repoint the
   *installation-wide* SMTP relay and capture password-reset links for every tenant,
   super_admin included.
4. **High. Company admin → super_admin.** Admin actions checked only "same company", never
   the target's privileges. Migration 012 placed pre-existing super_admins in the Default
   company, so a co-located super_admin could be password-reset, MFA-stripped, locked,
   demoted or deleted.
5. **High. Remote-session SSRF.** Telnet/VNC are raw TCP relays, and SSH/SFTP/tunnel hops
   had no destination policy. A standard user could reach cloud metadata
   (169.254.169.254), the backend's loopback, and PostgreSQL/Redis on the Docker network.
6. **High. Root file read and secret exfiltration through client `.ovpn`.** For example,
   `auth-user-pass /proc/self/environ` would send the helper's `DATABASE_URL` and
   `VPN_HELPER_SECRET` to an attacker's VPN server. `management` / `log` / `writepid` and
   `redirect-gateway` were also allowed.
7. **High. Runtime dependency advisories.** fastify 5.11.2 had an authentication-bypass
   advisory and an X-Forwarded-* spoofing advisory; also fast-uri (SSRF) and nodemailer.

All Critical and High findings, and six Medium findings, were **fixed with minimal,
targeted changes**. Each has regression tests. Where testable, those tests were **proven to
fail on the baseline** by running them in a clean worktree of `8a8fb5b`.

One new RBAC permission was introduced, following the project's RBAC rule:
**`settings:manage`**, granted to super_admin only and global-only.

The remaining risks are Medium or below. The decision is therefore **ACCEPTED WITH
CONDITIONS** (C-1…C-7 in `PRODUCTION_ACCEPTANCE.md`). The key conditions are:
- deploy exactly the remediated commit;
- unify the release version;
- build the images in CI, which was blocked here;
- run a post-upgrade compromise review, because these flaws existed in deployed builds.

## 2. Architecture Security Assessment

**Trust boundaries:**
- The browser SPA or Tauri desktop talks to nginx (TLS, CSP, HSTS).
- nginx forwards to the Fastify backend (unprivileged, uid 10001, `cap_drop ALL`).
- The backend uses PostgreSQL. It reaches the vpn-helper only over an HMAC-authenticated
  Unix socket.
- The vpn-helper is root with NET_ADMIN on the **host** network namespace.
- The backend opens outbound SSH/SFTP/Telnet/VNC/tunnels to managed hosts.
- The backend makes outbound HTTPS calls to AI providers and SMTP.

**Most sensitive modules:**
- auth: `jwt/`, `middleware/auth.ts`, `usecases/login|mfa|refresh|stepUp`
- RBAC: `domain/permissions.ts`, `routes/admin|roles|organization`
- tenant scoping in the repos
- the remote gateways
- the VPN chain: `routes/vpn*`, `domain/vpn*`, `vpn-helper/`
- crypto: `secretBox`, `backupCrypto`

**Assessment:** the layering is sound. Authorization is server-side, the live role is
re-read per request, tenant predicates are in SQL, and the helper is isolated. The confirmed
issues were flaws at specific seams:
- a token type (`mfa_pending`);
- instance-global settings behind a tenant-admin gate;
- a missing *target* ceiling;
- string interpolation into a privileged config.

They were not systemic breakdowns. The structural weakness that remains is the helper's
blast radius (R-03) and the Postgres superuser (R-02).

## 3. OWASP Results

Full matrix: `OWASP_TOP10_MATRIX.md`.

| Status | Categories |
|---|---|
| PASS | A01, A02, A03, A07, A10 |
| PARTIAL | A04, A05, A06, A08, A09 |
| FAIL | none |
| NOT VERIFIED | none |

## 4. API Security Results

Full matrix: `OWASP_API_SECURITY_MATRIX.md`.

| Status | Risks |
|---|---|
| PASS | API1 BOLA, API2 AuthN, API3 property-level, API5 function-level, API6 business flows, API7 SSRF, API10 unsafe consumption |
| PARTIAL | API4 resource consumption, API8 misconfiguration, API9 inventory (versioning) |

## 5. RBAC Assessment

`RBAC_AUTHORIZATION_MATRIX.md` (generated from `BUILTIN_ROLES`) and `PRIVILEGE_ESCALATION_TESTS.md`.

**Verified working:**
- grant ceiling and global-only permissions;
- locked built-ins reconciled at startup;
- tenant-owned custom roles;
- live role per request;
- `/users/me` field allow-list.

**Fixed in this closure:**

| Fix | Change |
|---|---|
| **Target ceiling** | On user PATCH/DELETE/reset-password/disable-MFA and on org assignment |
| **`settings:manage`** | Instance-wide SMTP/branding/session policy, mirrored in backend and frontend, global-only |
| **Auditing** | User administration and settings changes are now audited |

All 24 escalation scenarios are denied on the remediated code. Eight of them were open on the baseline.

## 6. Multi-Tenant Assessment

See `TENANT_ISOLATION_TESTS.md`.

**Verified isolated (cross-tenant access denied):**
- object-level scoping (`user_id`, company predicates that fail closed on NULL);
- every Company A → Company B attempt: users, resources, credentials, connections, VPN,
  secrets, roles, org units, audit, backups, AI.

**Cross-tenant paths that were open, and are now closed:**
- the global SMTP / branding / session-policy settings;
- the co-located super_admin takeover (super_admin is global);
- the helper/host compromise paths;
- relays into the platform's own network.

## 7. Authentication Assessment

**Verified:**
- Argon2id (64 MiB, t=3, p=4) with a dummy-hash timing parity on unknown users;
- password complexity of 12+ characters across 4 character classes;
- per-IP limits plus a per-account lockout;
- HS256 pinned, typed tokens, `iss` check;
- live account state and `auth_version` on every REST and WebSocket entry point
  (disable, lock, delete, role change and company change take effect immediately);
- refresh: HttpOnly + Secure + SameSite=Strict cookie, rotation, and reuse revokes the chain;
- web access token kept in memory; desktop tokens in the OS keyring;
- step-up for MFA changes;
- password reset: 32-byte token stored hashed, single use, trusted base URL only, sessions revoked.

**Fixed in this closure:**

| Fix | Change |
|---|---|
| MFA challenge token type | Typed `mfa_pending`, unusable as a session |
| MFA brute force | Per-account lockout; failures audited; the counter is no longer reset between factors |
| TOTP replay | Atomic time-step claim |
| Refresh rotation | Atomic claim |
| Logout-all | Bumps `auth_version` and kills live sessions |
| Rate limits | Forgot/reset-password and step-up/verify-password |

Remaining: R-16 account-state enumeration, R-20 no absolute session cap (both Low).

## 8. Cryptography Assessment

**Verified:**
- AES-256-GCM with a random 12-byte IV per encryption;
- **full 16-byte tags now enforced** in both envelopes;
- the credential key must be exactly 32 bytes and is mandatory in production (fail-closed);
- backups use scrypt N=2^15, r=8, p=1, now **pinned on decrypt** (closes the DoS);
- TOTP secrets are sealed and fail-closed;
- VPN PKI uses RSA-2048 / SHA-256 with 128-bit serials and keys sealed at rest;
- CSPRNG for every token and handle (the SFTP handle was moved off `Math.random`);
- no MD5/SHA1 password hashing, ECB, static IVs, fallback production keys, or hard-coded secrets.

Info: there is no key-ID or key-rotation support.

## 9. Remote Access Security

**SSH:**
- TOFU host-key pinning; a key change is refused;
- credentials are resolved as the host **owner**;
- first-frame JWT with a 10 s deadline;
- `sessions:connect` re-checked;
- periodic revalidation.

**VNC:**
- 30 s single-use ticket bound to user and host;
- live state re-checked at redeem.

**Telnet / VNC / SSH / SFTP / tunnel hops: new destination policy.**
- The name is resolved once and every address is checked.
- Metadata, link-local, unspecified and multicast are always denied.
- Loopback is opt-in.
- The Docker-internal subnet is denied by default in compose.
- Private infrastructure stays reachable, which is the product's purpose.

**Session termination on disable / lock / delete / role change / company move / logout-all:**
- SSH, Telnet, VNC and WS tunnels are closed (executed tests).
- Server-managed `-L` tunnels and SFTP are **now** registered and closed. This is verified by
  code review only.

**VPN:**
- server `cipher` allowlist, re-checked in the helper;
- client `.ovpn` denylist extended (files, control channel, includes, default-route) plus
  `--pull-filter` for pushed redirects;
- `--script-security 1` forced last.

Remaining: R-03 (routes on the host namespace), R-15 (WebSocket back-pressure).

**Audit failure policy (§23).** Today every audit write is **fail-open**: the operation
succeeds, a counter is incremented, and `audit_write_failed` is logged. The counter is now
exported on `/readyz`. Operations fall into three classes:

| Class | Operations |
|---|---|
| NORMAL | resource CRUD, notes, history |
| SENSITIVE | login/logout, session start/end, settings changes |
| CRITICAL SECURITY | credential/VPN reveal, role/permission changes, admin password/MFA resets, user disable/delete |

Fail-closed is defensible for the CRITICAL class. **Failing closed was deliberately not
implemented**, because it adds an availability dependency on the audit table for incident-time
actions such as disabling a compromised user, and it changes existing tested behaviour
(`auditDurability.test.ts`).

Recommendation: keep fail-open for disable/lock and other containment actions. Consider
fail-closed for reveal endpoints only, after an availability review. Alerting is mandatory now
(C-6).

## 10. Dependency Security

See `DEPENDENCY_SECURITY_REPORT.md`.

**Updated:**
- runtime fixes: fastify 5.12.5, fast-uri, nodemailer 10.0.13 (major, reviewed), rustls 0.23.45;
- desktop in-range updates;
- Docker images now install from the lockfile (`npm ci`).

**Remaining:**

| Package | Severity | Why it is not a blocker |
|---|---|---|
| `@fastify/static` | High | Reachable only with `ENABLE_API_DOCS`; off by default and not proxied |
| `node-forge` | High | The advisory is in `verify`, which is never called |
| desktop `russh` | High (A:H) | DoS of the client by a malicious server (R-01) |
| `quick-xml` | High | Build-time only |
| react-router v6 | Moderate | Not reachable |
| dev tooling | Critical/High | Dev only |

## 11. Container Security

See `PRODUCTION_CONFIGURATION_REVIEW.md` §4. The compose contract tests were executed and pass.

| Component | Verified |
|---|---|
| Backend | non-root, `cap_drop ALL`, `no-new-privileges`, no NET_ADMIN, no tun device, loopback-only publish |
| vpn-helper | `cap_drop ALL` + NET_ADMIN only, `no-new-privileges`, no control port, root on the host network |

Not set: read-only rootfs, resource limits, image digests.

The images could not be built in this sandbox (proxy 403 / Docker Hub 429). This is
**BLOCKED BY ENVIRONMENT**, and a CI build is required (C-3).

## 12. Production Configuration

See `PRODUCTION_CONFIGURATION_REVIEW.md`.

**Fail-closed when missing or weak:** JWT secrets, credential key, DB credentials, bootstrap
password, helper secret, https base URL, trust proxy, and now `APP_VERSION`.

There are no production defaults or hard-coded secrets. The repository and its history are
clean, and secret values are redacted in the reports.

Weak points: R-11 (`APP_ENV` default) and R-12 (CORS hygiene).

## 13. Remaining Risks

See `REMAINING_RISKS.md`. No Critical or High risk is open.

**Medium:**
- R-01: desktop `russh` DoS by a malicious SSH server;
- R-02: Postgres superuser;
- R-03: vpn-helper host-network design;
- R-04: release versioning;
- R-05: Docker build not verified here.

## 14. Required Actions

1. **Before go-live:** complete conditions C-1…C-7 (`PRODUCTION_ACCEPTANCE.md`). C-7, the
   post-upgrade compromise review, is the most important, because the baseline flaws were
   exploitable in deployed builds.
2. **Within 30 days:** R-01, R-02.
3. **Within 90 days:** R-03 and the Low items.
4. **Process:** future "final" reports should be produced only from executed evidence
   against the exact commit. This assessment found that several earlier "APPROVED" verdicts
   did not hold.

## 15. Production Decision

# PRODUCTION SECURITY ACCEPTED WITH CONDITIONS

This decision applies to the remediated commit, under the conditions in `PRODUCTION_ACCEPTANCE.md`.

---

### Appendix A — Findings (confirmed in this assessment)

**Format:**
- ID
- Title
- Severity, with the OWASP / OWASP API mapping
- Location: affected file(s) and the endpoint or function
- Evidence and attack scenario
- Business impact
- Remediation, i.e. the code change performed
- Regression test
- Verification result

---

**FINAL-01 — VPN server `cipher` config injection → root RCE in vpn-helper**
- **Severity:** CRITICAL
- **OWASP:** A03 · API10
- **Location:** `routes/vpnServer.ts` (create/patch schemas), `domain/vpnServer.ts` (`assembleServerConfig`/`assembleClientOvpn`), `vpn-helper/helperServer.ts`
- **Evidence:**
  - `cipher: z.string().max(40)` is interpolated as `cipher ${cipher}`.
  - The config contains `script-security 2`.
  - The helper re-validated only `proto` and the ports.
- **Attack:** any `vpn_server:manage` holder (every company admin) sets `"AES-256-GCM\nup \"/bin/sh -c '…'\""` and starts the server. The command runs as root in the host-network helper, which holds `DATABASE_URL`.
- **Impact:** full platform and database compromise across all tenants.
- **Remediation:**
  - `z.enum(VPN_SERVER_CIPHERS)`;
  - allowlist re-check in the helper IPC;
  - the assemblers validate cipher, proto, port, subnet, DNS and host before any interpolation.
- **Test:** VPN-CFG-001/002.
- **Verification:** fails on the baseline, passes now.

---

**FINAL-02 — MFA bypass: challenge token accepted as access token**
- **Severity:** HIGH
- **OWASP:** A07 · API2
- **Location:** `usecases/login.ts`, `jwt/index.ts`, `routes/auth.ts` (`/mfa/verify`)
- **Evidence:**
  - The token was issued with `typ:"access"`, the access key, and no `av` claim.
  - `verify()` defaults a missing `av` to 1.
  - The middleware then substitutes the live role.
- **Attack:** an attacker who knows the password calls `/login` and sends `Bearer <mfa_token>` to any API route or WebSocket.
- **Impact:** second factor bypassed for affected accounts: MFA enabled and `auth_version` still 1.
- **Remediation:** typed `mfa_pending`; new `verifyMfaPending` used only by `/mfa/verify`; `verifyAccess` rejects it.
- **Tests:** FINAL-MFA-001/002, MFA-TYP-001..004.
- **Verification:** FINAL-MFA-001 fails on the baseline; all pass now.

---

**FINAL-03 — Tenant admin controls instance-wide SMTP / branding / session policy**
- **Severity:** HIGH
- **OWASP:** A01 · API5
- **Location:** `routes/smtp.ts`, `routes/branding.ts`, `routes/sessionSettings.ts`
- **Evidence:** the routes were gated by `requireRole("admin","super_admin")` over global `app_settings`.
- **Attack:** an admin of company A points SMTP at their own relay, then calls the public forgot-password endpoint for any user in any tenant and captures the `reset_token`.
- **Impact:** cross-tenant account takeover.
- **Remediation:**
  - new permission `settings:manage`: super_admin only, global-only, mirrored in the frontend;
  - all three routes gated on it;
  - changes audited (field names only).
- **Tests:** FINAL-INST-001/002/003.
- **Verification:** the baseline PUT returned 200 in an isolated run; 403 now.

---

**FINAL-04 — Missing target privilege ceiling in user administration**
- **Severity:** HIGH
- **OWASP:** A01 · API5
- **Location:** `routes/admin.ts` (PATCH, DELETE, reset-password, disable-mfa), `routes/organization.ts` (assignment)
- **Evidence:** only `sameCompany` was checked; `mayGrantRole` applied to the *new* role only.
- **Attack:** a company admin resets the password and disables the MFA of a super_admin placed in the Default company by migration 012, then logs in with global `companies:manage`. A `users:manage` helpdesk role can demote its admin.
- **Impact:** escalation to platform super-admin, crossing every tenant.
- **Remediation:** `mayActOnTarget` (the target's permissions must be a subset of the actor's) on every mutation and on assignment; denials audited.
- **Tests:** FINAL-CEIL-001/002/003.
- **Verification:** fails on the baseline, passes now.

---

**FINAL-05 — Remote-session SSRF (Telnet/VNC raw relay; SSH/SFTP/tunnel hops)**
- **Severity:** HIGH (cloud) / MEDIUM (on-prem)
- **OWASP:** A10 · API7
- **Location:** `telnet/gateway.ts`, `vnc/gateway.ts`, `ssh/gateway.ts`, `ssh/sftpGateway.ts`, `ssh/wsTunnelGateway.ts`, `ssh/tunnelManager.ts`
- **Evidence:** each gateway did `net.connect({host: host.hostname})` with no policy.
- **Attack:** a `user` creates a Telnet host `169.254.169.254:80` and replays an IMDS request; or targets `postgres:5432` or `127.0.0.1`.
- **Impact:** cloud credential theft, internal service access.
- **Remediation:** `usecases/remoteDestination.ts`:
  - resolve once and check every address;
  - always deny metadata, link-local, unspecified and multicast;
  - loopback opt-in;
  - `REMOTE_SESSION_DENY_LOCAL_SUBNETS` (compose default true) and `REMOTE_SESSION_DENY_CIDRS`;
  - connect to the checked IP.
- **Test:** REMOTE-DEST-001..006. The gateway itests pass with an explicit loopback opt-in.
- **Verification:** pass.

---

**FINAL-06 — Client `.ovpn` root file read/write, control port and route hijack in the helper**
- **Severity:** HIGH
- **OWASP:** A03/A01 · API8
- **Location:** `domain/vpn.ts` (`assertSafeOvpnConfig`), `vpn-helper/helperCore.ts`
- **Evidence:** the blocklist covered only script directives.
- **Attack:** a tenant admin connects a profile containing `auth-user-pass /proc/self/environ`. The helper's `DATABASE_URL` and `VPN_HELPER_SECRET` are sent to the attacker's VPN server. Also possible: `management 0.0.0.0 …`, `log <path>`, `redirect-gateway`.
- **Impact:** secret disclosure and host network takeover.
- **Remediation:**
  - deny file-path arguments, `log*`, `writepid`, `status`, `config`, `askpass`, `management*`, `redirect-*`;
  - `--pull-filter ignore redirect-gateway/redirect-private`.
- **Tests:** OVPN-FILE-001/002, helperCore pull-filter assertion.
- **Verification:** fails on the baseline, passes now. Not exercised against a live OpenVPN.

---

**FINAL-07 — Runtime dependency advisories**
- **Severity:** HIGH
- **OWASP:** A06
- **Packages:** fastify ≤5.12.4 (authentication-bypass and XFF-spoofing advisories), fast-uri (SSRF), nodemailer ≤10.0.8.
- **Remediation:** fastify 5.12.5, fast-uri 3.1.8 / 4.2.1, nodemailer 10.0.13.
- **Verification:** `npm audit` re-run; full suites pass.

---

**FINAL-08 — Backup import scrypt parameters from the file (event-loop DoS)**
- **Severity:** MEDIUM
- **OWASP:** API4
- **Location:** `crypto/backupCrypto.ts`
- **Remediation:** pin N/r/p to the format constants.
- **Test:** BACKUP-KDF-002.
- **Verification:** fails on the baseline, passes now.

---

**FINAL-09 — MFA brute force across re-logins; MFA failures unaudited**
- **Severity:** MEDIUM
- **OWASP:** A07
- **Location:** `usecases/login.ts`, `routes/auth.ts`
- **Remediation:**
  - no counter reset at the password step for MFA accounts;
  - `recordMfaFailure` locks the account at the threshold and writes an audit entry;
  - locked accounts get no further guesses.
- **Test:** FINAL-MFA-003.
- **Verification:** fails on the baseline, passes now.

---

**FINAL-10 — Logout-all left access tokens and live shells alive**
- **Severity:** MEDIUM
- **OWASP:** A07
- **Location:** `usecases/refresh.ts`, `routes/auth.ts`
- **Remediation:** bump `auth_version` and `revokeUser`.
- **Test:** FINAL-LOGOUTALL-001.
- **Verification:** fails on the baseline, passes now.

---

**FINAL-11 — Privileged user administration and instance-settings changes not audited**
- **Severity:** MEDIUM
- **OWASP:** A09
- **Location:** `routes/admin.ts`, `smtp.ts`, `branding.ts`, `sessionSettings.ts`
- **Remediation:** audit `user_update` (fields, prev/new role, flags), `user_delete` (username/company/role), ceiling denials and settings changes; `/readyz` exports the audit-failure counter.
- **Tests:** FINAL-CEIL-002, FINAL-INST-002.
- **Verification:** fails on the baseline, passes now.

---

**FINAL-12 — Server-managed tunnels and SFTP sessions survive disable / role change**
- **Severity:** MEDIUM
- **OWASP:** A01
- **Location:** `ssh/tunnelManager.ts`, `ssh/sftpGateway.ts`, `server.ts`
- **Remediation:** register both with `ActiveSessionManager`; SFTP re-checks the live role per operation; CSPRNG handles.
- **Test:** code review only (needs a live SFTP / `-L` server).
- **Verification:** typecheck plus full suites pass.

---

**FINAL-13 — Docker images ignored the lockfile**
- **Severity:** MEDIUM
- **OWASP:** A08
- **Location:** `backend/Dockerfile*`
- **Remediation:** `COPY package-lock.json` + `npm ci`.
- **Verification:** `npm ci` is clean on the same lockfiles; the image build is blocked by the environment.

---

**FINAL-14 — TOTP code replay within the ±1-step window**
- **Severity:** LOW
- **OWASP:** A07
- **Location:** `usecases/mfa.ts`, `repos/otherRepos.ts`
- **Remediation:** atomic time-step claim.
- **Test:** TOTP-REPLAY-001.
- **Verification:** fails on the baseline, passes now.

---

**FINAL-15 — Refresh rotation not atomic**
- **Severity:** LOW
- **OWASP:** A07
- **Remediation:** conditional `UPDATE … WHERE rotated_to IS NULL AND revoked_at IS NULL`; losing the claim is treated as reuse.
- **Test:** FINAL-REFRESH-001.
- **Verification:** the race was not reproduced on the baseline; the fix is defensive.

---

**FINAL-16 — Missing login-grade rate limits on reset and step-up oracles**
- **Severity:** LOW
- **OWASP:** API4
- **Remediation:** per-route limits on forgot-password, reset-password, verify-password and step-up.
- **Verification:** code review.

---

**FINAL-17 — Truncated GCM tags accepted**
- **Severity:** LOW
- **OWASP:** A02
- **Location:** `secretBox.ts`, `backupCrypto.ts`
- **Remediation:** `authTagLength: 16` plus a length check.
- **Tests:** SECRETBOX-TAG-001, BACKUP-KDF-003.
- **Verification:** fails on the baseline, passes now.

---

**FINAL-18 — WebSocket frames up to 100 MiB accepted before authentication**
- **Severity:** LOW
- **OWASP:** API4
- **Remediation:** `maxPayload` 2 MiB.
- **Verification:** code review.

---

**FINAL-19 — Production compose silently tagged images `1.6.0.1`**
- **Severity:** LOW
- **OWASP:** A08
- **Remediation:** `APP_VERSION` is now mandatory.
- **Verification:** the compose contract test passes.

---

**FINAL-20 — Desktop rustls / quinn-proto advisories**
- **Severity:** LOW/MEDIUM
- **OWASP:** A06
- **Remediation:** patch updates in `Cargo.lock`.
- **Verification:** `cargo check --locked` passes; `cargo audit` re-run.

The remaining confirmed items, R-01…R-20, are listed in `REMAINING_RISKS.md`. Those 20
remaining items plus the 20 fixed findings above make up the 40 confirmed findings in the
summary table (1 Critical, 6 High, 11 Medium, 19 Low, 3 Informational).

### Appendix B — Previous findings: report claim → code → test → result

| Previous ID (claim) | Code implementation found | Test executed here | Result |
|---|---|---|---|
| SEC-016 custom-role escalation ceiling | `routes/roles.ts` ceiling + global-only | rbacRoles.itest TEST-RBAC-001..008 | **VERIFIED FIXED** |
| SEC-020 role/tenant integrity on assignment | `mayAssignRoleTenant`, destination checks | moveRbac.itest | **VERIFIED FIXED** |
| "Role assignment security / privilege escalation PASS" (FINAL_SECURITY_GATE_REPORT) | grant ceiling only; **no target ceiling** | FINAL-CEIL-001/003 fail on baseline | **PARTIALLY FIXED** → fixed now (FINAL-04) |
| AWM-SEC-021 live account state on HTTP + WS | `verifyCurrentAccessToken`, live role | AUTHZ-STATE-001..008, authStateWs | **VERIFIED FIXED** |
| SEC-SESSION-001/002 `auth_version` invalidation | `av` claim check | authInvalidate(Ws) itests | **VERIFIED FIXED** — but the MFA token path was outside it (**FINAL-02**) |
| AWM-SEC-022 active remote-session revocation | `ActiveSessionManager` for SSH/Telnet/VNC/WS tunnel | sessionRevocation.itest | **PARTIALLY FIXED** (REST tunnels + SFTP missing) → fixed now (FINAL-12) |
| SEC-017 logout revocation | single logout OK; logout-all refresh-only | logout.itest; FINAL-LOGOUTALL-001 fails on baseline | **PARTIALLY FIXED** → fixed now (FINAL-10) |
| SEC-019 refresh cookie HttpOnly/Secure/SameSite | `routes/authCookies.ts` | authCookies.test, authCookieFlow.itest | **VERIFIED FIXED** |
| SEC-MFA-001 MFA secret encryption, fail-closed | `usecases/mfa.ts`, startup migration | mfaFailClosed.test, mfaCrypt.itest | **VERIFIED FIXED** |
| SEC-MFA-002 step-up for MFA changes | `usecases/stepUp.ts`, `routes/users.ts` | mfaStepUp(Av).itest | **VERIFIED FIXED** |
| SEC-RESET-001 reset links from a trusted base URL only | `usecases/publicBaseUrl.ts`, `passwordReset.ts` | passwordResetHost.test | **VERIFIED FIXED** — though tenant admins could change `app_base_url`/SMTP (**FINAL-03**) |
| SEC-PROXY-001 / F1 trust-proxy hardening | `config/index.ts`, `trustproxy.sh` | trustProxy.test, proxyTrust.test | **VERIFIED FIXED** (plus fastify 5.12.5 for the upstream XFF advisory) |
| F2 IPv6 SSRF in AI fetch | `ai/safeFetch.ts` | safeFetch.test | **VERIFIED FIXED** |
| JWT HS256 pin | `jwt/index.ts` | algVerify.test | **VERIFIED FIXED** |
| SEC-INFRA-001 privileged VPN isolation | helper split, contract | composeContract.test, helperCore.test, helperIpc.itest | **PARTIALLY FIXED**: isolation verified, but the cipher RCE and `.ovpn` gaps reached the helper (FINAL-01/06) → fixed now |
| SEC-AUDIT-001 audit failures observable | counter + `audit_write_failed` log (fail-open) | auditDurability.test | **PARTIALLY FIXED**: counter not exported; admin ops unaudited → improved now (FINAL-11); fail-open retained by analysis |
| AWM-MIG-003 migration collision guard | `migrate.ts` | migrate.itest, roleMigration.itest | **VERIFIED FIXED** |
| AWM-CFG-001 production bootstrap password | `assertProductionBootstrapPassword` | bootstrapConfig.test | **VERIFIED FIXED** |
| SEC-NET-001 network diagnostics policy | `usecases/networkPolicy.ts` | networkPolicy.test, netScope/netCidr itests | **VERIFIED FIXED** |
| Credential secrets encrypted at rest (CLAUDE.md) | `crypto/secretBox.ts`, mandatory key in production | secretBox.test | **VERIFIED FIXED** (+ tag-length hardening) |
| Version inconsistency (previous review) | still inconsistent | — | **NOT FIXED** (reported, R-04); stale compose default fixed (FINAL-19) |
| Audit fail-open (previous review) | still fail-open | auditDurability.test | **NOT FIXED by design** — analysed in §9; alerting added |
