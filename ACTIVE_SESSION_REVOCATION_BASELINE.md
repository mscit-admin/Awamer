# Active Session Revocation Baseline — AWM-SEC-022

**Branch:** `claude/nifty-johnson-u2dwye` · **Head at baseline:** `9be6093`
**Finding:** long-lived remote sessions (SSH/Telnet/TCP-tunnel/VNC) are validated
against live account state only at connection establishment (AWM-SEC-021). Once
established, they are never revalidated, so an already-open session survives a
disable/lock/delete/role-downgrade/company-move until the client disconnects.

## Long-lived channels + lifecycle (audited)

| Channel | File | Upstream resource | Auth check | Close today |
| --- | --- | --- | --- | --- |
| SSH WS | `ssh/gateway.ts` | `ssh2` `Client` (`conn`) + timers (idle/stats/ping) | first-frame token → `verifyAccess` + `assertAuthState` + `can(role,"sessions:connect")` | `ws.on("close")`→`conn.end()`+timers; `conn.on("close")`→`ws.close()` |
| Telnet WS | `telnet/gateway.ts` | `net.Socket` (`sock`) | same (`sessions:connect`) | `ws.on("close")`→`sock.destroy()`; `sock.on("close")`→`ws.close()` |
| TCP tunnel WS | `ssh/wsTunnelGateway.ts` | `ssh2` `Client` (`conn`) forwardOut | same (`tunnels:manage`) | `ws.on("close")`→`conn.end()`; `conn.on("close")`→`ws.close()` |
| VNC WS | `vnc/gateway.ts` | `net.Socket` (`sock`) | one-time ticket (issue gated by `assertAuthState`), redeem re-validates | `ws.on("close")`→`sock.destroy()`; `sock.on("close")`→`ws.close()` |
| SFTP WS | `ssh/sftpGateway.ts` | request/response over `makeAuthMiddleware` | per-request live check (HTTP-style) | request-scoped, not a persistent shell — **no persistent privileged session to revoke** (documented; each op re-checks live state) |

There is **no central registry** of active sessions today. Cleanup is local to
each socket's close/error handlers, and is already idempotent-ish (guards on
`ws.readyState`, try/catch around `conn.end()`/`sock.destroy()`).

## Where live auth state is checked today

- HTTP: `makeAuthMiddleware(jwt, users)` (AWM-SEC-021) — per request.
- WS: each gateway calls `assertAuthState(users, sub)` + `can(liveRole, perm)` at
  connect only.

## Security-relevant state-change routes (where revocation must be emitted)

- `routes/admin.ts` `PATCH /users/:id` — role / `is_active` / `is_locked`
  (already `refresh.revokeAllForUser` on those). 
- `routes/admin.ts` `DELETE /users/:id`.
- `routes/organization.ts` `PUT /users/:id/assignment` — company move + role
  (`users.setOrg`, transactional).
- Auto-lockout on failed logins (`users.setLockedUntil` in the login flow) — not
  an admin action; covered by the periodic fallback.

## Multi-instance? (§15)

Production runs a **single** `auth-service` container
(`deploy/docker-compose.production.yml`) — no horizontal replicas. An in-memory
registry with immediate event revocation is therefore sufficient today. The
periodic per-instance revalidation loop (below) additionally keeps every instance
correct within one interval even if replicas are added later (each instance
revalidates its own sessions against the shared DB), so cross-node correctness
degrades only to the revalidation interval, never to "never".

## Chosen design (event-driven + periodic fallback)

- New `session/activeSessions.ts` — `ActiveSessionManager`:
  - `register/unregister` (by sessionId; indexed by userId).
  - `revokeUser(userId, reason)` — unconditionally close all of a user's sessions
    (disable/lock/delete/**company move**).
  - `revalidateUser(userId)` — load live state: user missing→`USER_DELETED`,
    inactive→`USER_DISABLED`, locked→`USER_LOCKED`, else close sessions whose
    `requiredPermission` the live role lacks (`PERMISSION_REVOKED`). Used by the
    role-change event and the periodic loop.
  - `startPeriodic()` — one shared loop (default 15s, `unref`'d) over unique
    active userIds → `revalidateUser` each. Fail-closed on **persistent** DB
    failure (3 consecutive transient failures → revoke), grace on a single blip
    (AUTHZ-STATE-018). Distinguishes `user_not_found` (delete) from transient DB
    errors.
  - Idempotent close (unregister-before-close so an event + periodic double hit is
    a no-op; AUTHZ-STATE-021), audit event per revocation (no secrets).
- Each gateway registers on successful connect and unregisters on close; its
  `close(reason)` terminates **both** the WS (code `4403`, reason) and the
  upstream (`conn.end()`/`sock.destroy()`) and clears its timers (§16/§43).
- Role change → `revalidateUser`; disable/lock → `revalidateUser` (closes all);
  delete → `revokeUser(USER_DELETED)`; company move → `revokeUser(COMPANY_CHANGED)`.
  Emitted **after** the DB commit (§8). Existing refresh revocation is kept.

## Test/build baseline (to re-verify)

Backend 88 unit + 97 integration (real PG16), frontend 16; AUTHZ-STATE-001..008,
CFG-BOOT, READY-DEPLOY, MIG-*, MOVE-RBAC all green at `9be6093`; invariants 0/0/0.
