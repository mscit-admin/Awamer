# Phase 3 — Session revocation (SEC-017) + WebSocket URL secrets (SEC-018)

## AWM-SEC-017 — Logout does not revoke server-side session (P1) — FIXED

### Root cause
`POST /logout` returned 204 and did nothing server-side; the refresh token
stayed valid to expiry.

### Fix
- `RefreshRepository.revoke(jti)` — revoke a single session (idempotent).
- `RefreshUseCase.logout(refreshToken)` — verify the presented refresh token and
  revoke exactly that session; idempotent on an invalid/expired token; audited.
  `RefreshUseCase.logoutAll(userId)` revokes every session.
- `POST /logout` now accepts `{ refresh_token }` and revokes that session;
  `POST /logout-all` (auth-gated) revokes all of the user's sessions.
- Frontend `authApi.logout(refreshToken)` + `authStore.logout()` now send the
  keyring/stored refresh token so the server revokes it before local wipe.

### Tests (integration, real PG) — `usecases/logout.itest.ts`
| Test | Assertion | Result |
| --- | --- | --- |
| LOGOUT-001 | refresh denied after logout | PASS |
| LOGOUT-002 | a copy captured before logout is also denied | PASS |
| LOGOUT-003 | logout A denies A, B still refreshes | PASS |
| LOGOUT-004 | logout-all denies every session | PASS |

**Access-token note:** access JWTs remain valid until their 15m TTL (stateless).
Refresh stops immediately (this fix) and admin disable/lock/role-change also
revoke (SEC-007/002). A token-version/denylist for instant access-token kill is
recorded as an optional future hardening; not required for the P1 gate.

## AWM-SEC-018 — Auth token in WebSocket URL (P1) — FIXED

### Root cause
`telnet`, `vnc`, `ws-tunnel` gateways read the JWT from `?token=` in the WS URL.

### Fix (per gateway, matched to its client protocol)
- **Telnet + WS-tunnel** (JSON-framed): reuse the SSH `awaitAuthFrame` — the
  token is the first WS frame `{"type":"auth","token":…}` over the channel; a
  10s deadline drops sockets that never authenticate; non-auth frames are
  ignored pre-auth. URL carries only non-secret `host_id`/`dst_*`.
  Telnet web client sends the frame in `ws.onopen`.
- **VNC** (raw noVNC RFB — cannot send a JSON frame first): a **one-time,
  single-use, 30s opaque ticket**. New `POST /api/v1/vnc/ticket`
  (Authorization-header authenticated, verifies host access) mints it; the
  client opens `…/vnc/connect?ticket=<opaque>`. The ticket is not a
  JWT/password/secret and is useless after one use/expiry. `VncTicketStore`
  is in-memory, single-use, TTL-swept.
- nginx `log_format noquery` (v1.1) still redacts query strings as
  defense-in-depth.

### Tests
| Test | Where | Result |
| --- | --- | --- |
| WS-001/003 (no URL token; invalid JWT denied) | `telnet/gateway.itest.ts` (real WS) | PASS |
| WS-005 (valid JWT proceeds) | `telnet/gateway.itest.ts` | PASS |
| WS-002/006 (no-frame timeout; pre-auth frames ignored) | `ssh/gateway.test.ts` (awaitAuthFrame, shared primitive) | PASS |
| VNC ticket single-use / expiry / unknown | `vnc/ticketStore.test.ts` | PASS |
| WS-007/008 (no JWT in logs) | nginx `noquery` + source gate below | PASS |

### Source gate
`grep` for `q.token` / `?token=` / `searchParams.set("token")` across
`src/ssh`, `src/vnc`, `src/telnet` and the desktop app → **no matches**.

## Suite after phase
Backend **77 unit / 31 integration**, backend + frontend `tsc` clean, frontend
`build` PASS.

## Regression risk
Medium (three handshakes + one client refactor changed). Mitigated by the WS
integration test, the shared/tested `awaitAuthFrame` primitive, ticket unit
tests, and green full suite + frontend build. The WS-tunnel gateway has no
current web client, so its conversion is backend-only.
