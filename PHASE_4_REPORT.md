# Phase 4 Report — Infrastructure Hardening

**Branch:** `claude/nifty-johnson-u2dwye`
**Addresses:** SEC-005 (Docker), SEC-006 (browser CSP), BUG-001 (Tauri CSP/ports)

---

## AWM-SEC-005 — Excessive Docker privileges

- **Severity:** P2 · **Status:** FIXED (least-privilege applied; root retained by design)
- **Affected files:** `deploy/docker-compose.production.yml`
- **Analysis:** the API container runs as root with `NET_ADMIN` + `/dev/net/tun`
  because the built-in OpenVPN client/server shell out to `ip` to bring up the
  tun interface (documented in-file). The VPN dependency is real; blindly
  dropping it would break VPN features (§6 of the brief warns against that).
- **Fix implemented (least privilege without breaking VPN):**
  - `cap_drop: [ALL]` then `cap_add: [NET_ADMIN]` — removes the ~13 default
    Docker capabilities (chown, setuid, setgid, net_raw, mknod, …) the API never
    uses, keeping only the one OpenVPN needs.
  - `security_opt: [no-new-privileges:true]` — blocks setuid/setgid privilege
    escalation from a compromised process.
  - Kept `user: "0:0"`, the tun device and `ip_forward` (VPN needs them), and
    documented the fully-unprivileged posture for desktop-only-VPN deployments
    plus the recommended VPN-in-a-sidecar isolation.
- **Verification:** `docker compose config` validates; the three settings are
  present in the rendered config.
- **Regression risk:** Low. Capabilities removed are unused by the API; VPN
  retains NET_ADMIN + tun.
- **Remaining concern:** the API still runs as root for VPN's `ip` child. A
  dedicated privileged VPN sidecar (API unprivileged) is the recommended
  next step; scoped out of this cycle to avoid a deployment-topology change.

## AWM-SEC-006 — Missing browser Content-Security-Policy

- **Severity:** P2 · **Status:** FIXED
- **Affected files:** `deploy/nginx/netsphere.conf`
- **Analysis:** the SPA (`index.html`) loads **no** external scripts, styles or
  fonts — everything is bundled by Vite; icons and QR codes are `data:` URIs.
  A tight CSP is therefore feasible without breaking the app.
- **Fix implemented:** added
  `Content-Security-Policy: default-src 'self'; base-uri 'self'; object-src
  'none'; frame-ancestors 'none'; img-src 'self' data: blob:; style-src 'self'
  'unsafe-inline'; font-src 'self' data:; script-src 'self'; connect-src 'self';
  form-action 'self'`.
  - **No** `unsafe-eval`, **no** inline/wildcard **script** source.
  - `style-src 'unsafe-inline'` is the one concession — xterm.js and React set
    element inline styles; styles cannot execute code, so this does not enable
    script injection. `script-src 'self'` still blocks JS injection.
  - `connect-src 'self'` covers the same-origin REST + WebSocket gateways (the
    API is reverse-proxied under the same origin).
  - `frame-ancestors 'none'` backs up `X-Frame-Options: DENY`.
- **Regression risk:** Medium — a strict CSP can surface a missed inline
  dependency. Could not be exercised against a live nginx here (nginx absent,
  cert-gated). **Validation required at deploy:** load the app, confirm no CSP
  violations in the console (terminal, VNC canvas, QR enrolment, AI panel), and
  relax only the specific directive if a real need appears — never to
  `unsafe-eval`/wildcards.

## AWM-BUG-001 — Tauri CSP / dev-port mismatch

- **Severity:** P2 · **Status:** FIXED
- **Affected files:** `desktop/src/shared/lib/api.ts`,
  `desktop/src-tauri/tauri.conf.json`
- **Root cause:** the backend dev port is **8081** (`AUTH_HTTP_PORT` default),
  but `api.ts` defaulted `VITE_API_BASE_URL` to `http://localhost:8080` — so a
  dev build without the env var set hit a dead port. The Tauri CSP `connect-src`
  also only allowed `http://localhost:8080` and no `ws:`/`wss:`, so both the API
  (wrong port) and every WebSocket gateway would be blocked.
- **Fix implemented:**
  - `api.ts` default aligned to `http://localhost:8081` (matches the backend and
    the other frontend modules).
  - Tauri CSP `connect-src` set to
    `'self' http://localhost:8081 ws://localhost:8081 https: wss: ipc:
    https://ipc.localhost` — correct dev port + WS scheme for dev, and
    `https:`/`wss:` so the packaged app can reach a user-configured remote HTTPS
    backend (the origin isn't known at build time). Dropped the stale
    `fonts.googleapis.com`/`fonts.gstatic.com` sources (the app loads no Google
    Fonts). Kept `style-src 'unsafe-inline'` for xterm/React.
- **Verification:** `tauri.conf.json` is valid JSON; frontend `tsc` + `vite
  build` pass.
- **Regression risk:** Low. Endpoints now agree with the backend; production
  builds set `VITE_API_BASE_URL` explicitly (same-origin), unaffected.

---

## Phase 4 verification summary

| Check | Result |
| --- | --- |
| Frontend `tsc --noEmit` | ✅ PASS |
| Frontend `vite build` | ✅ PASS |
| `tauri.conf.json` JSON valid | ✅ PASS |
| `docker compose config` | ✅ VALID (cap_drop ALL + NET_ADMIN + no-new-privileges present) |
| nginx `-t` | ⚠️ not run (nginx absent + cert-gated); header syntax reviewed |

**Deploy-time validation still required:** browser CSP against the live app;
nginx `-t` on the target host.
