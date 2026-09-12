# Final Production Remediation Baseline

**Branch:** `claude/nifty-johnson-u2dwye` · **Head at baseline:** `4ca2012`
**Scope:** AWM-SEC-021, AWM-CFG-001, AWM-STAB-002 — confirm each finding before
changing code.

## AWM-SEC-021 — stale access-token authorization (P1) — CONFIRMED

- **Where role is read for authorization:** `backend/src/middleware/auth.ts`.
  `makeAuthMiddleware(jwt)` verifies the JWT and sets `req.auth` from token
  claims only — **no DB lookup**. `requireRole`, `requirePermission`,
  `requireWrite` all evaluate `can(req.auth.role, …)` against the **JWT role**.
- **JWT claims** (`backend/src/jwt/index.ts`): `{ sub, typ, role, jti, iat, exp }`.
  The access token embeds `role`; there is no auth/security version claim.
- **Token lifetime:** `JWT_ACCESS_TTL` default `15m`; refresh default `168h`.
- **Routes that change security-relevant state:**
  - `routes/admin.ts` — `POST /users` (create w/ role), `PATCH /users/:id`
    (role/active/locked), `DELETE /users/:id`, reset-password, disable-mfa. It
    already calls `refresh.revokeAllForUser` on disable/lock/role-change.
  - `routes/organization.ts` — `PUT /users/:id/assignment` (company move + role)
    via transactional `users.setOrg`. **Does not** revoke refresh or invalidate
    access.
  - `routes/roles.ts` — role permission edits (`roleService.reload()` makes new
    permissions live for `can()` since `can` resolves through the role service,
    but a *reassigned* user still carries the old role in their token).
- **Refresh revocation:** present on admin disable/lock/role change; does NOT
  invalidate an already-issued **access** token (the exploit window).
- **WebSocket auth paths** (all read the token from the first frame / ticket,
  never the URL — SEC-018 preserved):
  - `ssh/gateway.ts:133`, `telnet/gateway.ts:107`, `ssh/wsTunnelGateway.ts:68` —
    `deps.jwt.verifyAccess(token)` then `can(claims.role, …)` on the **JWT role**,
    no DB state check.
  - `ssh/sftpGateway.ts` and `vnc/gateway.ts` `POST /ticket` use
    `makeAuthMiddleware(deps.jwt)` (same stale-role gap).
- **Conclusion:** a user moved/downgraded/disabled/locked keeps their old
  privileges for up to the 15-minute access-token TTL, on HTTP **and** every WS
  channel. Confirmed.
- **Chosen fix (§7 Option B — permitted alternative):** a centralized live
  auth-state check. `makeAuthMiddleware(jwt, users)` loads the user by `sub`,
  rejects if the account is missing (deleted), inactive (disabled) or locked, and
  **replaces `req.auth.role` with the live DB role** so authorization never
  trusts the stale token role. The same check (`assertAuthState`) is applied in
  the SSH/Telnet/tunnel WS gateways and the VNC ticket issue + redeem paths.
  This inherently covers role change, company move, disable, lock and delete with
  no per-route version bookkeeping and no migration. Refresh revocation is kept.
  (Company/tenant scope already reads the live company from the DB, so no stale
  company is trusted either.)

## AWM-CFG-001 — unsafe production bootstrap password (P1) — CONFIRMED

- `backend/src/config/index.ts`:
  `BOOTSTRAP_ADMIN_PASSWORD: z.string().min(8).default("ChangeMe!2026")`.
  In production the built-in default `ChangeMe!2026` (or any weak/placeholder
  value) is accepted, and `bootstrapAdmin` (`server.ts`) hashes it and creates a
  **super_admin** when the users table is empty.
- `loadConfig()` already does environment-aware validation (rejects dev JWT
  secrets in production), so it is the right place to add a production bootstrap
  rule.
- **Conclusion:** production can create a Super Admin with a known default
  password. Confirmed.
- **Chosen fix:** in `loadConfig`, when `APP_ENV=production`, require
  `BOOTSTRAP_ADMIN_PASSWORD` to be explicitly set, ≥16 chars, and not a known
  placeholder (`ChangeMe!2026`, `changeme`, `password`, `admin123`, `CHANGE_ME`,
  `CHANGE_ME_IN_PRODUCTION`, `default`, …, case-insensitively). Fail closed
  (throw, non-zero exit) **before** any bootstrap. Development keeps the
  convenience default (documented). The password is never logged or echoed.

## AWM-STAB-002 — `/readyz` not wired into production (P2 / release blocker) — CONFIRMED

- Backend implements both endpoints: `/healthz` (liveness) and `/readyz`
  (`db/readiness.ts` — `SELECT 1`, 200/503). ✔ preserve.
- **Nginx** (`deploy/nginx/netsphere.conf`): `location = /healthz` is proxied to
  the backend, but there is **no** `location = /readyz` — the SPA `location /`
  `try_files … /index.html` would serve **index.html** for `/readyz`.
- **Docker** (`deploy/docker-compose.production.yml:156`): container healthcheck
  uses `/healthz` (liveness) — appropriate to keep for liveness.
- **Deploy scripts:** `deploy/scripts/update.sh:70` and `install.sh:113` gate
  rollout success on `/healthz` only — a backend that is up but cannot reach the
  DB would be declared "healthy".
- **Conclusion:** readiness is not exposed publicly and not used as the rollout
  gate. Confirmed.
- **Chosen fix:** add `location = /readyz` (proxy to `127.0.0.1:8081/readyz`,
  `access_log off`); keep `/healthz` for container liveness; change the deploy
  scripts' rollout-success criterion to require `/readyz` (200). Documented model:
  liveness=`/healthz` (Docker healthcheck), readiness=`/readyz` (reverse proxy +
  deploy gate).

## Also in scope (docs/config)

- **§29 stale nginx comment:** `netsphere.conf:31-35` claims "WebSocket gateways
  may still carry a short-lived access token in the query (?token=…)". The
  gateways read the token from the **first WS frame** (confirmed
  `ssh/gateway.ts:120-126`) / VNC one-time **ticket** — no token in any WS URL.
  Update the comment only; do not change WS behaviour.
- **§30 CORS `X-Awamer-Client`:** review backend `allowedHeaders` vs the browser
  header; production browser is same-origin behind nginx — document, and only add
  the header to `allowedHeaders` if missing (no wildcard-with-credentials).
- **§31 privileged VPN container:** accepted, documented residual (unchanged).

## Test/build baseline (to be re-verified after changes)

Backend unit 81, integration 83 (real PG16), frontend 16; migration/RBAC suites
green; DB invariants 0/0/0 at head `4ca2012`.
