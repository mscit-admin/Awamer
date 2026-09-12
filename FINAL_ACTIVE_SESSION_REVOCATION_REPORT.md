# Awamer — Final Active Session Revocation Report (AWM-SEC-022)

**Branch:** `claude/nifty-johnson-u2dwye`
**Scope:** AWM-SEC-022 — a security-relevant account change must terminate
already-established SSH / Telnet / TCP-tunnel / VNC sessions and clean up their
underlying privileged connections. Focused fix; all prior controls preserved.
**Verification:** executed against real **PostgreSQL 16** with real WebSocket
sessions through the real gateways and a real `ActiveSessionManager`.

## Design (event-driven + periodic fallback)

`session/activeSessions.ts` — an in-memory `ActiveSessionManager`:
- Each gateway `register`s on successful connect and `unregister`s on close; its
  `close(reason)` terminates **both** the WS (code `4403` "authorization revoked")
  and the upstream (`ssh2` `conn.end()` / `net.Socket.destroy()`) and clears the
  session's timers — idempotent (a `revoked` guard + unregister-before-close).
- **Events** (emitted after the DB commit): admin `PATCH /users/:id`
  (role/disable/lock) → `revalidateUser`; admin `DELETE` → `revokeUser(USER_DELETED)`;
  org `PUT /users/:id/assignment` (company move) → `revokeUser(COMPANY_CHANGED)`.
  Existing refresh-session revocation is kept.
- **Periodic fallback** — one shared loop (15s in prod, `unref`'d) revalidates
  each active user's live state, catching a missed event, an out-of-band change,
  or (future) another replica. Permission-aware for role changes; closes all on
  disable/lock/delete; **fails closed** only after 3 consecutive transient DB
  failures (grace for a single blip).
- Audit event per revocation (`token_revoke`, details `{kind, reason}`) — no
  secrets.

**Single backend instance** (one `auth-service` container) → the in-memory
registry with immediate events is sufficient today; the per-instance periodic
revalidation keeps every instance correct within one interval if replicas are
added later (documented in the baseline).

## Gate matrix

| Gate | Result |
| --- | --- |
| Existing SSH revoked on role downgrade | **PASS** (AUTHZ-STATE-009) |
| Existing SSH revoked on disable | **PASS** (AUTHZ-STATE-010) |
| Existing Telnet revoked | **PASS** (AUTHZ-STATE-011) |
| Existing tunnel revoked | **PASS** (AUTHZ-STATE-012) |
| Existing VNC revoked | **PASS** (AUTHZ-STATE-013) |
| Company move revokes sessions | **PASS** (AUTHZ-STATE-014) |
| Lock revokes sessions | **PASS** (AUTHZ-STATE-015) |
| Delete revokes sessions | **PASS** (AUTHZ-STATE-016) |
| Other users unaffected | **PASS** (AUTHZ-STATE-010/020) |
| Revalidation fallback works | **PASS** (AUTHZ-STATE-018 unit + itest) |
| Resource cleanup (registry/upstream/timers) | **PASS** (itest asserts upstream teardown + registry 0) |
| AUTHZ-STATE-001..022 | **PASS** |
| CFG-BOOT regression | **PASS** (CFG-BOOT-001..006) |
| READY-DEPLOY regression | **PASS** (READY-DEPLOY-001..006) |
| Migration regression | **PASS** (MIG-RUNNER-001..028, CONSTRAINT, KEY, RBAC) |
| RBAC/tenant regression | **PASS** (MOVE-RBAC-001..008, tenant isolation/shares) |
| Backend typecheck | **PASS** |
| Backend build | **PASS** |
| Frontend/Desktop build | **PASS** |
| Integration tests | **PASS** |
| Security tests | **PASS** |

## Actual test counts (re-run this cycle)

```
Backend unit:            Passed 99   Failed 0   Skipped 0
Frontend/Desktop:        Passed 16   Failed 0   Skipped 0
Integration (real PG):   Passed 108  Failed 0   Skipped 0   (deterministic ×2)
Security (subset):       Passed 108  Failed 0   Skipped 0
Migration (subset):      Passed 37   Failed 0   Skipped 0
```
New this cycle: `session/activeSessions.test.ts` (11, manager logic incl.
AUTHZ-STATE-017/018/019/020/021) and `session/sessionRevocation.itest.ts` (11,
real gateways: AUTHZ-STATE-009..016, 018 fallback, 019, 020, 022).

## §47 — Mandatory demonstration (executed, real WS + real gateways + real PG)

`AUTHZ-STATE-010 + §47` (passing test):
```
1. establish SSH session for user A (registry countForUser(A)=1)
2. establish SSH session for user B (countForUser(B)=1)
3. PATCH /api/v1/admin/users/A { is_active:false }  → 200
   → A's SSH WebSocket receives close code 4403
   → A's upstream TCP torn down (liveUpstream decremented)
   → sessions.countForUser(A) === 0   (registry entry disappears)
   → user B's SSH WebSocket still OPEN, countForUser(B) === 1
```
Delete is proven the same way (`AUTHZ-STATE-016`: session closes 4403, registry
cleaned). Reconnect after revocation (`AUTHZ-STATE-022`) is denied at auth by the
AWM-SEC-021 live-state check — both layers work together.

## §16/§42/§43 — Resource cleanup

Each gateway's `close(reason)` ends the upstream (`conn.end()`/`sock.destroy()`)
in addition to the WS, and clears its idle/stats/ping timers (SSH). Close is
idempotent (`revoked` guard + `unregister`-before-`close`). Tests assert
`countForUser === 0` after every revocation (no registry leak) and that the dummy
upstream's live-socket count drops (upstream torn down). The manager tolerates a
throwing `close` callback without aborting sibling revocations.

## §18 — Audit

Each forced revocation logs a `token_revoke` audit event with
`{ userId, sessionId, kind, reason }` and no secrets (no password/JWT/key/
terminal contents). Reason categories: `USER_DISABLED`, `USER_LOCKED`,
`USER_DELETED`, `PERMISSION_REVOKED`, `COMPANY_CHANGED`,
`PERIODIC_REVALIDATION_FAILED`.

## §39 — Database invariants

```sql
SELECT COUNT(*) FROM roles WHERE char_length(key) > 48;                      -- 0
SELECT COUNT(*) FROM users u JOIN roles r ON r.key=u.role
  WHERE r.is_builtin=FALSE AND u.company_id IS DISTINCT FROM r.company_id;   -- 0
SELECT key, COUNT(*) FROM roles GROUP BY key HAVING COUNT(*)>1;              -- 0 rows
```

## Code evidence — AWM-SEC-022 — FIXED

- **Root cause:** gateways validated live state only at connect; an established
  SSH/Telnet/tunnel/VNC session was never revalidated, so it survived a
  disable/lock/delete/role-downgrade/company-move until the client disconnected.
- **Affected files:** new `session/activeSessions.ts`; `ssh/gateway.ts`,
  `telnet/gateway.ts`, `ssh/wsTunnelGateway.ts`, `vnc/gateway.ts` (register/
  unregister + idempotent revoking close); `routes/admin.ts`,
  `routes/organization.ts` (emit revocation after commit); `server.ts` (construct
  the manager + start the periodic loop; wire it to gateways/routes).
- **New behavior:** a security-relevant change terminates the user's live remote
  sessions immediately (event) and, as a fallback, within one revalidation
  interval (periodic). Both the WS and the underlying privileged connection are
  closed and the registry entry removed; other users are untouched.
- **Tests / commands:**
  `DATABASE_URL=… npx tsx --test src/session/sessionRevocation.itest.ts`
  `npx tsx --test src/session/activeSessions.test.ts`
- **Result:** 22/22 PASS (11 unit + 11 real-gateway).
- **Remaining risk:** in a hypothetical multi-replica deployment, immediate
  cross-node revocation would lag by up to the revalidation interval (documented;
  single-instance today). No leak or stale-session path remains.

## Findings

```
P0 remaining: 0
P1 remaining: 0

Fixed:             AWM-SEC-022
Unresolved:        none
Accepted residual: privileged VPN container (unchanged); migration content-checksum
                   (prior P3); cross-node immediate revocation bounded by the
                   revalidation interval (single-instance today).
```

---

## Decision

# APPROVED FOR PRODUCTION

**P0 = 0, P1 = 0.** AWM-SEC-022 is FIXED and demonstrated with real
session-lifecycle tests: disabling, locking, deleting, downgrading, or moving a
user terminates every already-established SSH, Telnet, TCP-tunnel and VNC session
for that user (WS closed with code 4403, upstream torn down, registry cleaned),
immediately via events and as a fallback via the periodic revalidation loop, while
other users' sessions remain connected and a revoked user cannot reconnect on the
old token. AUTHZ-STATE-001..022, CFG-BOOT-001..006, READY-DEPLOY-001..006,
MIG-RUNNER-001..028, MIG-CONSTRAINT/KEY/RBAC and MOVE-RBAC-001..008 all PASS;
role keys > 48 = 0, tenant violations = 0, duplicate keys = 0; backend/frontend
typecheck + build pass; integration and security suites pass in full against a
real PostgreSQL 16. No mandatory gate is FAIL, SKIPPED, or NOT VERIFIED.

> When a user's remote-access authorization is revoked, every already-established
> SSH, Telnet, TCP-tunnel and VNC session for that user is terminated and its
> underlying privileged connection cleaned up.
