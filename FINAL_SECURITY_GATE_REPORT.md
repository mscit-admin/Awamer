# Awamer v1.1 — Final Security Gate Report

**Branch:** `claude/nifty-johnson-u2dwye`
**Verification:** backend suites run against a real migrated PostgreSQL 16;
frontend built and tested; migrations applied fresh + rollback-checked; infra
configs validated where a runtime exists in this sandbox.

## Gate dashboard

| Security Gate | Result |
| --- | --- |
| Custom-role privilege escalation | **PASS** |
| Cross-company explicit sharing | **PASS** |
| Logout revocation | **PASS** |
| WebSocket URL secrets | **PASS** |
| Browser refresh-token security | **PASS** |
| Tenant isolation | **PASS** |
| IDOR/BOLA | **PASS** |
| Role assignment security | **PASS** |
| PostgreSQL readiness | **PASS** |
| Build (backend + frontend) | **PASS** |
| Unit tests | **PASS** (backend 81, frontend 13) |
| Integration tests | **PASS** (38, real PostgreSQL) |
| Security regression suite | **PASS** (all mandatory TEST-* below) |
| Docker security | **PARTIAL** (least-privilege applied; root retained for VPN — INFRA-001) |
| Tauri | **NOT VERIFIED** (native build not runnable in this sandbox; config valid, web build passes) |
| Browser deployment | **PASS** (in-browser cookie/CSP smoke test recommended at deploy) |
| Nginx configuration | **NOT VERIFIED** (nginx not installed here; `nginx -t` must run on the target host) |

## Findings tally (this cycle)

| ID | Severity | Status |
| --- | --- | --- |
| AWM-SEC-016 custom-role escalation | P0 | FIXED |
| AWM-SEC-015 cross-company sharing | P0 | FIXED |
| AWM-SEC-017 logout revocation | P1 | FIXED |
| AWM-SEC-018 WS URL tokens | P1 | FIXED |
| AWM-SEC-019 browser refresh token | P2 | FIXED |
| AWM-STAB-001 readiness | P2 | FIXED |
| AWM-INFRA-001 API privilege | residual | DOCUMENTED (not eliminated) |

- **Total findings:** 7
- **P0 remaining:** 0
- **P1 remaining:** 0
- **P2 remaining:** 0
- **P3 remaining:** 0
- **Fixed:** 6
- **Partially fixed / residual (documented):** 1 (INFRA-001)
- **Unresolved (P0/P1/P2 code defects):** 0
- **False positives:** 0
- **Not verified (environment-limited):** `nginx -t`, Tauri native build,
  in-browser cookie/CSP smoke test.

## Mandatory tests — evidence

All run against a real PostgreSQL (`*.itest.ts`) or as unit tests (`*.test.ts`):

- **RBAC-001..008** (`routes/rbacRoles.itest.ts`) — PASS (ceiling, tenant-owned
  roles, assignment guards, super-admin allowed).
- **TENANT-SHARE-001..008** (`repos/tenantShares.itest.ts`) — PASS (foreign
  recipient denied, no partial share, stale share denied on read, credential
  path denied).
- **AUTH-LOGOUT-001..004** (`usecases/logout.itest.ts`) — PASS (revoke current,
  stolen copy, per-session, logout-all).
- **WS-001/003/005** (`telnet/gateway.itest.ts`, real WS) + **WS-002/006**
  (`ssh/gateway.test.ts` awaitAuthFrame) + VNC ticket (`vnc/ticketStore.test.ts`)
  — PASS. Source gate: no `?token=`/`q.token` in any WS flow.
- **BROWSER-AUTH-001/003/004/005/006** (`routes/authCookies.test.ts`,
  `routes/authCookieFlow.itest.ts`) — PASS (HttpOnly, SameSite=Strict, cookie
  refresh, logout clears + revokes, rotated cookie rejected; Tauri body flow
  unchanged).
- **READY-001..004** (`db/readiness.itest.ts`) — PASS.
- **Tenant isolation / SEC-003** (`repos/tenantIsolation.itest.ts`, v1.1) — PASS.
- **Refresh account-state / SEC-002** (`usecases/refresh.test.ts`, v1.1) — PASS.

## Source & migration gates
- WS auth-secret gate: no `?token=`/`q.token`/`password=`/`passphrase=` in any
  gateway or web client. The only `?token=` in the codebase is the
  **password-reset email link** (`App.tsx`) — a reset nonce, not a WS/session
  secret; reviewed, acceptable.
- Browser storage gate: no refresh token in `localStorage` (moved to HttpOnly
  cookie).
- Migration gate: migrations `001`–`022` apply cleanly on a **fresh** database;
  `down`+`up` of the latest migrations succeeds (rollback-safe). No destructive
  reset used.

## Accepted / residual risk (does not block a security defect)
**AWM-INFRA-001** — the production API runs as root with `NET_ADMIN` + tun for
the built-in OpenVPN. Compensating controls shipped: `cap_drop: ALL` keeping
only `NET_ADMIN`, `no-new-privileges`, private network, named volumes.
Remediation plan: VPN sidecar + unprivileged API. Owner: platform. This is a
residual infra risk, not a P0/P1/P2 code defect, and does not by itself force
rejection under §20.

---

## Decision

# NOT APPROVED FOR PRODUCTION

**Important:** this verdict is **not** due to any unresolved security finding.
Every P0/P1/P2 finding is fixed with a passing regression test, and all mandatory
security gates PASS. Approval is withheld strictly because two **critical
deployment-path validations cannot be executed in this sandbox** and the gate
rules (§15/§19) forbid marking a critical path PASS without real evidence:

### Exact blocking items (environment-limited verifications, not defects)
1. **Nginx configuration** — `nginx -t` could not run (nginx not installed here).
   Run on the target host after installing `deploy/nginx/netsphere.conf`:
   ```
   sudo cp deploy/nginx/netsphere.conf /etc/nginx/sites-available/netsphere
   sudo sed -i "s/netsphere\.example\.com/<your-host>/g" /etc/nginx/sites-available/netsphere
   sudo nginx -t && sudo systemctl reload nginx
   ```
2. **In-browser cookie + CSP smoke test** (browser deployment) — confirm, in a
   real browser against the deployed SPA: login (HttpOnly `awamer_refresh`
   cookie set; refresh token NOT in `localStorage`/JS), page reload keeps the
   session, logout clears it, and no CSP violations on the terminal / VNC /
   TOTP-QR / AI panel / **KeePass import (WASM)**.
3. **Tauri native build** (only if the desktop app is shipped) —
   `npm run tauri:build`; the web build and `tauri.conf.json` already pass here.

Once items 1–3 pass on the target environment, all §19 approval conditions are
met (P0=0, P1=0, every listed gate PASS, no critical path NOT VERIFIED) and the
release is approvable. No further code changes are required for the security
gate.
