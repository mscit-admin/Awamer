# SEC-INFRA-001 — Privileged VPN isolation

**Status: FIXED** (privilege genuinely separated; demonstrated in a live Docker
runtime — see `FINAL_SEC_INFRA_001_REMEDIATION_REPORT.md`).

Previously the Internet-facing backend ran as **root** with **NET_ADMIN** and
**/dev/net/tun** because it spawned OpenVPN in-process. Any RCE in the backend
would have inherited privileged network control. That privilege is now confined
to a dedicated, minimal `awamer-vpn-helper`; the backend is fully unprivileged.

## Architecture

```
                     Internet
                        │
                      Nginx
                        │
                        ▼
              ┌─────────────────────┐
              │    Awamer Backend   │  non-root (uid 10001)
              │                     │  cap_drop: ALL  (no NET_ADMIN)
              │  never spawns       │  no /dev/net/tun
              │  OpenVPN            │  no-new-privileges
              └─────────┬───────────┘
                        │  authenticated Unix-socket IPC
                        │  (HMAC-SHA256 + timestamp + nonce)
                        ▼
              ┌─────────────────────┐
              │   awamer-vpn-helper │  root INSIDE its own container
              │                     │  cap_drop: ALL; cap_add: NET_ADMIN ONLY
              │  structured ops     │  /dev/net/tun
              │  only               │  NO public port (socket only)
              └─────────┬───────────┘  no-new-privileges
                        ▼
                    OpenVPN            (the ONLY component that runs it)
```

## Backend privilege model

Runs as a dedicated non-root user (`10001:10001`), `cap_drop: ALL` with **no**
capability added back, **no** `/dev/net/tun`, `no-new-privileges:true`. It does
not contain the openvpn binary and never calls `spawn("openvpn")`. All VPN
lifecycle work is delegated to the helper. Verified at runtime: `id -u` = 10001,
`CapEff = 0000000000000000`, `/dev/net/tun` absent, and a NET_ADMIN operation
(`ip link add … type dummy`) returns **`Operation not permitted`**.

## VPN helper

A minimal service (`backend/src/vpn-helper/`, image `Dockerfile.vpn-helper`)
whose sole responsibility is the privileged OpenVPN lifecycle. Runtime posture
(verified): `cap_drop: ALL` + `cap_add: NET_ADMIN` (exactly one capability),
`/dev/net/tun` present, `no-new-privileges`, **zero published host ports**. It
runs as uid 0 **inside its own container** with gid 10001 (so the shared socket
is group-owned by the backend's gid without needing CAP_CHOWN).

### API (structured, allow-listed — NO generic exec)

`health`, `client_connect`, `client_stop`, `client_status`, `server_start`,
`server_stop`, `server_status`. There is **no** `/exec`, `/shell`, `/command`,
no arbitrary binary, no arbitrary argument array, no arbitrary env. The backend
sends structured data (session ref + assembled config, or server parameters);
the helper builds the OpenVPN argument array itself.

## IPC trust boundary

- **Transport:** a Unix domain socket at `/run/awamer/ipc/vpn-helper.sock` in a
  shared volume. The socket dir is `0750` and the socket `0660`, group-owned by
  the backend's gid — reachable by the backend, not world. No TCP, no host port,
  no nginx route, never Internet-accessible.
- **Authentication:** every request carries an **HMAC-SHA256** over a canonical
  serialization keyed by the high-entropy `VPN_HELPER_SECRET` (constant-time
  compare). Network isolation is *not* trusted on its own.
- **Replay/integrity:** each request has a timestamp (±30 s window) and a unique
  id held in a nonce cache; replays are rejected. Responses are signed too and
  bound to the request id.
- **Authorization stays in the backend.** The helper authenticates the *backend*
  (service-to-service), never an end-user JWT. User identity, RBAC (`vpn:manage`
  / `vpn_server:manage`) and tenant checks all happen in the backend before any
  IPC call. The helper does not replace the application's RBAC.

## Required Linux capabilities & TUN

- **Backend:** none. `cap_drop: ALL`, no `/dev/net/tun`.
- **Helper:** `NET_ADMIN` only, plus the `/dev/net/tun` device. Not
  `--privileged`. `NET_ADMIN` + tun are the minimum for OpenVPN to create the
  tun interface and manage routes.

## Failure behavior (fail-closed)

If the helper is unavailable, VPN operations **fail closed** with
`vpn_helper_unavailable`. The backend does **not** fall back to a local OpenVPN
spawn (that would defeat the isolation) — there is no such code path. Verified
at runtime: with the helper stopped, a `client_connect` from the backend rejects
with `vpn_helper_unavailable`.

## Preserved defenses (isolation supplements, does not replace)

- OpenVPN dangerous-directive validation (`assertSafeOvpnConfig`) runs on the
  backend AND is **re-validated inside the helper** (defence in depth).
- `--script-security 1` is force-appended to every client tunnel (an uploaded
  `.ovpn` cannot relax it). The built-in server uses `script-security 2` solely
  for its own helper-controlled `auth-user-pass-verify` (no user scripts).
- Fixed OpenVPN executable path; argument array; `shell:false` (no shell).
- Per-session runtime dir keyed by a validated ref (no external paths, no
  traversal, no symlink escape); secret temp files are `0600` and removed on
  stop. Concurrency, config-size, and startup/shutdown-timeout caps.
- VPN secret encryption at rest, audit logging, tenant authorization, RBAC and
  profile-size limits are unchanged.

## Troubleshooting

- **Backend logs `vpn_helper_unavailable`:** the helper container is down or the
  shared socket volume is not mounted in both services. Check
  `docker compose ps vpn-helper` and that both mount `vpn-helper-run:/run/awamer`.
- **Helper refuses to start:** `VPN_HELPER_SECRET` must be set and ≥32 chars.
- **Backend can't reach the socket:** the helper must run with the backend's gid
  as its group (`user: "0:10001"`), so the socket is group-owned by `10001`.
- **Server won't start (auth-verify):** the helper needs `DATABASE_URL` for the
  built-in server's per-user auth-verify child.

## Security assumptions

- The shared socket volume is accessible only to the backend and helper
  containers (Docker-managed named volume).
- `VPN_HELPER_SECRET` is a per-deployment high-entropy secret, not committed.
- The helper is trusted to run OpenVPN with NET_ADMIN; its attack surface is the
  small structured IPC API, authenticated and replay-protected.

> **The Awamer Backend/API must never require NET_ADMIN or direct access to
> /dev/net/tun.** All privileged VPN operations belong to `awamer-vpn-helper`.
