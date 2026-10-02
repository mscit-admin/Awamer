# Security Test Results

Every number here comes from commands **executed during this assessment** (2026-10-02),
in a sandbox with Node 22.22, PostgreSQL 16 and Rust/cargo 1.97. Historical results
from earlier reports were not reused.

## 1. Environment and installation

| Step | Command | Result |
|---|---|---|
| Backend deps | `npm ci` (from `package-lock.json`) | VERIFIED, 324 packages. Re-run after the lockfile updates: clean |
| Desktop deps | `npm ci` | VERIFIED, 310 packages. Re-run after updates: clean |
| Lockfiles | — | Not silently regenerated. They were changed **only** by the deliberate, documented security updates in `DEPENDENCY_SECURITY_REPORT.md` |
| Database | PostgreSQL 16, database dropped and recreated, then `migrate.ts up` | VERIFIED: 28/28 migrations applied to a fresh DB |
| Integration secrets | `JWT_*`, `CREDENTIAL_ENCRYPTION_KEY` generated per run with `openssl rand` | test-only, never committed |

**A note on the first baseline run.** The first baseline integration run reported 201 failures.
That was an **environment** error: the JWT secrets had not been exported, and the config loader
correctly refused to start (`JWT_ACCESS_SECRET: Required`). Re-run with the secrets set, the
baseline was **209/209 passing**. That run is the baseline used below.

## 2. Totals

| Suite | Baseline `8a8fb5b` | Final (remediated) | Failed | Skipped |
|---|---|---|---|---|
| Backend unit (`npm test`, `*.test.ts`) | 263 / 263 | **282 / 282** | 0 | 0 |
| Backend integration (`npm run test:integration`, real PostgreSQL) | 209 / 209 | **220 / 220** | 0 | 0 |
| Frontend unit (`vitest run`) | not run at baseline | **23 / 23** | 0 | 0 |
| **Total (final)** | | **525 passed** | **0** | **0** |

There are no skipped tests. The integration suites skip only when `DATABASE_URL` is unset,
and it was set for every run.

## 3. Build verification

| Build | Result |
|---|---|
| Backend `npx tsc --noEmit` | VERIFIED, exit 0 |
| Backend `npm run build` (clean `dist/`) | VERIFIED, exit 0 |
| Frontend `npx tsc --noEmit` | VERIFIED, exit 0 |
| Frontend `npm run build` (Vite production, clean `dist/`) | VERIFIED, exit 0 |
| Desktop Rust `cargo check --locked` (Tauri crate) | VERIFIED, exit 0, including after the rustls/quinn-proto lock update |
| Desktop `tauri build` (bundling) | NOT VERIFIED: bundling/installers were not attempted. `cargo check` compiles the full crate |
| Docker `backend/Dockerfile`, `Dockerfile.vpn-helper` | **BLOCKED BY ENVIRONMENT**: see below |

**Docker build detail.** `dockerd` was started successfully, but the builds could not complete:
1. The sandbox's TLS-intercepting proxy is not trusted inside the image (`server certificate not trusted`).
2. With the proxy CA injected into a scratch copy of the Dockerfile, the proxy returned
   **HTTP 403** for `dl-cdn.alpinelinux.org`, and Docker Hub returned **429**.

None of these failures concerns the Dockerfiles. The one change made to them (`npm ci` with
`package-lock.json`) was verified by running `npm ci` cleanly on the same lockfiles. A real
image build must be done in CI (condition C-3 in `PRODUCTION_ACCEPTANCE.md`).

## 4. Regression tests added in this assessment

**Proven against the baseline** means the new test file was copied into a clean worktree of
`8a8fb5b` and run there. "FAILS" in that column means the bug is real and the test detects it.

| Test ID | File | Finding | On baseline | On final |
|---|---|---|---|---|
| FINAL-MFA-001 | `routes/finalSecurity.itest.ts` | MFA bypass (challenge token used as session) | **FAILS** | PASS |
| FINAL-MFA-002 | same | MFA challenge still works, and access token ≠ challenge | PASS | PASS |
| FINAL-MFA-003 | same | MFA brute force across re-logins; failures audited | **FAILS** | PASS |
| FINAL-CEIL-001 | same | admin → co-located super_admin takeover | **FAILS** | PASS |
| FINAL-CEIL-002 | same | admin still manages users; user admin audited | **FAILS** (no audit) | PASS |
| FINAL-CEIL-003 | same | helpdesk (`users:manage`) demotes its admin | **FAILS** | PASS |
| FINAL-INST-001 | same | company admin changes instance SMTP/branding/session policy | **FAILS** in an isolated run (PUT `/admin/smtp` → **200**). In the full-file run it passed only because CEIL-003 had already demoted the admin; documented, not hidden | PASS |
| FINAL-INST-002 | same | super_admin manages SMTP; change audited | **FAILS** (no audit) | PASS |
| FINAL-INST-003 | same | admin cannot mint a `settings:manage` role | PASS (permission did not exist) | PASS |
| FINAL-REFRESH-001 | same | concurrent refreshes of one token | PASS. The race **did not reproduce** in-process (1×200, 3×401); the fix is defensive | PASS |
| FINAL-LOGOUTALL-001 | same | logout-all kills access token + live sessions | **FAILS** | PASS |
| MFA-TYP-001..004 | `jwt/mfaPendingType.test.ts` | challenge-token type separation | 001 passes (new issuance only); **002–004 FAIL** | PASS |
| TOTP-REPLAY-001 | `usecases/mfaFailClosed.test.ts` | TOTP replay within its window | **FAILS** | PASS |
| BACKUP-KDF-001 | `crypto/backupCrypto.test.ts` | genuine backup round-trips (no regression) | PASS | PASS |
| BACKUP-KDF-002 | same | attacker scrypt parameters (CPU DoS) | **FAILS** | PASS |
| BACKUP-KDF-003, SECRETBOX-TAG-001 | same | truncated GCM tag accepted | **FAIL** | PASS |
| VPN-CFG-001/002 | `domain/vpnServer.test.ts` | VPN-server `cipher` config injection (root RCE) | **FAIL** | PASS |
| OVPN-FILE-001 | `domain/vpn.test.ts` | client `.ovpn` root file read/write, management, route hijack | **FAILS** | PASS |
| OVPN-FILE-002 | same | legitimate inline profiles still accepted | PASS | PASS |
| helperCore pull-filter assertion | `vpn-helper/helperCore.test.ts` | server-pushed `redirect-gateway` filtered | n/a | PASS |
| REMOTE-DEST-001..006 | `usecases/remoteDestination.test.ts` | Telnet/VNC/SSH SSRF to metadata, loopback, Docker network; encoded IPs; rebinding | n/a (new module) | PASS |

### Fixes verified by code review only (no automated test)

These are stated plainly rather than implied to be covered:

| Change | Why it has no automated test |
|---|---|
| Server-managed `ssh -L` tunnels and SFTP sessions registered with `ActiveSessionManager`; SFTP live-role re-check per operation | Needs a live SSH/SFTP server; the existing revocation suite's fake server does not implement SFTP or `-L` forwarding |
| Gateways connect to the policy-checked IP (`ssh`, `sftp`, `telnet`, `vnc`, `wsTunnel`, `tunnelManager`) | Policy logic is unit-tested. The integration suites drive the Telnet/SSH/VNC gateways end-to-end with loopback explicitly enabled, which proves the wiring did not break them |
| Login-grade rate limits on forgot/reset-password, verify-password, step-up | The itest harnesses do not register `@fastify/rate-limit` |
| WebSocket `maxPayload` 2 MiB | Plugin option |
| Audit entries on SMTP / branding / session-settings | SMTP is asserted (FINAL-INST-002); branding and session settings by code review |

## 5. Required security suites: coverage

| Suite | Status | Main tests |
|---|---|---|
| Authentication | VERIFIED | login.itest, authCookieFlow.itest, refresh.test, FINAL-MFA-*, logout.itest |
| RBAC | VERIFIED | rbacRoles.itest (TEST-RBAC-001..008), permissions.test, roleService tests, FINAL-INST-003 |
| Privilege escalation | VERIFIED | FINAL-CEIL-001/003, TEST-RBAC-005/006, VPN-CFG-*, OVPN-FILE-* |
| Tenant isolation | VERIFIED | tenantIsolation, tenantNullScope, tenantShares, moveRbac itests; FINAL-INST-001 |
| IDOR | VERIFIED (code + itests) | tenantShares/tenantIsolation itests; inventory in `TENANT_ISOLATION_TESTS.md` |
| MFA | VERIFIED | mfaStepUp, mfaStepUpAv, mfaCrypt itests; mfaFailClosed; FINAL-MFA-*; TOTP-REPLAY-001 |
| Session revocation | VERIFIED (SSH/Telnet/VNC/WS-tunnel); CODE (SFTP/REST tunnels) | sessionRevocation, authInvalidate(Ws), authState(Ws) itests; FINAL-LOGOUTALL-001 |
| Credential reveal | VERIFIED (code + existing tests) | sessionMeta reveal is permission-gated and audited |
| SSRF | VERIFIED | safeFetch.test (AI), networkPolicy.test, REMOTE-DEST-001..006 |
| Injection | VERIFIED | VPN-CFG-*, OVPN-FILE-*, helperCore tests; SQL review (all parameterised) |
| Audit | VERIFIED | auditDurability.test, FINAL-CEIL-002, FINAL-INST-002, FINAL-MFA-003 |
| WebSocket authorization | VERIFIED | authStateWs, authInvalidateWs, telnet gateway, sessionRevocation itests |
| Remote-session authorization | VERIFIED | same, plus hostKeys tests and vnc ticketStore.test |
