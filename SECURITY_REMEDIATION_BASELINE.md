# Awamer v1.1 — Security Remediation Baseline

**Date:** 2026-09-11 · **Branch:** `claude/nifty-johnson-u2dwye`
**Head commit:** `12b10a8` · **Working tree:** clean

> This baseline documents the state at re-verification. The seven findings in
> this gate (SEC-015/016/017/018/019, STAB-001, INFRA-001) were remediated,
> tested, committed on this branch, and are **already deployed and running in
> production** (verified live: real users completing login + cookie refresh).
> `PHASE_0_BASELINE.md` holds the original pre-fix verification; this file is
> the §3-named baseline with current evidence.

## Environment

| Item | Value |
| --- | --- |
| Node.js | v22.22.2 |
| npm | 10.9.7 |
| PostgreSQL | 16.13 (local, for `*.itest.ts`) |
| Redis | not a backend runtime dependency (no client in `package.json`/`src`) |
| Backend `tsc --noEmit` | ✅ PASS |
| Backend unit tests | ✅ 81/81 |
| Backend integration tests (real PG) | ✅ 38/38 |
| Frontend `tsc --noEmit` | ✅ PASS |
| Frontend `npm run build` | ✅ PASS |
| Frontend unit tests (vitest) | ✅ 13/13 |
| DB migrations `001`–`022` | ✅ apply on a fresh DB; also applied in production |
| Docker compose config | ✅ VALID; the `netsphere-*` stack runs healthy in prod |
| Nginx / reverse proxy | ✅ serving TLS + routing `/api` in production (live traffic) |
| Tauri native build | ⚠️ NOT VERIFIED in sandbox (browser is the shipped deployment) |

**Pre-existing failures:** none in runnable suites. The two frontend lint
errors (`VncPage.tsx`, `VpnServerPage.tsx` unused eslint-disable) are
pre-existing style items untouched by this work.

## Findings — status, affected routes/repositories

| ID | Sev | Status | Affected routes / repositories |
| --- | --- | --- | --- |
| SEC-016 custom-role escalation | P0 | FIXED | `routes/roles.ts`, `routes/admin.ts`, `repos/roleRepo.ts`, `domain/roleService.ts`, `domain/permissions.ts`, migration `022` |
| SEC-015 cross-company sharing | P0 | FIXED | `repos/sessionRepos.ts` (`setShares`/`list`/`getById`/`touch`), `repos/notesRepo.ts` (`setShares`/`list`), `domain/session.ts`, `routes/sessionRoutes.ts`, `routes/notes.ts` |
| SEC-017 logout revocation | P1 | FIXED | `routes/auth.ts` (`/logout`, `/logout-all`), `usecases/refresh.ts`, `repos/otherRepos.ts` (`RefreshRepository.revoke`) |
| SEC-018 WS URL tokens | P1 | FIXED | `telnet/gateway.ts`, `vnc/gateway.ts` (+ `vnc/ticketStore.ts`), `ssh/wsTunnelGateway.ts`, desktop `TelnetPage.tsx`/`VncPage.tsx` |
| SEC-019 browser refresh token | P2 | FIXED | `routes/auth.ts` + `routes/authCookies.ts`, desktop `shared/lib/api.ts`, `auth/api/authApi.ts`, `auth/store/authStore.ts`, `shared/lib/keyring.ts` |
| STAB-001 readiness | P2 | FIXED | `server.ts` (`/readyz`), `db/readiness.ts` |
| INFRA-001 API privilege | residual | DOCUMENTED | `deploy/docker-compose.production.yml`, `src/vpn/*` |

## Mandatory regression tests (all present + passing)
`routes/rbacRoles.itest.ts` (RBAC-001..008), `repos/tenantShares.itest.ts`
(SHARE-001..008), `usecases/logout.itest.ts` (LOGOUT-001..004),
`telnet/gateway.itest.ts` + `ssh/gateway.test.ts` + `vnc/ticketStore.test.ts`
(WS-001..006), `routes/authCookies.test.ts` + `routes/authCookieFlow.itest.ts`
(BROWSER-AUTH-001..006), `db/readiness.itest.ts` (READY-001..004), plus v1.1
`repos/tenantIsolation.itest.ts`, `usecases/refresh.test.ts`, `ssh/hostKeys.*`.

## Source & migration gates
- WS auth-secret gate: no `?token=`/`q.token`/`searchParams.set("token")` in any
  gateway or web client (only remaining `?token=` is the password-reset email
  link in `App.tsx` — a reset nonce, not a session/WS secret).
- Browser storage gate: no refresh token in `localStorage` (HttpOnly cookie).
- Migration gate: `001`–`022` apply on a fresh DB; `down`+`up` of the latest
  migrations succeeds (rollback-safe); applied non-destructively in production.
