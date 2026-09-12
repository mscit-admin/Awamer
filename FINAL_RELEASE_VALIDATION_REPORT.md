# Awamer / NetSphere Terminal — Final Release Validation Report

**Validation-only run** — no application code, tests, migrations, security logic,
config, or Nginx/Docker files were modified. The system was executed exactly as
committed and observed.

**Revision:** `0a33740` (`claude/nifty-johnson-u2dwye`, up to date with origin)
**Date:** 2026-09-12

---

## 1. Environment

| Item | Value |
| --- | --- |
| git revision | `0a33740ea24603d23f429b493a2f9132e8821b44` |
| Node.js | v22.22.2 |
| npm | 10.9.7 |
| OS | Ubuntu 24.04.4 LTS, kernel 6.18.44 |
| PostgreSQL | 16.13 (real server, localhost:5432) |
| Docker | 29.3.1 (CLI) — **daemon DOWN** in sandbox |
| Docker Compose | v5.1.1 |
| Nginx | 1.24.0 |
| Rust/Cargo | 1.94.1 |
| OpenSSH sshd | installed for validation (real handshake) |
| TigerVNC | 1.13.1 (real VNC server for validation) |
| node_modules at start | backend present, desktop present (both wiped + reinstalled clean) |

## 2. Commands Executed (summary)

Clean installs (`npm ci`), `tsc`/build for backend+frontend, `node dist/migrate.js up`
on fresh + upgrade DBs, `node --test`/`tsx --test` full suites, live backend boot
(`node dist/server.js`), real `sshd` on :2222, real `Xtigervnc` on :5991, a TCP
echo server, real WebSocket driver scripts (removed after use), `nginx -t` +
proxy routing, PostgreSQL stop/start, Docker compose config. Passwords/tokens were
never printed; temporary validation users/data were created.

## 3. Dependency Install Results

| | Result | Duration | Notes |
| --- | --- | --- | --- |
| backend `npm ci` | **PASS** (exit 0) | 11s | 324 pkgs; deprecation warnings; `npm audit`: 7 vulns (1 low, 2 mod, 4 high) |
| desktop `npm ci` | **PASS** (exit 0) | 10s | 310 pkgs; `npm audit`: 15 vulns (1 low, 8 mod, 5 high, **1 critical**) |

Advisories are dependency-scanner findings (mostly dev/build deps) — see Findings
F-1. Installs themselves succeeded reproducibly.

## 4. Build Results

| Gate | Result |
| --- | --- |
| Backend typecheck (`tsc --noEmit`) | **PASS** (0 errors) |
| Backend build (`tsc`) | **PASS** |
| Frontend typecheck (`tsc --noEmit`) | **PASS** (0 errors) |
| Frontend production build (`vite build`) | **PASS** |
| Tauri native packaging | **NOT VERIFIED** (browser SPA is the shipped client; native packaging not exercised in sandbox) |

## 5. PostgreSQL Results

Real PostgreSQL 16.13. Fresh validation DB `awamer_val`; upgrade DB `awamer_upg`.

## 6. Migration Results

| Test | Result | Evidence |
| --- | --- | --- |
| Fresh migrate 001→latest | **PASS** | 26 applied, latest=26, 0 skipped, 0 manual |
| Upgrade migrate (v20 → latest) | **PASS** | seeded 001–020, then applied to v26; no gap/unknown/duplicate/rollback |
| Invariants (fresh) | **PASS** | keys>48=0, tenant violations=0, duplicate keys=0 |
| Invariants (upgrade) | **PASS** | keys>48=0, tenant violations=0, `roles_key_len_chk` on `roles`=1 |
| Migration suite | **PASS** | MIG-RUNNER-001..028, MIG-CONSTRAINT, MIG-KEY, MIG-RBAC (37 in migrate/roleMigration/roleKeyLength subset) |

## 7. Unit / Integration / Security Results

| Suite | Passed | Failed | Skipped |
| --- | --- | --- | --- |
| Backend unit | 99 | 0 | 0 |
| Frontend (vitest) | 16 | 0 | 0 |
| Integration (real PG, all `*.itest.ts`) | 108 | 0 | 0 |
| CFG-BOOT-001..006 | 7 | 0 | 0 |
| AUTHZ-STATE-001..022 | 22 (across unit+integration) | 0 | 0 |
| MOVE-RBAC-001..008 | 8 | 0 | 0 |
| SEC-022 (activeSessions + sessionRevocation) | 22 | 0 | 0 |

Security-focused tests (auth, RBAC, tenant isolation, refresh reuse, logout,
disabled/locked/deleted, downgrade, company move, custom-role tenant, WS auth,
active-session revocation) are a subset of the 99 unit + 108 integration and all
pass (0 fail, 0 skip). Integration determinism confirmed (repeat run also 108/0/0
in prior session; single run this session).

## 8. Docker / Nginx Results

| Gate | Result | Evidence |
| --- | --- | --- |
| `docker compose config` (production) | **PASS** (valid) | parsed with validation env; migrate-gate `migrate.js up \|\| exit 1` intact |
| Production-like Docker **startup** | **NOT VERIFIED** | no Docker daemon in sandbox (`docker info` fails) |
| `nginx -t` (routing harness mirroring prod locations) | **PASS** | syntax ok |
| `nginx -t` on exact `deploy/nginx/netsphere.conf` | **NOT VERIFIED** | sandbox nginx **1.24.0** rejects `http2 on;` (needs ≥1.25.1); it is also a site-snippet requiring `http{}` context. Location blocks `/healthz` and `/readyz` present and correct (F-2) |
| Nginx `/readyz` routing (live, through nginx → backend) | **PASS** | `/readyz` → `{"status":"ready"}` 200 (backend JSON, **not** index.html); `/healthz` → 200; `/api/` reachable |

## 9. HTTP Auth / RBAC Results (live against the running backend)

| Test | Result | Evidence |
| --- | --- | --- |
| Login / access token | **PASS** | 200, access+refresh issued |
| Refresh rotation | **PASS** | 200, new pair |
| Refresh **reuse** rejection | **PASS** | old refresh → 401; new refresh after reuse → 401 (family revoked) |
| Logout / logout-all | **PASS** | 204 / 204 |
| Role downgrade → old JWT privileged request | **PASS** | admin token → 200; after downgrade to readonly, same token → **403** immediately |
| Disable → old JWT | **PASS** | `/users/me` 200 → after disable, same token → **401 `session_invalidated`** |
| Login rate-limit | **PASS (by design)** | first ~10 → 200, then 429 |

## 10. Tenant Isolation Results

Cross-company host/note isolation, custom-role tenant ownership, company move, and
destination-role validation are covered by `tenantIsolation.itest`,
`tenantShares.itest`, `moveRbac.itest` (MOVE-RBAC-001..008) and `rbacRoles.itest`,
all **PASS** within the 108-test integration suite against real PostgreSQL.

## 11. SSH Runtime Results (REAL sshd, TigerVNC-independent)

Real OpenSSH `sshd` on 127.0.0.1:2222; real SSH handshake confirmed
(`sshpass ssh … whoami` → `sshtest`).

| Test | Result | Evidence |
| --- | --- | --- |
| §36 SSH normal connection | **PASS** | through Awamer: status connected; `whoami` shell output contained `sshtest` (real SSH shell) |
| §37 Active SSH revoked on **disable** | **PASS** | disable via admin API → same live WS closed **code 4403 "authorization revoked" in 13 ms**; upstream TCP torn down; registry entry removed |
| §38 Active SSH revoked on **role downgrade** | **PASS** | downgrade to readonly → live WS closed 4403; upstream to :2222 dropped |
| §39 Active SSH revoked on **company move** | **PASS** | move A→B (role/permission kept) → live WS closed 4403 |
| §40 Other-user isolation | **PASS** | A & B both connected; disable A → A closed 4403, **B stayed connected**; established conns to :2222 dropped 4→2→0 as sessions were revoked |

## 12. Telnet Runtime Results

Real TCP endpoint (echo server). Establish → `is_active=false` → **WS closed 4403**,
upstream socket closed. **PASS** (§41).

## 13. Tunnel Runtime Results

Real SSH port-forward through the real `sshd` (:2222) to the TCP echo service.
Establish (status connected) → disable → **WS closed 4403**, upstream torn down.
**PASS** (§42).

## 14. VNC Runtime Results

**Real VNC server** (TigerVNC 1.13.1 on :5991; RFB 003.008 greeting relayed
through Awamer). Ticket issued → VNC session established → disable →
**WS closed 4403**. **PASS** (§43) — real VNC server, not a dummy.

## 15. Session Revocation Results

| Test | Result | Evidence |
| --- | --- | --- |
| §44 Registry cleanup | **PASS** | `countForUser`→0 after every revoke (automated asserts); live upstream conns 4→2→0 |
| §45 Periodic fallback (no event) | **PASS** | `is_active` flipped **directly in the DB** (no API event) → periodic loop closed the live SSH session **4403 in ~11.5 s** (15 s interval) |
| §46 DB failure during revalidation | **PASS** | 18 s PG outage spanning a loop tick → authorized session **stayed open (grace)**; after recovery still open and still revocable (disable→4403). Persistent-failure→fail-closed policy covered by AUTHZ-STATE-018 |

## 16. Restart / Recovery Results

| Test | Result | Evidence |
| --- | --- | --- |
| §47 Backend restart | **PASS** | prod-style `migrate up` → "no pending migrations"/complete; restart → healthz 200, readyz 200, login 200 |
| §49 PostgreSQL restart | **PASS** | before 200/200; PG down → healthz **200**, readyz **503**; PG up → 200/200 (recovered, no app restart) |
| §50 Stability smoke | **PASS** | 30/30 concurrent `/healthz` 200; server survived a 25-login burst (rate-limited by design); no uncaught exception; clean SIGTERM shutdown |

*(Nginx restart §48 not separately executed as a service; routing validated live
via a mirrored config against the running backend — see §8.)*

## 17. Secret / Log Review

**PASS.** Scans of all server logs found **0** occurrences of JWTs (`eyJ…`),
refresh tokens, passwords (`ChangeMe!2026`, `sshpass123`, validation passwords),
SSH private keys, or Authorization headers. The 4 `"severity":"FATAL"` strings in
the log are the **PostgreSQL wire-protocol severity** inside *handled* pool-error
entries (`pg pool error (idle client) — terminating connection due to
administrator command`) produced by the **deliberate** PG stop/start tests
(§46/§49); they were caught by the app's pool `error` handler, the process stayed
alive throughout, and shut down cleanly on SIGTERM. No uncaught exceptions.

## 18. Remaining Findings

| ID | Sev | Component | Finding | Production impact |
| --- | --- | --- | --- | --- |
| F-1 | Info/Review | dependencies | `npm audit`: backend 7 (4 high), desktop 15 (1 **critical** `@xmldom/xmldom`, 5 high). Mostly dev/build-time deps. Not runtime blockers; **recommend reviewing/patching** before release, esp. the critical. | Advisory; no runtime failure observed |
| F-2 | Low/Env | deploy/nginx | `netsphere.conf` uses `http2 on;` (nginx ≥1.25.1). Sandbox nginx 1.24.0 cannot `nginx -t` it. Routing + `/readyz` verified live via a mirrored config. **Production nginx must be ≥1.25.1.** | None if prod nginx ≥1.25.1 |
| F-3 | Env | Docker | No Docker daemon in sandbox → production-like container startup not executed (compose config is valid; migrate-gate intact). | Deployment-time verification pending on a Docker host |

No P0/P1 defect found. F-1 (critical dependency advisory) is recommended for
review prior to release but produced no runtime failure in validation.

## 19. Gate Matrix

| Gate | Result |
| --- | --- |
| Clean backend install | **PASS** |
| Clean frontend install | **PASS** |
| Backend typecheck | **PASS** |
| Backend build | **PASS** |
| Frontend typecheck | **PASS** |
| Frontend build | **PASS** |
| Fresh PostgreSQL migration | **PASS** |
| Upgrade PostgreSQL migration | **PASS** |
| Migration invariants | **PASS** |
| Full migration suite | **PASS** |
| Backend unit suite | **PASS** (99/0/0) |
| Frontend suite | **PASS** (16/0/0) |
| Integration suite | **PASS** (108/0/0) |
| Security suite | **PASS** |
| AUTHZ-STATE-001..022 | **PASS** (22/0/0) |
| CFG-BOOT-001..006 | **PASS** (7/0/0) |
| READY-DEPLOY-001..006 | **PASS** |
| Docker config | **PASS** |
| Production-like startup | **NOT VERIFIED** (no Docker daemon) |
| Nginx validation | **PARTIAL** — routing harness PASS; exact prod file NOT VERIFIED (nginx 1.24 vs `http2 on;` ≥1.25.1) |
| Nginx `/readyz` routing | **PASS** (backend JSON, not SPA) |
| Login/refresh/logout | **PASS** |
| Tenant isolation | **PASS** |
| Role downgrade old JWT | **PASS** |
| Disable old JWT | **PASS** |
| Real SSH connection | **PASS** |
| Active SSH disable revocation | **PASS** (4403, 13 ms) |
| Active SSH role revocation | **PASS** |
| Company-move SSH revocation | **PASS** |
| Telnet revocation | **PASS** |
| Tunnel revocation | **PASS** |
| VNC revocation | **PASS** (real VNC server) |
| Session registry cleanup | **PASS** |
| Periodic fallback | **PASS** (~11.5 s) |
| DB outage behavior | **PASS** |
| Restart recovery | **PASS** |
| Log secret review | **PASS** |

## 20. Final Production Decision

Every code, build, migration, security, and **runtime session-revocation** gate
PASSES, including real SSH/Telnet/TCP-tunnel/VNC revocation against real upstream
servers and the periodic-fallback + DB-outage behaviors. No P0/P1 defect was
found. Two **deployment-environment** validations could not be executed **in this
sandbox** (not code defects):

1. **Production-like Docker stack startup** — the sandbox has no Docker daemon
   (compose config is valid; the migrate-then-serve gate is intact).
2. **`nginx -t` on the exact `netsphere.conf`** — the sandbox nginx is 1.24.0
   while the config requires ≥1.25.1 for `http2 on;` (routing and `/readyz`
   behavior were verified live via a mirrored config).

Per the strict validation rule (§57–§58), because these two production-environment
checks remain unexecuted (and F-1's critical dependency advisory is recommended
for review), the verdict is:

# CONDITIONALLY PRODUCTION READY

**Remaining to execute on a real deployment host (no code changes expected):**
- Bring up `deploy/docker-compose.production.yml` with strong secrets and confirm:
  Postgres starts, `migrate.js up` succeeds, backend starts, Nginx serves,
  `/healthz` 200 and `/readyz` 200 (503 when DB down).
- Run `nginx -t` with the production `netsphere.conf` on nginx **≥1.25.1**
  (as included in the system `http{}` block with real TLS certs).
- Review/patch the `npm audit` advisories (F-1), especially the desktop critical
  `@xmldom/xmldom`.

All application-level and runtime-security guarantees required for release are
demonstrated and passing on this exact revision.
