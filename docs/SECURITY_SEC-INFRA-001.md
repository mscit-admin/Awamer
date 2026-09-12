# SEC-INFRA-001 — Main API container runs root + NET_ADMIN

**Status: ACCEPTED TEMPORARY ARCHITECTURAL RISK** (not FIXED).

Per the remediation program §43, a fix is claimed only when the privilege is
genuinely separated. The proper fix is an architectural split (a dedicated
privileged VPN helper) that cannot be built AND verified safely in the current
cycle/environment (no Docker daemon, no `/dev/net/tun`, no live OpenVPN in the
sandbox). Rather than ship an unverified/fake split, the risk is documented and
accepted temporarily, with mitigations, and scheduled for a dedicated cycle.

## Risk

`deploy/docker-compose.production.yml` runs the `auth-service` container as
`user: "0:0"` (root) with `cap_add: NET_ADMIN` and `devices: /dev/net/tun`,
because the backend spawns `openvpn` in-process (`backend/src/vpn/vpnManager.ts`,
`backend/src/vpn/vpnServerManager.ts`), and OpenVPN shells out to `ip` to
configure the tun interface (per-binary file caps/setuid did not reliably reach
the `ip` child on the target kernel).

## Blast radius

A remote-code-execution or container-escape bug in the API process would run as
root with `NET_ADMIN` and access to `/dev/net/tun` — enabling tun/route
manipulation and raising the value of any escape. It does NOT grant host root by
itself (`no-new-privileges` + `cap_drop: ALL` except `NET_ADMIN` are set, and
the container is not `--privileged`), but the residual capability + root user is
a larger surface than an unprivileged API container.

## Existing mitigations (in place today)

- `cap_drop: ALL`, then add back ONLY `NET_ADMIN` (≈12 default caps dropped).
- `security_opt: no-new-privileges:true` (blocks setuid escalation).
- Not `--privileged`; only `/dev/net/tun` is exposed (no broad device access).
- Backend port bound to `127.0.0.1:8081` (not publicly exposed; nginx fronts it).
- OpenVPN is spawned with an argument array (no shell → no command injection).
- Client profiles pass through `assertSafeOvpnConfig` (denies `up`/`down`/
  `plugin`/`script-security`/… — the "config = code execution as root" vector),
  and `--script-security 1` is force-appended so only built-in helpers run.
- Backend-runtime tunnels are further restricted to admin roles; VPN routes are
  permission-gated (`vpn:manage`/`vpn:reveal`/`vpn_server:manage`).
- Auth-state + auth_version + ActiveSessionManager (this program) reduce the
  chance of reaching the VPN surface with a stolen/steal-and-reuse token.

## Required future architecture (the real fix)

```
backend API (auth-service)          vpn-helper (new, minimal image)
  user: non-root                      user: root (or ambient NET_ADMIN)
  no NET_ADMIN                 IPC     cap_add: NET_ADMIN
  no /dev/net/tun         ─────────▶  devices: /dev/net/tun
  cap_drop: ALL           (unix       no public network exposure
  no-new-privileges        socket)    structured, allowlisted commands only
```

- The helper listens ONLY on a Unix socket (or an isolated internal network),
  authenticates the API, and accepts STRUCTURED commands (start/stop a named
  profile, status) — never arbitrary shell or arbitrary OpenVPN args.
- Retain `assertSafeOvpnConfig` dangerous-directive filtering and
  `--script-security 1` inside the helper.
- After the split: the API container is `user: <non-root>`, with NO `NET_ADMIN`
  and NO `/dev/net/tun`, keeping `cap_drop: ALL` + `no-new-privileges`.

## Why not partially drop privilege now

Removing `NET_ADMIN`/`/dev/net/tun` from the current single container without
the helper would break all VPN functionality (client tunnels + the OpenVPN
server) — a functional regression, not a security fix. Running the API as
non-root with file caps was already found unreliable for the `ip` child on the
target kernel. Either change must be validated against a real Docker + TUN
environment, which is unavailable here.

## Acceptance

Accepted as a temporary, documented risk for this cycle. Tracked for a dedicated
architecture cycle that builds and runtime-verifies the vpn-helper split on a
host with Docker + `/dev/net/tun`. Not marked FIXED until the API container
genuinely runs unprivileged.
