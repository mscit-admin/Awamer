# Phase 4 — Browser refresh token (SEC-019), Readiness (STAB-001), API privilege (INFRA-001)

## AWM-SEC-019 — Browser refresh token in localStorage (P2) — FIXED

### Deployment support
Both Tauri (OS keyring) and browser (nginx-served SPA) are supported. Tauri is
unchanged and stays keyring-based.

### Fix — HttpOnly cookie for the browser, opt-in and backward compatible
- New `routes/authCookies.ts`: the browser SPA sends `X-Awamer-Client: web`.
  For those requests the server sets the refresh token as an
  **HttpOnly; Secure; SameSite=Strict; Path=/api/v1/auth** cookie and
  **omits it from the JSON body** — JS can never read it. `/refresh` and
  `/logout` read the cookie; `/logout` clears it.
- **Tauri is byte-for-byte unchanged:** with no `web` header, the server returns
  the refresh token in the body and sets no cookie (verified by test).
- **CSRF:** `SameSite=Strict` means the cookie is never sent cross-site, and the
  access token travels in the `Authorization` header (not a cookie), so normal
  API calls aren't cookie-driven. No separate CSRF token needed; documented.
- **Frontend:** the browser build now sends the `web` header + `credentials`,
  never persists the refresh token in `localStorage` (guards on `res.refresh_token`,
  which is absent in web mode), and drives `restore()`/`refreshTokens()` off the
  cookie. Access tokens remain in memory only.

### Tests
| Test | Where | Result |
| --- | --- | --- |
| BROWSER-AUTH-001 (JS cannot read refresh token) | `authCookies.test.ts` (HttpOnly) + web-mode body omits token (`authCookieFlow.itest.ts`) | PASS |
| BROWSER-AUTH-003 (cookie refresh works) | `authCookieFlow.itest.ts` | PASS |
| BROWSER-AUTH-004 (logout clears cookie + revokes) | `authCookieFlow.itest.ts` | PASS |
| BROWSER-AUTH-005 (cross-site denied) | `authCookies.test.ts` (SameSite=Strict) | PASS |
| BROWSER-AUTH-006 (rotated/expired cookie rejected) | `authCookieFlow.itest.ts` | PASS |
| Tauri body flow unchanged | `authCookieFlow.itest.ts` | PASS |

**Deploy note:** browser users re-login once after this update (old
localStorage tokens are not cookie-backed). Same-origin deployment (the current
nginx layout) satisfies the `credentials`/CORS requirements; the CSP
`connect-src 'self'` already permits it. TEST-BROWSER-AUTH-002 (reload keeps
session) relies on the persisted cookie and should be confirmed in-browser at
deploy (cannot run a real browser in this sandbox).

## AWM-STAB-001 — Real readiness check (P2) — FIXED

- `/healthz` stays dependency-free (process liveness).
- `/readyz` now runs `probeDb(pool)` (`SELECT 1`, 2s bounded timeout) →
  **200 `{status:"ready"}`** when the DB answers, **503 `{status:"not_ready"}`**
  when it doesn't; recovers automatically when the DB returns (no restart).
- `db/readiness.ts` extracted for testability.

### Tests — `db/readiness.itest.ts`
| Test | Result |
| --- | --- |
| READY-001 (DB up → ready) | PASS |
| READY-002/004 (DB down → not ready, bounded; healthz unaffected) | PASS |
| READY-003 (auto-recovers) | PASS |

## AWM-INFRA-001 — API retains root + NET_ADMIN + TUN (residual)

Per §10.2 (separation not implemented this cycle) — **risk documented, not
eliminated**:

- **Risk:** the production API container runs as root with `NET_ADMIN` + the tun
  device; a full API compromise inherits those.
- **Reason / exact code requiring privilege:** the built-in OpenVPN client and
  server (`src/vpn/*`, `src/domain/vpnServer.ts`) shell out to the `openvpn`
  binary, which creates a tun interface and manages routes via `ip`; on this
  kernel that child reliably needs root + `NET_ADMIN` + `/dev/net/tun`.
- **Attack surface:** the VPN feature set (profile/server management) plus the
  whole API sharing the container.
- **Compensating controls (shipped, v1.1):** `cap_drop: ALL` keeping only
  `NET_ADMIN`, `security_opt: no-new-privileges:true`, private Docker network
  (only nginx-exposed), named volumes. Documented non-root posture for
  desktop-only-VPN deployments.
- **Future remediation plan:** move VPN into a dedicated privileged sidecar
  (NET_ADMIN + tun only there, strict input validation, no HTTP surface) and run
  the API fully unprivileged (`cap_drop: ALL`, non-root, read-only FS). Tracked
  as the next infra task.
- **Owner:** platform/deployment. **Severity:** residual high-impact infra risk
  (not P0/P1 code defect).

## Suite after phase
Backend **81 unit / 38 integration**, backend + frontend `tsc` clean, frontend
`build` PASS.
