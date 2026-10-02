# Remote Destination Policy (production)

Awamer is a remote-administration product, so reaching private infrastructure is its purpose.
The policy therefore **allows** private and public destinations and **denies** only addresses
that are never a legitimate managed target.

The policy is `backend/src/usecases/remoteDestination.ts`, configured at startup in `server.ts`.
It applies to **SSH, SFTP, Telnet, VNC and the SSH hop of tunnels**:
- the name is resolved **once**;
- **every** resolved address must pass;
- the gateway connects to the checked IP, which closes the DNS-rebinding window.

## Policy

| Destination | Default | Configurable | Rationale |
|---|---|---|---|
| RFC1918 (10/8, 172.16/12, 192.168/16), CGNAT 100.64/10, ULA fc00::/7 | **ALLOWED** | deny ranges via `REMOTE_SESSION_DENY_CIDRS` | Customer servers, network gear, VPN-reached networks |
| Public IPv4/IPv6 | **ALLOWED** | `REMOTE_SESSION_DENY_CIDRS` | Internet-facing servers |
| Loopback 127/8, ::1 (incl. `::ffff:127.0.0.1`, `2130706433`, `0x7f.1`, `localhost`) | **DENIED** | `REMOTE_SESSION_ALLOW_LOOPBACK=true` (opt-in) | It is the backend's own host or container |
| Link-local 169.254/16 incl. **cloud metadata 169.254.169.254**, fe80::/10 | **ALWAYS DENIED** | no | Cloud credential theft via raw TCP relays |
| Unspecified 0/8, ::; multicast / reserved 224/4, 240/4, ff00::/8 | **ALWAYS DENIED** | no | Never a host |
| The backend's own attached networks (Docker `netsphere-internal`: PostgreSQL, Redis) | **DENIED in the Docker deployment** | `REMOTE_SESSION_DENY_LOCAL_SUBNETS` (compose default `true`; off for bare metal, where it would block the server's own LAN) | Prevents relays to the platform's own DB and cache |
| Operator-chosen ranges | — | `REMOTE_SESSION_DENY_CIDRS=a/b,c/d` | Management VLANs, etc. |
| Tunnel *destination* (`dst_host:dst_port` behind the SSH hop) | Reached **from the remote SSH server** | — | Intended pivoting; "localhost" there means the remote machine |
| VPN | Client profiles connect to the profile's `remote`; server-pushed `redirect-gateway` is filtered; local `redirect-gateway` / `management` / file directives are rejected | — | See `VPN_HELPER_SECURITY_BOUNDARY.md` |
| Network diagnostics (ping / traceroute / port scan) | **Allow-list only** for private ranges (`NETWORK_DIAGNOSTIC_ALLOWED_CIDRS`); sensitive ranges always denied | env | Separate, stricter, admin-only tool |
| AI provider fetch | https only; private, loopback, link-local and metadata denied; pinned DNS; redirects re-validated | — | `ai/safeFetch.ts` |

## Evidence

| Evidence | Result |
|---|---|
| Unit tests REMOTE-DEST-001…006 (`remoteDestination.test.ts`): allowed ranges; metadata, link-local, unspecified and multicast; loopback default and opt-in; encoded IPs, `localhost`, mixed DNS answers; operator CIDRs; the backend's own subnet as `postgres` | PASS |
| **Production-mode smoke** (`REMOTE_SESSION_ALLOW_LOOPBACK=false`): SSH to the container's non-loopback IP `192.0.2.2:2223` | **connected**, shell I/O OK |
| Same, `127.0.0.1:2223` | **`destination_denied`** |
| Same, `169.254.169.254:22` | **`destination_denied`** |
| Gateway integration suites (SSH, Telnet, VNC, tunnel) with an explicit loopback opt-in for their fake servers | PASS |
| Compose resolves `REMOTE_SESSION_ALLOW_LOOPBACK=false`, `REMOTE_SESSION_DENY_LOCAL_SUBNETS=true` | `docker compose config` |

## Operator guidance

- Docker deployment: keep the compose defaults. Add `REMOTE_SESSION_DENY_CIDRS` for management networks users must not reach.
- Bare metal: set `REMOTE_SESSION_DENY_CIDRS` to the subnet(s) that host PostgreSQL and Redis.
- Enable `REMOTE_SESSION_ALLOW_LOOPBACK` only if administrators must manage the Awamer host itself through Awamer. It grants every user with `sessions:connect` a relay to the backend host's loopback services.
