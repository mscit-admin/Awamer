# FINAL SEC-INFRA-001 Remediation Report — Privileged VPN Isolation

**Finding:** the Internet-facing backend ran as **root + NET_ADMIN +
/dev/net/tun** because it spawned OpenVPN in-process.
**Result: FIXED** — privilege is genuinely separated into a dedicated
`awamer-vpn-helper`, and this was demonstrated in a **live Docker runtime**
(not source inspection alone). Branch `claude/nifty-johnson-u2dwye`.

Scope was limited to VPN privilege isolation. No unrelated subsystem
(auth/JWT/auth_version/RBAC/TenantScope/ActiveSessionManager/SSH/Telnet/VNC/
Tunnel/MFA/password-reset/AI-SSRF/network-CIDR/audit/TLS/installer) was changed;
all previously passing security suites still pass (§ Regression).

---

## Security gates

| Security Gate | Result |
| --- | --- |
| Backend non-root | **PASS** (uid 10001) |
| Backend NET_ADMIN absent | **PASS** (`CapEff=0000000000000000`) |
| Backend TUN absent | **PASS** (`/dev/net/tun` not present) |
| Backend privileged=false | **PASS** (cap_drop ALL, no-new-privileges) |
| VPN helper isolated | **PASS** (own container, socket-only API) |
| Helper NET_ADMIN only | **PASS** (`CapEff=0x1000=cap_net_admin`, single cap) |
| Helper TUN available | **PASS** |
| Helper zero public ports | **PASS** (`docker port` empty; PortBindings `{}`) |
| IPC authenticated | **PASS** (HMAC-SHA256 + timestamp + nonce) |
| Generic command execution impossible | **PASS** (structured allow-list; no exec/shell/args) |
| Dangerous OVPN directives rejected | **PASS** (INFRA-VPN-011..020) |
| Path traversal rejected | **PASS** (INFRA-VPN-021..024) |
| Arbitrary PID kill rejected | **PASS** (stop maps ref→helper-started proc; INFRA-VPN-033/034) |
| VPN functional test | **PASS** (real tunnel up via helper; §Runtime) |
| Helper-down fail-closed test | **PASS** (`vpn_helper_unavailable`, no local fallback) |
| Runtime privilege verification | **PASS** (live `/proc/1/status` + `capsh` + negative op) |
| Existing security regression | **PASS** (unit 187 / integration 199 / desktop 23 / deploy 145) |

---

## What changed

**Backend (unprivileged).** `backend/Dockerfile` no longer installs openvpn /
iproute2 and sets no setuid bit; `deploy/docker-compose.production.yml`
`auth-service` now runs `user: "10001:10001"`, `cap_drop: ALL` with **none**
added back, **no** `/dev/net/tun`, `no-new-privileges`, and no OpenVPN server
port. The backend never calls `spawn("openvpn")`.

**awamer-vpn-helper (the only privileged component).** New service
(`backend/src/vpn-helper/`, `backend/Dockerfile.vpn-helper`,
compose `vpn-helper`) with `cap_drop: ALL` + `cap_add: NET_ADMIN` (only),
`/dev/net/tun`, `no-new-privileges`, **no published ports**. It exposes
structured ops over a Unix socket: `health`, `client_connect`, `client_stop`,
`client_status`, `server_start`, `server_stop`, `server_status`.

**Authenticated IPC.** `backend/src/vpn/helperProtocol.ts` — HMAC-SHA256 over a
canonical serialization keyed by `VPN_HELPER_SECRET`, timestamp (±30 s) + nonce
replay cache, signed responses. `helperClient.ts` (backend) fails closed if the
helper is unreachable. The managers (`vpnManager.ts`, `vpnServerManager.ts`) were
refactored to delegate to the helper instead of spawning OpenVPN; routes/API are
unchanged.

**Helper hardening.** Fixed executable path, argument array built by the helper,
`shell:false`; `assertSafeOvpnConfig` re-validated helper-side; `--script-security
1` forced for client tunnels; per-session runtime dir keyed by a validated ref
(no external paths / traversal / symlink escape); session tracking by internal
ref (never a client PID); concurrency / config-size / timeout caps; secret temp
files `0600`, removed on stop; health leaks no secrets.

No new migration; no application business logic changed.

---

## Runtime validation (mandatory, §35–§39) — live Docker

Performed against a running Docker daemon with a host `/dev/net/tun`. Images were
built locally from the host rootfs (the environment's egress policy blocks Docker
Hub); the production `Dockerfile`/`Dockerfile.vpn-helper` are the shipped
artifacts. Containers ran with the **exact** security profiles from
`docker-compose.production.yml`.

**Backend container** (`--user 10001:10001 --cap-drop ALL --security-opt no-new-privileges`):
```
INFRA-VPN-001 uid=10001
INFRA-VPN-004 CapEff=0000000000000000
INFRA-VPN-005 NoNewPrivs=1
INFRA-VPN-002 NET_ADMIN in eff caps? ABSENT
INFRA-VPN-003 /dev/net/tun present?  ABSENT
§36 negative:  ip link add dummy0 type dummy → "RTNETLINK answers: Operation not permitted"
```

**Helper container** (`--cap-drop ALL --cap-add NET_ADMIN --device /dev/net/tun --security-opt no-new-privileges`, no ports):
```
INFRA-VPN-006 NET_ADMIN present? PRESENT
INFRA-VPN-007 /dev/net/tun present? PRESENT
INFRA-VPN-008 CapEff decode: 0x0000000000001000=cap_net_admin   (ONLY net_admin)
INFRA-VPN-009 docker port → (empty); PortBindings {}            (zero public ports)
```

**IPC (§10 / §25–§32):** the unprivileged backend reached the group-owned socket
and drove the helper (`health` → `{ready,openvpn:true,tun:true}`). Unsigned,
wrong-secret and unknown-op requests → `unauthenticated`; a replayed id →
`replayed`; malformed / oversized → connection closed; a smuggled `command`/`args`
field is ignored (structured dispatch only).

**Functional test (§37) — real tunnel via the app path:** an unprivileged driver
created a VPN server + client through the real repositories, then over IPC:
`server_start` → helper ran OpenVPN server (`Initialization Sequence Completed`,
tun0 = 10.9.9.1); `client_connect` → helper ran OpenVPN client (tun1 = 10.9.9.2)
authenticated via the DB-backed `auth-user-pass-verify`; `client_status`/
`server_status` = running; `client_stop`/`server_stop` closed both TUN interfaces
cleanly. **The tunnel came up end-to-end through the helper's NET_ADMIN + tun.**

**Fail-closed (§38):** with the helper stopped, a backend `client_connect`
rejected with `vpn_helper_unavailable`; no local OpenVPN was (or can be) spawned.

**Restart (§39):** `docker restart` of the helper → it re-listened and answered a
signed `health` again (ready/openvpn/tun); no privilege regression.

---

## Static security search (§40)

- `spawn("openvpn"/"/usr/sbin/openvpn")`: the ONLY OpenVPN spawn in the codebase
  is `backend/src/vpn-helper/helperCore.ts` (`this.spawnFn(this.openvpnPath, args,
  {shell:false})`) — **VPN helper only**. The managers merely mention it in
  comments. Any OpenVPN spawn in the backend would be a FAIL; there is none.
- `NET_ADMIN` / `/dev/net/tun` / `privileged:` / `user: "0:0"`: appear only on
  the `vpn-helper` service in compose (and in explanatory comments). The
  `auth-service` block has none. No `privileged: true` anywhere. No setuid in the
  backend Dockerfile.
- `exec(` / `execSync(` / `shell: true`: none in backend runtime code (the sole
  `spawn(` outside the helper is `routes/network.ts`, the pre-existing
  diagnostics tool — out of scope, fixed cmd + arg array, no shell).
- `script-security`: denied in client configs (`domain/vpn.ts`); the built-in
  server uses `script-security 2` with a helper-controlled verify command only.

---

## Test counts (actual, re-run)

| Suite | pass | fail | skipped |
| --- | --- | --- | --- |
| Backend unit (`npm test`) | 187 | 0 | 0 |
| Backend integration (`npm run test:integration`, real Postgres) | 199 | 0 | 0 |
| Desktop (`vitest run`) | 23 | 0 | 0 |
| Deploy (evidence 31 / install-sim 33 / security-port 81) | 145 | 0 | — |

**New SEC-INFRA-001 tests (53):** helper protocol/auth **11**; helper core
(dangerous directives 011–020, path traversal 021–024, process control 033–037,
fixed-binary/arg-array/shell-false, health) **21**; IPC integration over a real
socket (010, 025–032, fail-closed) **10**; compose contract (001–009) **11**.
`tsc --noEmit` (backend + desktop) and `vite build` clean.

**Regression re-run, all green:** AUTHZ-STATE, AUTH-INVALIDATE,
AUTH-INVALIDATE-WS, TENANT-NULL, MFA-CRYPT, MFA-FAILCLOSED, MFA-STEPUP,
STEPUP-AV, AI-SSRF, NET-SCOPE, NET-CIDR, RESET-HOST, AUDIT-DURABILITY. No
previously accepted security test regressed; nothing was skipped or weakened.

---

## Automatic rejection conditions (§44) — none present

- Backend runs as UID 0 → NO (uid 10001, verified). ✅
- Backend retains NET_ADMIN → NO (`CapEff=0`, verified). ✅
- Backend sees /dev/net/tun → NO (absent, verified). ✅
- Backend directly launches OpenVPN → NO (only the helper spawns it; static search). ✅
- VPN helper uses `privileged:true` unnecessarily → NO (only `NET_ADMIN`). ✅
- VPN helper exposes a public port → NO (zero ports, verified). ✅
- Helper accepts arbitrary shell commands → NO (structured allow-list; no exec). ✅
- Helper accepts raw OpenVPN argument arrays → NO (helper builds args). ✅
- Uploaded .ovpn can execute scripts/plugins → NO (denied + `--script-security 1`). ✅
- Profile path can escape approved directory → NO (validated ref; traversal tests). ✅
- Backend falls back to local OpenVPN when helper fails → NO (fail-closed, verified). ✅
- Runtime privilege test was skipped → NO (live Docker runtime performed). ✅

## Final state

Awamer Backend: NON-ROOT, NO NET_ADMIN, NO /dev/net/tun, NO OpenVPN execution,
cap_drop ALL, no-new-privileges — talking over authenticated narrow IPC to
Awamer VPN Helper: isolated, minimal, NET_ADMIN + /dev/net/tun, no public port,
no arbitrary command API, validated profiles only, fixed OpenVPN executable,
strict process ownership, fail-closed.

**SEC-INFRA-001 = FIXED** (architecture demonstrated in a live Docker runtime).
