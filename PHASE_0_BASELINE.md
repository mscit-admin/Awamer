# Phase 0 — Security Remediation Baseline (Awamer v1.1)

**Date:** 2026-09-10 · **Branch:** `claude/nifty-johnson-u2dwye`
**Head:** `9720b12` · **Working tree:** clean

## Environment

| Item | Value |
| --- | --- |
| Node.js | v22.22.2 |
| npm | 10.9.7 |
| PostgreSQL | 16.13 (local cluster, used for `*.itest.ts`) |
| Redis | not required by backend at runtime (no client dep) |
| Backend `tsc --noEmit` | ✅ PASS |
| Backend unit tests | ✅ 73/73 |
| Backend integration tests (real PG) | ✅ 9/9 |
| Frontend `tsc`/`build`/`vitest` | ✅ PASS / PASS / 13/13 (from prior cycle) |
| `@fastify/cookie` | not installed (needed for SEC-019 cookie option) |

No pre-existing application-code test failures. Two pre-existing **frontend
lint** errors (`VncPage.tsx`, `VpnServerPage.tsx` — unused eslint-disable) are
environment/style, not app defects, and untouched by this work.

Prior remediation already shipped (v1.1): SEC-001 (SSH gateway channel-auth),
SEC-002, SEC-003 (host/notes company scoping — **is_shared branch only**),
SEC-005, SEC-006, SEC-007 (admin-action revocation), SEC-008 (host-key pinning),
BUG-001. This cycle addresses the newly-identified blockers.

---

## Finding verification

### AWM-SEC-016 — Custom-role privilege escalation
- **Status:** CONFIRMED (P0)
- **Evidence:** `backend/src/routes/roles.ts` POST `/` (57-78) and PATCH `/:id`
  (87-113) gate only on `requirePermission("users:manage")` and
  `validatePerms` (catalog membership). **No permission-ceiling check** — the
  actor may add *any* catalog permission, including `companies:manage`,
  `credentials:reveal`, `ai:manage`, that they do not themselves hold.
  `migrations/007_custom_roles.up.sql` has **no `company_id`** on `roles`, so
  custom roles are global — any `users:manage` admin in any company can edit any
  custom role.
- **Exploit path:** Tenant Admin A (has `users:manage`, not `companies:manage`)
  → `PATCH /api/v1/roles/{ownRoleId}` adding `companies:manage` →
  `roleService.reload()` → A's already-issued JWT (role X) now resolves the new
  permission → cross-tenant powers. Also: Admin A edits Company B's custom role.
- **Affected files:** `routes/roles.ts`, `domain/permissions.ts`,
  `repos/roleRepo.ts`, `migrations/007…`.
- **Required fix:** server-side ceiling (`requested ⊆ actor effective perms`),
  a global-only permission set (`companies:manage`) grantable only by
  super-admin, and tenant ownership on `roles` (migration + scoped
  list/get/update/delete). Assignment path already guarded by `mayGrantRole`.
- **Tests required:** TEST-RBAC-001..008.
- **Regression risk:** Medium — touches role CRUD + adds a roles column.

### AWM-SEC-015 — Cross-company explicit sharing bypass
- **Status:** CONFIRMED (P0)
- **Evidence:** `HostRepository.setShares` (`sessionRepos.ts` 718-738) and
  `NotesRepository.setShares` (`notesRepo.ts` 97-116) insert `host_shares` /
  `note_shares` for **any** user UUID with **no company check**. Worse, the
  Phase-2 read scoping only company-scoped the `is_shared = TRUE` branch — the
  `EXISTS (host_shares … user_id=$1)` / `note_shares` branch is **not**
  company-scoped, so an explicit cross-company share fully bypasses tenant
  isolation (visibility **and** shared-host credential-backed connect).
- **Exploit path:** Company A owner `PUT /hosts/{id}/shares` with a Company B
  user UUID → B sees the host and connects with A's server-side credential.
- **Affected files:** `repos/sessionRepos.ts`, `repos/notesRepo.ts`,
  `routes/sessionMeta.ts`/notes routes (share endpoints).
- **Required fix:** validate every recipient `company_id == resource.company_id`
  in `setShares` (reject whole op on any mismatch); AND company-scope the
  `host_shares`/`note_shares` read branch (defense in depth).
- **Tests required:** TEST-TENANT-SHARE-001..008.
- **Regression risk:** Medium — same-company sharing must still work.

### AWM-SEC-017 — Logout does not revoke server-side session
- **Status:** CONFIRMED (P1)
- **Evidence:** `routes/auth.ts` `/logout` (158-161) returns 204 and does
  nothing server-side; the refresh token remains valid until expiry.
- **Affected files:** `routes/auth.ts`, `usecases/*`, `repos/otherRepos.ts`
  (`RefreshRepository`), `desktop` auth store.
- **Required fix:** `/logout` revokes the current refresh session (needs the
  refresh token / its jti); add `/logout-all` revoking all user sessions.
- **Tests required:** TEST-AUTH-LOGOUT-001..004.
- **Regression risk:** Low.

### AWM-SEC-018 — Auth token in WebSocket URL (remaining gateways)
- **Status:** CONFIRMED (P1)
- **Evidence:** `telnet/gateway.ts:89`, `vnc/gateway.ts:32`,
  `ssh/wsTunnelGateway.ts:43` read `q.token` from the URL. (SFTP is REST with
  header auth — not affected. SSH was fixed in v1.1.)
- **Affected files:** the 3 gateways + their web clients (`TelnetPage.tsx`,
  `VncPage.tsx`, tunnel client).
- **Required fix:** reuse the SSH `awaitAuthFrame` channel-auth (token in the
  first WS frame; 10s deadline; reject non-auth frames pre-auth).
- **Tests required:** TEST-WS-001..008 per gateway.
- **Regression risk:** Medium — 3 handshakes change.

### AWM-SEC-019 — Browser refresh token in localStorage
- **Status:** CONFIRMED (P2, browser only)
- **Evidence:** `desktop/src/shared/lib/keyring.ts` falls back to `localStorage`
  for the browser build (Tauri uses the OS keyring). Script-readable → XSS
  blast-radius.
- **Required fix:** `HttpOnly; Secure; SameSite` refresh cookie for the browser
  build + CSRF control; keep Tauri keyring. Needs `@fastify/cookie` (absent).
- **Tests required:** TEST-BROWSER-AUTH-001..006.
- **Regression risk:** High (dual-mode auth) — P2, does not block the P0/P1 gate.

### AWM-STAB-001 — `/readyz` does not test dependencies
- **Status:** CONFIRMED (P2)
- **Evidence:** `server.ts:216` `/readyz` returns a static `{status:"ready"}`;
  no DB probe. `/healthz` (215) returns `{status:"ok"}` (correct for liveness).
- **Required fix:** `/readyz` runs `SELECT 1` with a short timeout → 200/503;
  `/healthz` stays dependency-free.
- **Tests required:** TEST-READY-001..004.
- **Regression risk:** Low.

### AWM-INFRA-001 — API retains root + NET_ADMIN + TUN
- **Status:** CONFIRMED (residual, risk-managed in v1.1)
- **Evidence:** `deploy/docker-compose.production.yml` — `user:"0:0"`,
  `cap_add: NET_ADMIN`, tun device. v1.1 added `cap_drop: ALL` + only NET_ADMIN
  + `no-new-privileges`. Full API/VPN process separation not yet done.
- **Required fix / decision:** document reason (openvpn `ip` child needs root on
  this kernel), attack surface, compensating controls, and the sidecar plan.
  Cannot be claimed "eliminated".

---

## Remediation order (this cycle)
1. SEC-016 (P0) 2. SEC-015 (P0) 3. SEC-017 (P1) 4. SEC-018 (P1)
5. SEC-019 (P2) 6. STAB-001 (P2) 7. INFRA-001 (document).
Build + tests + regression after each phase.
