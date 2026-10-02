# Final Test Results

All results come from runs executed during this phase on commit `4e5d4bd4ecf382d13aa2bb880063de779d9a0aaa`. Environment: Node 22.22 (host) / Node 20.20.2 (container), PostgreSQL 16, Rust 1.97.

## Baseline (before any change in this phase)

| Suite | Total | Passed | Failed | Skipped |
|---|---:|---:|---:|---:|
| Backend unit | 282 | 282 | 0 | 0 |
| Backend integration (PostgreSQL 16) | 220 | 220 | 0 | 0 |
| Frontend | 23 | 23 | 0 | 0 |
| **Total** | **525** | **525** | **0** | **0** |

This matches the previous assessment's 525.

## Final

| Test Category | Total | Passed | Failed | Skipped |
|---|---:|---:|---:|---:|
| **Backend Unit** | 299 | 299 | 0 | 0 |
| **Integration** (real PostgreSQL 16) | 227 | 227 | 0 | 0 |
| **Frontend** | 23 | 23 | 0 | 0 |
| **Desktop SSH live** (Rust, real OpenSSH; 8 checks) | 1 | 1 | 0 | 0 |
| **Total automated** | **550** | **550** | **0** | **0** |
| *Category views of the backend tests (counted per file, each file once):* | | | | |
| Authentication (JWT, cookies, refresh, login/logout, auth-state & credential-change invalidation incl. WS, password reset, account) | 81 | 81 | 0 | 0 |
| RBAC (permissions, role service, custom roles, key length, migration, assignment) | 33 | 33 | 0 | 0 |
| Tenant Isolation (tenantIsolation, tenantNullScope, tenantShares) | 21 | 21 | 0 | 0 |
| Privilege Escalation (`finalSecurity.itest`: target ceiling, instance settings, MFA bypass, refresh, logout-all) | 11 | 11 | 0 | 0 |
| MFA (crypto, fail-closed, step-up, step-up/auth-version, TOTP) | 40 | 40 | 0 | 0 |
| SSRF (AI safeFetch, remote-session destinations, diagnostics policy, netCidr, netScope) | 65 | 65 | 0 | 0 |
| VPN Security (profiles, server config, ports, repos, PKI, helper core/firewall/IPC/protocol, reconfigure) | 116 | 116 | 0 | 0 |
| Remote Sessions (active-session revocation, SSH gateway, host keys, Telnet, VNC tickets) | 40 | 40 | 0 | 0 |
| Platform (DB least privilege, compose contracts, production config, proxy trust, migrations, readiness, version, logging redaction, audit durability, crypto) | 119 | 119 | 0 | 0 |

The category views sum to 526 = 299 + 227. Each file was also run individually: 69 files, 526 tests, 0 failed, 0 skipped.

**Skipped tests: none.** The integration suites skip only when `DATABASE_URL` is unset, and it was set for every run. The SSH live test skips when `AWAMER_SSH_TEST_PORT` is unset; it was set, and it ran.

## New tests added in this phase (all PASS)

| Test | File |
|---|---|
| DBLP-001…007 | `backend/src/db/leastPrivilege.itest.ts` |
| PROD-CFG-001…005 | `backend/src/config/productionHardening.test.ts` |
| LOG-REDACT-001/002 | `backend/src/logger/redaction.test.ts` |
| VERSION-001…003 | `backend/src/version.test.ts` |
| COMPOSE-DB-001…003, COMPOSE-HARDEN-001, COMPOSE-REL-001 | `backend/src/vpn-helper/composeDbIdentity.test.ts` |
| PKI-SERIAL-001/002 | `backend/src/vpn/pki.test.ts` |
| SSH-LIVE-001…008 | `desktop/src-tauri/src/commands/ssh_live_test.rs` |

## Static gates

| Check | Result |
|---|---|
| Backend `tsc --noEmit` / `npm run lint` / `npm run build` | PASS / PASS (0 errors) / PASS |
| Frontend `tsc --noEmit` / `npm run lint` / `npm run build` | PASS / PASS (0 errors) / PASS |
| `cargo check --locked` (Tauri crate) | PASS |
| `scripts/check-release-version.mjs 1.8.0` | PASS |
| `docker compose … config` (generated secrets) | PASS |

## Production smoke tests

`backend/scripts/smoke-production.mjs`, 60 checks:
- health, monitoring, traceability, API docs;
- auth, MFA, session refresh/rotation/logout;
- tenants, RBAC, credentials;
- SSH (interactive) and SSRF;
- VPN;
- audit.

| Target | Result |
|---|---|
| S1: native `dist/` build of the working tree *before* commit A was cut (it reported the base SHA `8d015bc`), `APP_ENV=production`, `awamer_app` role, real OpenSSH target | **60/60 PASS** |
| S2: **exact commit `4e5d4bd`** built from `git archive` in `node:20-alpine`, run with uid 10001 + read-only rootfs + `cap_drop ALL` + no-new-privileges | **60/60 PASS** (`evidence/smoke-commitA-container.txt`) |
| Startup negative tests (production): superuser DB / migration-owner DB / `ENABLE_API_DOCS` / `http://` CORS | **4/4 refused** (exit 1, clear message) |
| About screen via the real web UI | `Version 1.8.0 · Commit 4e5d4bd4ecf3 · Server 1.8.0 (4e5d4bd4ecf3)` (`evidence/about-screen.png`); the login page shows `v1.8.0` |
| Log secret scans (S1, S2) | 0 occurrences of 12+ live secret values/patterns |

## Not verified (explicit)

| Item | Status |
|---|---|
| Final production images built and run | **BLOCKED BY ENVIRONMENT** (Alpine package mirror denied) |
| VPN tunnel establishment (OpenVPN client/server data plane) | **BLOCKED BY ENVIRONMENT**: no OpenVPN, tun or NET_ADMIN helper in this sandbox. VPN *workflow* (profile create/validate/reveal, injection rejection, tenant isolation) verified; helper logic covered by 116 VPN tests with a fake spawn |
| Tauri desktop bundle (`tauri build`) | NOT VERIFIED: crate compiles; bundling not attempted |
