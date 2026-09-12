# Awamer — Final Production Acceptance Report

**Branch:** `claude/nifty-johnson-u2dwye`
**Scope:** AWM-SEC-021 (stale access-token authorization), AWM-CFG-001 (unsafe
production bootstrap password), AWM-STAB-002 (`/readyz` production wiring), plus
the §29/§30 doc/CORS items. All prior migration/RBAC/tenant/session controls
preserved.
**Verification:** executed against real **PostgreSQL 16**; a production-mode
server boot (real login) and a real **nginx 1.24** routing test were run. No gate
is claimed from source inspection alone.

## Acceptance matrix

| Gate | Result |
| --- | --- |
| AWM-SEC-021 fixed | **PASS** |
| Role downgrade invalidates old token | **PASS** (AUTHZ-STATE-001) |
| Company move invalidates old token | **PASS** (AUTHZ-STATE-002) |
| Disable invalidates old token | **PASS** (AUTHZ-STATE-003) |
| Lock invalidates old token | **PASS** (AUTHZ-STATE-004) |
| WebSocket stale-token rejection | **PASS** (AUTHZ-STATE-006/007: SSH/Telnet/tunnel/VNC) |
| AWM-CFG-001 fixed | **PASS** |
| Production missing bootstrap secret | **PASS** (rejected — CFG-BOOT-001) |
| Production default secret rejected | **PASS** (CFG-BOOT-002; live boot exit 1) |
| Strong production secret accepted | **PASS** (CFG-BOOT-004; live boot + login) |
| AWM-STAB-002 fixed | **PASS** |
| Public `/readyz` routed correctly | **PASS** (nginx e2e → backend JSON, not SPA) |
| DB-down readiness = 503 | **PASS** (READY-DEPLOY-002; nginx e2e 503 JSON) |
| Deployment waits for readiness | **PASS** (install.sh/update.sh gate on `/readyz`) |
| Backend typecheck | **PASS** |
| Backend build | **PASS** |
| Frontend typecheck | **PASS** |
| Frontend build | **PASS** |
| Unit tests | **PASS** (88) |
| Integration tests | **PASS** (97, real PG) |
| Migration regression | **PASS** (MIG-RUNNER-001..028, MIG-CONSTRAINT, MIG-KEY, MIG-RBAC) |
| Security regression | **PASS** (MOVE-RBAC-001..008 + auth/tenant/session suites) |
| Fresh DB install | **PASS** (001→026, invariants 0, boot+login) |
| Upgrade DB | **PASS** (v20 → v26, invariants 0) |
| Docker config | **PASS** (`docker compose config` valid; migrate-gate intact) |
| Nginx validation | **PASS** (`nginx -t` ok; `/readyz`,`/healthz`→backend, SPA fallback) |

*Docker container runtime:* NOT VERIFIED — no Docker daemon in the sandbox
(`docker info` fails). This is **not** a §53 approval condition; the
production-mode smoke test below stands in for a live rollout. Compose config is
valid and the container command still gates the server behind
`migrate.js up || exit 1`.

## Actual test counts (re-run this cycle)

```
Backend unit:            Passed 88   Failed 0   Skipped 0
Frontend:                Passed 16   Failed 0   Skipped 0
Integration (real PG):   Passed 97   Failed 0   Skipped 0
Migration (subset):      Passed 37   Failed 0   Skipped 0   (MIG-RUNNER/CONSTRAINT/KEY/RBAC)
Security (subset):       Passed 110  Failed 0   Skipped 0   (AUTHZ-STATE, CFG-BOOT, RBAC, tenant, auth, ssh, crypto)
Deployment acceptance:   Passed 7    Failed 0   Skipped 0   (READY-DEPLOY + readiness) + fresh/upgrade/nginx/boot below
```
New this cycle: `middleware/authState.itest.ts` (AUTHZ-STATE-001..005,008),
`middleware/authStateWs.itest.ts` (AUTHZ-STATE-006/007),
`config/bootstrapConfig.test.ts` (CFG-BOOT-001..006),
`db/readyDeploy.itest.ts` (READY-DEPLOY-001..006).

## §50 — AWM-SEC-021 evidence (automated, real PG)

`AUTHZ-STATE-001` (executed): login as `admin` → token works on the privileged
route (200) → role changed to `readonly` in the DB → **the same token is denied
(403)** on the next call, and `/me` reports the live role `readonly`. No wait for
token expiry. `AUTHZ-STATE-002` proves the same for a company move + downgrade;
003/004/005 for disable/lock/delete (→ 401 `session_invalidated`); 006/007 for
SSH/Telnet/tunnel WS (stale token → `invalid_token`) and VNC (ticket issuance
denied 401, redemption re-validated). `AUTHZ-STATE-008` confirms no false
invalidation for an unchanged user.

## §51 — AWM-CFG-001 evidence (executed)

```
production + BOOTSTRAP_ADMIN_PASSWORD=ChangeMe!2026 (default):
  fatal: Error: BOOTSTRAP_ADMIN_PASSWORD ... in production   → process exit 1 (no bootstrap)
production + strong secret:
  server boots, /readyz 200, login as admin → 200, /users/me → super_admin
```
CFG-BOOT-001..006 assert missing→FAIL, default→FAIL, placeholder→FAIL,
too-short→FAIL, strong→PASS, dev-default→PASS (dev only), and that the rejection
message never contains the password.

## §52 — AWM-STAB-002 evidence (executed)

```
Backend (real server), DB available:   /healthz 200   /readyz 200 {"status":"ready"}
Backend, DB unavailable (dead pool):   /healthz 200   /readyz 503 {"status":"not_ready"}
Through nginx 1.24 (nginx -t ok):
   GET /readyz  → {"status":"ready"}  (HTTP 200)   — backend JSON, NOT index.html
   GET /readyz  → {"status":"not_ready"} (HTTP 503) after DB toggled down
   GET /healthz → {"status":"ok"}     (HTTP 200)
```
Nginx now has `location = /readyz` proxying to the backend (mirrors `/healthz`);
`install.sh`/`update.sh` gate rollout success on `/readyz` (curl `-f` → non-zero
on 503, so a DB-down backend is never declared a successful deploy). `/healthz`
kept for container liveness (documented split).

## §39 — Database invariants (fresh-install DB, after boot)

```sql
SELECT COUNT(*) FROM roles WHERE char_length(key) > 48;                      -- 0
SELECT COUNT(*) FROM users u JOIN roles r ON r.key=u.role
  WHERE r.is_builtin=FALSE AND u.company_id IS DISTINCT FROM r.company_id;   -- 0
SELECT key, COUNT(*) FROM roles GROUP BY key HAVING COUNT(*)>1;              -- 0 rows
```
Upgrade DB (v20→v26): same invariants = 0; `roles_key_len_chk` present on `roles`.

## Code evidence

### AWM-SEC-021 — FIXED
- **Root cause:** `makeAuthMiddleware` set `req.auth` from JWT claims only;
  `requireRole`/`requirePermission`/`requireWrite` and the WS gateways evaluated
  `can(claims.role, …)` on the **stale** token role (up to 15-min window). No DB
  state check.
- **Affected files:** `middleware/auth.ts`, `ssh/gateway.ts`, `telnet/gateway.ts`,
  `ssh/wsTunnelGateway.ts`, `vnc/gateway.ts`, and every route factory (now passes
  `users` to the middleware) + `server.ts` wiring.
- **New behavior (§7 Option B, centralized):** `assertAuthState(users, sub)` loads
  the live user and rejects deleted/disabled/locked accounts; `makeAuthMiddleware`
  additionally replaces `req.auth.role` with the **live DB role**, so authorization
  never trusts the token role. The same guard runs in the SSH/Telnet/tunnel WS
  auth paths and at VNC ticket issue **and** redemption. Refresh revocation on
  admin changes is unchanged. No token/version migration required.
- **Validation location:** HTTP — `makeAuthMiddleware` preHandler (all authed
  routes); WS — inside each gateway's auth block before any host/session work.
- **Tests:** AUTHZ-STATE-001..008. **Commands:**
  `DATABASE_URL=… npx tsx --test src/middleware/authState.itest.ts src/middleware/authStateWs.itest.ts`.
  **Result:** 10/10 PASS.
- **Remaining risk:** one indexed PK lookup per authenticated request (accepted;
  many routes already loaded the user). No stale-authorization window remains.

### AWM-CFG-001 — FIXED
- **Root cause:** `BOOTSTRAP_ADMIN_PASSWORD` defaulted to `ChangeMe!2026` and was
  accepted in production, bootstrapping a super_admin with a known password.
- **Affected file:** `config/index.ts` (+ `server.ts` bootstrap runs only after
  `loadConfig`).
- **New behavior:** in `APP_ENV=production`, `assertProductionBootstrapPassword`
  requires an explicit secret ≥16 chars that is not a known placeholder
  (case-insensitive deny-set + "changeme"/"change_me"/"change-me" substrings),
  else `loadConfig` throws → non-zero exit **before** any bootstrap. Dev keeps the
  convenience default. Password never logged or included in errors.
- **Tests:** CFG-BOOT-001..006. **Command:**
  `npx tsx --test src/config/bootstrapConfig.test.ts`. **Result:** 7/7 PASS; live
  production boot with the default exits 1.
- **Remaining risk:** none; placeholder policy is reasonable (not an exhaustive
  dictionary), backed by the ≥16-char + explicit-secret requirement.

### AWM-STAB-002 — FIXED
- **Root cause:** nginx proxied `/healthz` but not `/readyz` (SPA fallback would
  return index.html); deploy scripts gated on `/healthz` only.
- **Affected files:** `deploy/nginx/netsphere.conf`, `deploy/scripts/install.sh`,
  `deploy/scripts/update.sh`.
- **New behavior:** `location = /readyz` proxies to the backend; rollout scripts
  wait for `/readyz` 200. Liveness (`/healthz`, Docker healthcheck) vs readiness
  (`/readyz`, proxy + deploy gate) documented and kept distinct.
- **Tests:** READY-DEPLOY-001..006 + live nginx routing. **Result:** PASS.
- **Remaining risk:** none for the wiring; Docker container runtime not executed
  in-sandbox (daemon unavailable) — compose config validated.

## §29 / §30 / §31

- **§29:** the stale nginx comment implying a WS token may appear in `?token=…`
  is corrected to describe first-frame auth + VNC ticket (no session JWT in any
  WS URL). WS behaviour unchanged.
- **§30:** `X-Awamer-Client` (sent by the web build) added to CORS
  `allowedHeaders` so cross-origin browser operation passes preflight; no
  wildcard-with-credentials introduced. Same-origin prod needs no CORS.
- **§31:** the privileged VPN container (root + NET_ADMIN + /dev/net/tun) is an
  accepted, documented residual; not changed. Future option: a dedicated VPN
  sidecar.

## Findings

```
P0 remaining: 0
P1 remaining: 0
P2 remaining: 0

Fixed:            AWM-SEC-021, AWM-CFG-001, AWM-STAB-002
Unresolved:       none
Accepted residual: privileged VPN container (§31, unchanged); migration checksum
                   (identity is version+name, no content checksum — prior cycles' P3);
                   Docker container runtime NOT VERIFIED in sandbox (config valid).
```

---

## Decision

# APPROVED FOR PRODUCTION

**P0 = 0, P1 = 0.** All three blockers are fixed and verified with executed tests
against real PostgreSQL 16 (and real nginx):

- **AWM-SEC-021** — authorization now reflects live account state on HTTP and
  every WS channel; a downgraded/moved/disabled/locked/deleted user's old access
  token is rejected immediately (AUTHZ-STATE-001..008 PASS; live evidence shows a
  role downgrade denying the old token with no expiry wait).
- **AWM-CFG-001** — production refuses to start with a missing, default, or
  placeholder bootstrap password (CFG-BOOT-001..006 PASS; live boot with the
  default exits 1); a strong secret boots and logs in.
- **AWM-STAB-002** — `/readyz` is proxied to the backend (verified through real
  nginx: backend JSON, not SPA, 200 when the DB is up and 503 when down), and the
  deploy scripts gate rollout on readiness.

MIG-RUNNER-001..028, MIG-CONSTRAINT-001..002, MIG-KEY-001..010, MIG-RBAC-001..006
and MOVE-RBAC-001..008 all PASS; role keys > 48 = 0, tenant custom-role
violations = 0, duplicate role keys = 0; backend/frontend typecheck + build pass;
fresh-install and upgrade migrations pass with invariants clean; `nginx -t` and
`docker compose config` are valid. No mandatory gate is FAIL, SKIPPED, or
NOT VERIFIED (the only NOT-VERIFIED item, Docker container runtime, is not a
required approval condition and is covered by a production-mode server smoke
test).
