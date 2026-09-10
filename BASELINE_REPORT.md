# Awamer — Phase 0 Baseline Report

**Date:** 2026-09-10
**Branch:** `claude/nifty-johnson-u2dwye`
**Scope:** Security remediation, bug-fixing and stability hardening — controlled, phased.

> This is a **baseline only**. No remediation code has been written at this stage.
> Every finding below was verified against the actual source before being classified.

---

## 1. Architecture map

| Layer | Stack | Location |
| --- | --- | --- |
| Backend | Fastify 5 + Node 20 + TypeScript (ESM), raw SQL via `pg`, custom migration runner | `backend/` |
| Frontend | React + TypeScript + Vite + Tailwind, Zustand stores | `desktop/src/` |
| Desktop shell | Tauri 2 (Rust), OS keyring for secrets | `desktop/src-tauri/` |
| DB | PostgreSQL 16 (migrations `001`–`019`) | `backend/migrations/` |
| Cache/queue | Redis 7 | compose only |
| Deploy | Docker Compose (`deploy/docker-compose.production.yml`) + nginx reverse proxy | `deploy/` |

**Remote-session gateways (WebSocket):** SSH (`src/ssh/gateway.ts`), SFTP
(`src/ssh/sftpGateway.ts`), Telnet (`src/telnet/gateway.ts`), VNC
(`src/vnc/gateway.ts`), WS tunnel (`src/ssh/wsTunnelGateway.ts`).

**Auth model:** stateless access JWT (TTL 15m) verified per-request in
`middleware/auth.ts`; refresh JWT (TTL 168h) with a DB-backed rotation chain
(`refresh_sessions`) and reuse detection. RBAC via DB-backed dynamic roles
(`RoleService`), server sends effective permissions in the user payload.

**Multi-tenant model:** `companies` + `org_units` introduced in migration `012`.
`users.company_id` exists. **Resource tables (`hosts`, `notes`, `credentials`,
`folders`) were created before `012` and were never given a `company_id`** —
they are scoped by `user_id` only. This is central to SEC-003.

---

## 2. Baseline build / test status

| Check | Command | Result |
| --- | --- | --- |
| Backend typecheck | `npx tsc --noEmit` | ✅ PASS (0 errors) |
| Backend unit tests | `npm test` | ✅ PASS — 53/53 |
| Backend integration tests | `npm run test:integration` | ⚠️ Requires a live PostgreSQL (`*.itest.ts`); not run in this sandbox |
| Frontend typecheck | `npx tsc --noEmit` | ✅ PASS |
| Frontend build | `npm run build` | ✅ PASS |
| Frontend unit tests | `npm test` (vitest) | ✅ PASS — 13/13 (1 file: `sftpFiles.test.ts`) |
| Tauri build | `cargo`/`tauri build` | ⚠️ Not run (native GTK/WebKit toolchain; best-effort libs installed at session start) |

**Pre-existing failures:** none observed in the runnable suites. Integration
tests (`*.itest.ts`) and the Tauri native build are environment-gated, not
broken — they must not be confused with regressions introduced by remediation.

---

## 3. Finding verification (verdicts)

### AWM-SEC-001 — Secrets in WebSocket URLs
- **Severity:** P1 (High)
- **Status:** ✅ CONFIRMED
- **Affected files:** `backend/src/ssh/gateway.ts` (61-63), `sftpGateway.ts`,
  `telnet/gateway.ts`, `vnc/gateway.ts`, `ssh/wsTunnelGateway.ts`;
  `desktop/src/modules/sessions/components/WebTerminalPane.tsx` (`gatewayUrl`),
  `TelnetPage.tsx`, `VncPage.tsx`; `deploy/nginx/netsphere.conf` (`access_log` on).
- **Description:** The SSH gateway reads `token`, `password` and `passphrase`
  from `req.query`. The web client's `gatewayUrl()` sets `token` **and**
  `password` as URL query params on the `wss://…/api/v1/ssh/connect` URL.
- **Reproduction:** Open a web SSH session with a password override → the WS
  URL is `…/ssh/connect?token=<JWT>&host_id=…&password=<SECRET>`. nginx
  `access_log` logs the full request line including the query string.
- **Security impact:** JWT access token and cleartext SSH password land in
  nginx access logs, proxy logs, browser history and any monitoring that
  captures URLs. Access token is short-lived (15m) but still a session
  bearer; the password is long-lived credential material.
- **Root cause:** Browsers cannot set custom headers on a `WebSocket`
  handshake, so the original design smuggled auth material through the query
  string — the simplest path, but a logged one.
- **Remediation plan (Phase 1/3):** Move the JWT to the
  `Sec-WebSocket-Protocol` subprotocol header (browser-settable, never
  logged in the request line) and send `password`/`passphrase` as the first
  JSON control frame **after** the socket opens, over the encrypted channel —
  never in the URL. Redact any residual query logging.

### AWM-SEC-002 — Disabled / locked users can refresh
- **Severity:** P1 (High)
- **Status:** ✅ CONFIRMED
- **Affected files:** `backend/src/usecases/refresh.ts` (45-47).
- **Description:** `RefreshUseCase.execute` validates the refresh-token chain
  (reuse/revoked/expired) then calls `users.getById(claims.sub)` and issues a
  new pair **without checking `isActive` / `isLocked` / `lockedUntil`**.
- **Reproduction:** Admin disables user (`is_active=false`) or locks them.
  The user's existing refresh token still mints new access tokens
  indefinitely (168h chain, self-renewing).
- **Security impact:** Account disable/lock is not enforced for already-issued
  sessions — a terminated employee keeps access for up to a week.
- **Root cause:** `login.ts` guards `isActive`/`isAccountLocked`; `refresh.ts`
  never received the same guard.
- **Remediation plan (Phase 1):** After fetching the user, mirror login's
  policy (`!isActive` → deny, `isAccountLocked` → deny; deleted user →
  `getById` throws). On denial, **revoke the whole chain**
  (`revokeAllForUser`), write an audit record, and let the route return the
  existing generic `401 invalid_refresh` (no account-state disclosure).

### AWM-SEC-003 — Cross-company access to shared resources
- **Severity:** P0 (Critical)
- **Status:** ✅ CONFIRMED
- **Affected files:** `backend/src/repos/sessionRepos.ts` (hosts: 533, 597, 703),
  `backend/src/repos/notesRepo.ts` (48); schema: `hosts`, `notes`, `credentials`,
  `folders` have no `company_id`.
- **Description:** Shared-visibility predicate is
  `user_id = $1 OR is_shared = TRUE` with **no company scope**. Because
  resource tables predate the `companies` model, a resource shared by a user
  in Company A is visible/connectable to **every** user on the entire
  installation, including Company B.
- **Reproduction:** User A (Company A) marks a host `is_shared=true`. User B
  (Company B) lists hosts → sees A's host, and can open a session. Shared
  hosts resolve the **owner's** linked credential server-side
  (`ssh/resolveAuth.ts`), so User B connects to A's server with A's secret
  without ever seeing it.
- **Security impact:** Full cross-tenant data exposure and unauthorized
  remote access using another tenant's stored credentials. This is the
  highest-severity finding.
- **Root cause:** `is_shared` semantics = "whole installation", not "within my
  company". No tenant column on the resource tables to scope by.
- **Remediation plan (Phase 2):** Migration adding `company_id` to `hosts`,
  `notes` (and `folders`/`credentials` for consistency), backfilled from the
  owner's `users.company_id`; index it; then scope every shared-visibility
  query with `resource.company_id = <caller company>`. Keep private
  (`user_id`) and explicit-share (`host_shares`/`note_shares`) paths intact.

### AWM-SEC-004 — Refresh token in browser localStorage
- **Severity:** P2 (Medium) — browser deployment only
- **Status:** ⚠️ PARTIALLY CONFIRMED
- **Affected files:** `desktop/src/shared/lib/keyring.ts`,
  `desktop/src/modules/auth/store/authStore.ts`.
- **Description:** Tauri stores the refresh token in the **OS keyring** (secure
  — finding does not apply). The non-Tauri browser build falls back to
  `localStorage`, which is script-readable, raising XSS blast radius.
- **Security impact:** An XSS on the web origin could exfiltrate the long-lived
  refresh token. Bounded by the strength of the CSP (see SEC-006, currently
  absent) and by refresh reuse detection.
- **Remediation plan:** Evaluate `HttpOnly; Secure; SameSite` refresh cookie
  for the browser build with CSRF protection, while preserving the Tauri
  keyring path. **Higher-risk refactor** — will be scoped carefully in Phase 1
  and only implemented if it can be done without regressing the Tauri flow;
  otherwise documented with compensating controls (SEC-006 CSP + reuse
  detection + SEC-002/007 revocation).

### AWM-SEC-005 — Excessive Docker privileges
- **Severity:** P2 (Medium)
- **Status:** ⚠️ CONFIRMED but partially justified
- **Affected files:** `deploy/docker-compose.production.yml` (auth-service:
  `user: "0:0"`, `cap_add: NET_ADMIN`, `devices: /dev/net/tun`).
- **Description:** The API container runs as root with `NET_ADMIN` + tun
  access. The compose file documents that this is for the built-in OpenVPN
  hub/client (openvpn shells out to `ip`).
- **Security impact:** Larger blast radius if the API is compromised. The need
  is real for VPN features but the whole API inherits it.
- **Remediation plan (Phase 4):** Least-privilege hardening that keeps VPN
  working: add `security_opt: [no-new-privileges:true]`, `cap_drop: [ALL]`
  keeping only `NET_ADMIN`, document isolating VPN into a separate privileged
  helper, and note the non-VPN non-root posture already offered in comments.

### AWM-SEC-006 — Missing browser Content-Security-Policy
- **Severity:** P2 (Medium)
- **Status:** ✅ CONFIRMED
- **Affected files:** `deploy/nginx/netsphere.conf`.
- **Description:** nginx sets HSTS, `X-Content-Type-Options`, `X-Frame-Options`,
  `Referrer-Policy`, `Permissions-Policy` — but **no `Content-Security-Policy`**.
- **Security impact:** No first-line defence against XSS/injection for the
  browser build (compounds SEC-004).
- **Remediation plan (Phase 4):** Add a tight CSP matching the SPA
  (`default-src 'self'`, `connect-src` for same-origin API + `wss:`, controlled
  `style-src`/`font-src` for the fonts already used), avoiding
  `unsafe-eval`/wildcards. Validate the app still functions.

### AWM-BUG-001 — Tauri CSP / dev-port mismatch
- **Severity:** P2 (Medium)
- **Status:** ✅ CONFIRMED
- **Affected files:** `desktop/src-tauri/tauri.conf.json` (`connect-src …
  http://localhost:8080`), `desktop/src/shared/lib/api.ts` (default `:8080`),
  `TerminalPane.tsx`/`SftpPage.tsx` (default `:8081`), compose backend `:8081`.
- **Description:** Endpoint defaults disagree (8080 vs 8081), and the Tauri CSP
  `connect-src` only allows `http://localhost:8080` with no `ws:`/`wss:` — a
  production remote-HTTPS backend or a WebSocket would be blocked unless
  `VITE_API_BASE_URL` is same-origin.
- **Remediation plan (Phase 4):** Centralize the endpoint constant, align dev
  ports, and widen the Tauri CSP `connect-src` correctly (self + configured
  origin + `ws:`/`wss:`), without loosening `default-src`.

### AWM-SEC-007 — Session revocation on admin actions
- **Severity:** P1 (High)
- **Status:** ✅ CONFIRMED
- **Affected files:** `backend/src/routes/admin.ts` (PATCH/DELETE `/users/:id`),
  `backend/src/repos/otherRepos.ts` (`revokeAllForUser`).
- **Description:** `revokeAllForUser` is invoked on refresh-reuse, password
  reset and change-password — **not** on admin disable (`is_active=false`),
  lock, or role change. Delete cascades refresh rows via FK, so delete is
  covered; disable/lock/role change are not. Combined with SEC-002, a disabled
  user keeps a live session.
- **Remediation plan (Phase 1):** On disable/lock/role-change, call
  `revokeAllForUser` so refresh stops immediately. Access tokens remain valid
  until their 15m TTL — acceptable given the short window; document it.

---

## 4. Severity summary (baseline, pre-fix)

| ID | Title | Severity | Status |
| --- | --- | --- | --- |
| AWM-SEC-003 | Cross-company shared-resource access | **P0** | CONFIRMED |
| AWM-SEC-001 | Secrets in WebSocket URLs | P1 | CONFIRMED |
| AWM-SEC-002 | Disabled/locked users refresh | P1 | CONFIRMED |
| AWM-SEC-007 | Session revocation on admin actions | P1 | CONFIRMED |
| AWM-SEC-004 | Refresh token in localStorage (browser) | P2 | PARTIAL |
| AWM-SEC-005 | Excessive Docker privileges | P2 | CONFIRMED (justified) |
| AWM-SEC-006 | Missing browser CSP | P2 | CONFIRMED |
| AWM-BUG-001 | Tauri CSP / port mismatch | P2 | CONFIRMED |

Also queued for the systematic reviews: SSH host-key TOFU (accepts any key on
first sight, no persistence — Phase 3), full IDOR/BOLA sweep of `/:id`
endpoints (Phase 2), input-validation & path-traversal review of SFTP
(Phase 3), and secret-redaction audit of logging (Phase 3).

---

## 5. Execution plan

Phases will be executed in order, each with its own report and committed
separately, running the relevant regression suite before moving on:

- **Phase 1 — Auth & secrets:** SEC-002, SEC-007, SEC-001 (+ SEC-004 scoping).
- **Phase 2 — Authorization & tenant isolation:** SEC-003 + IDOR/BOLA sweep.
- **Phase 3 — Remote access:** host-key verification, path handling, secret redaction.
- **Phase 4 — Infrastructure:** SEC-005, SEC-006, BUG-001.
- **Phase 5 — Stability:** build/test/leak review.
- **Phase 6 — Final regression + `FINAL_SECURITY_STABILITY_REPORT.md`.**

No P0/P1 will be closed without an automated regression test where practical.
Existing security controls will not be weakened to make tests pass.
