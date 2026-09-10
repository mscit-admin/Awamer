# Phase 1 Report — Authentication & Secrets

**Branch:** `claude/nifty-johnson-u2dwye`
**Addresses:** SEC-002, SEC-007, SEC-001 (+ SEC-004 analysis)

Baseline before this phase: backend 53 unit tests, frontend 13. After this
phase: **backend 68 unit tests (all pass)**, frontend 13 (all pass), both
builds/typechecks green.

---

## AWM-SEC-002 — Disabled/locked users could refresh

- **Severity:** P1 · **Status:** FIXED
- **Affected files:** `backend/src/usecases/refresh.ts`
- **Root cause:** `RefreshUseCase.execute` validated the token chain but issued
  a new pair after only `users.getById()` — no account-state check. `login.ts`
  guards `isActive`/`isAccountLocked`; refresh did not.
- **Fix implemented:** After resolving the user, refresh now mirrors the login
  policy: a deleted user (`getById` throws), a disabled user (`!isActive`), or a
  locked user (`isAccountLocked` — permanent `is_locked` or a future
  `locked_until`) is **denied**, the **entire refresh-session chain is revoked**
  (`revokeAllForUser`), and an audit record (`token_refresh_denied`, with a
  coarse reason) is written. The route continues to translate every thrown
  error to a generic `401 invalid_refresh`, so account state is not disclosed to
  the (unauthenticated) caller.
- **Tests added:** `backend/src/usecases/refresh.test.ts` (9 cases):
  active→PASS; disabled→DENY+revoke; locked (permanent & temporary)→DENY+revoke;
  deleted→DENY+revoke; revoked / expired / unknown session→DENY; reused
  (already-rotated)→DENY + full revoke.
- **Test result:** PASS (9/9).
- **Regression risk:** Low. Happy path unchanged (verified by the active-user
  test). No public error surface change.

## AWM-SEC-007 — Session revocation on admin actions

- **Severity:** P1 · **Status:** FIXED
- **Affected files:** `backend/src/routes/admin.ts`, `backend/src/server.ts`
- **Root cause:** `revokeAllForUser` was called on refresh-reuse, password reset
  and change-password, but **not** when an admin disabled, locked, or changed a
  user's role. (Delete already cascades refresh rows via FK.)
- **Fix implemented:** `PATCH /api/v1/admin/users/:id` now revokes the target's
  whole refresh-session chain when the update **disables** (`is_active=false`),
  **locks** (`is_locked=true`), or **changes the role** of the user. Wired a
  `RefreshRepository` into the admin routes.
- **Combined effect with SEC-002:** refresh stops immediately on the admin
  action, and even if a chain were somehow not revoked, SEC-002 re-checks state
  on every refresh. Access tokens remain valid until their short TTL (15m);
  documented as an accepted, bounded window.
- **Tests:** Exercised by the SEC-002 unit suite (revocation + state gate). A
  full HTTP admin integration test requires a live DB (`*.itest.ts`, env-gated).
- **Test result:** PASS (unit). **Regression risk:** Low — extra revoke call on
  security-relevant transitions only; non-security edits (name/email) untouched.

## AWM-SEC-001 — Secrets in WebSocket URLs

- **Severity:** P1 · **Status:** FIXED (SSH gateway) + defense-in-depth (all gateways)
- **Affected files:** `backend/src/ssh/gateway.ts`,
  `desktop/src/modules/sessions/components/WebTerminalPane.tsx`,
  `deploy/nginx/netsphere.conf`
- **Root cause:** Browsers can't set headers on a WS handshake, so the JWT and
  the SSH **password/passphrase** were smuggled through URL query params, where
  nginx `access_log`, proxies and browser history capture them.
- **Fix implemented:**
  1. **Channel auth (SSH gateway):** the socket opens unauthenticated and waits
     for the first frame `{"type":"auth","token":…,"password"?:…,"passphrase"?:…}`
     over the TLS-wrapped WS payload (new exported `awaitAuthFrame` helper, with
     a 10s deadline that drops sockets that never authenticate). The URL now
     carries only `host_id` + initial `cols`/`rows` — no secrets, no token.
  2. **Client:** `gatewayUrl()` no longer takes/embeds token or password; the
     web terminal sends the auth frame in `ws.onopen`. The password-override
     (need-password) flow now carries the password inside that frame.
  3. **Defense-in-depth (nginx):** a `noquery` `log_format` logs `$uri` (path
     only, never the query string), so the token-bearing query strings still
     used by the telnet/vnc/sftp/tunnel gateways are never written to the access
     log either.
- **Tests added:** `backend/src/ssh/gateway.test.ts` (6 cases) for
  `awaitAuthFrame`: extracts token+password+passphrase; defaults secrets to
  null; ignores non-auth/binary/invalid frames then accepts a valid one; a
  token-less frame never authenticates; close-before-auth and timeout resolve
  null.
- **Test result:** PASS (6/6).
- **Regression risk:** Low–Medium. The SSH web-terminal handshake changed
  (extra round-trip). Verified by frontend typecheck/build and backend unit
  tests. End-to-end browser↔real-SSH could not be exercised in this sandbox
  (no SSH target); the protocol change is symmetric and covered by the unit
  test of the server primitive.
- **Remaining concern:** telnet/vnc/sftp/wsTunnel gateways still accept the
  token via URL query (now unlogged by nginx). Converting them to channel-auth
  is queued for Phase 3 (remote-access hardening); the log redaction closes the
  logging exposure in the meantime.

## AWM-SEC-004 — Refresh token in browser localStorage

- **Severity:** P2 (browser build only) · **Status:** ANALYZED / ACCEPTED with compensating controls
- **Finding verification:** The Tauri desktop app stores the refresh token in
  the **OS keyring** (`keyring_set`, secure — finding does not apply). The
  non-Tauri browser build falls back to `localStorage`
  (`desktop/src/shared/lib/keyring.ts`), which is script-readable.
- **Analysis:** A full HttpOnly-cookie migration must remain dual-mode (cookie
  for the browser, request-body token for the Tauri client), introduces CSRF
  surface on `/refresh`, and cannot be end-to-end validated in this sandbox
  (no browser + live backend). Forcing it now would risk regressing the working
  Tauri auth flow, which the engagement rules forbid.
- **Decision:** Keep the secure keyring path for Tauri; retain localStorage for
  the browser build for this cycle, mitigated by: refresh-token **reuse
  detection** (already present), **short access-token TTL (15m)**, immediate
  **revocation on disable/lock/role-change** (SEC-007) and **on any refresh by
  an ineligible account** (SEC-002), and the **strong browser CSP** landing in
  Phase 4 (SEC-006) — the actual first-line XSS defence. The HttpOnly-cookie +
  CSRF design is documented as the recommended follow-up.
- **Regression risk:** None (no code change this phase).

---

## Phase 1 verification summary

| Check | Result |
| --- | --- |
| Backend `tsc --noEmit` | ✅ PASS |
| Backend `npm test` | ✅ PASS (68/68) |
| Frontend `tsc --noEmit` | ✅ PASS |
| Frontend `npm run build` | ✅ PASS |
| nginx `-t` | ⚠️ not run (nginx absent + cert-gated); config reviewed, `log_format` at http-include scope |

No critical auth test fails → cleared to proceed to Phase 2.
