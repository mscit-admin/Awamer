# VPN Helper Security Boundary

```
Internet / User (browser · desktop)
      │  HTTPS (nginx: TLS, CSP, HSTS)                         ── TRUST BOUNDARY 1 (untrusted → authenticated)
      ▼
Backend  auth-service  (uid 10001, cap_drop ALL, no-new-privileges, read-only rootfs, no NET_ADMIN, no tun)
      │  • JWT + live account state + RBAC (vpn:manage / vpn:reveal / vpn_server:manage; backend-runtime connect = admin role)
      │  • VALIDATION BOUNDARY: zod schemas; cipher allowlist; assertSafeOvpnConfig (scripts, file paths,
      │    management, log/status/writepid, config, askpass, redirect-gateway denied); CIDR/host regexes
      ▼
Validated VPN request ── Unix socket /run/awamer/ipc/vpn-helper.sock (0660, group 10001; no TCP)
      │  HMAC-SHA256 over canonical JSON + timestamp skew + nonce cache   ── TRUST BOUNDARY 2 (app → privileged)
      ▼
VPN Helper  (root in container, cap_drop ALL + NET_ADMIN only, /dev/net/tun, network_mode: host)
      │  • RE-VALIDATES on the privileged side: ref format, cipher allowlist, assertSafeOvpnConfig,
      │    assembleServerConfig scalar checks; fixed binary + argv array (no shell); --script-security 1 forced
      │    LAST for clients; --pull-filter ignore redirect-gateway / redirect-private
      ▼                                                         ── PRIVILEGED BOUNDARY
OpenVPN processes / host network namespace / iptables (per-server rule, validated port/proto/comment)
      │
      └─ auth-verify child (per VPN-server login) ── DB BOUNDARY: awamer_vpn_auth (SELECT 4 columns only)
```

## Boundaries

| Boundary | What crosses it | Controls |
|---|---|---|
| **Trust** (Internet to backend) | Authenticated API calls | TLS; JWT (HS256 pinned) with live account state; RBAC; rate limits |
| **Validation** (backend) | VPN profile text, server parameters | zod; cipher **allowlist**; `.ovpn` denylist (script, file-path, control and route-hijack directives); scalar regexes |
| **Privileged** (backend to helper) | HMAC-signed IPC request | Unix socket only (no network listener); HMAC + skew + nonce; **re-validation in the helper**; argv-array spawn; forced `--script-security 1` (client); pull-filters |
| **Secret** | `VPN_HELPER_SECRET`, DB URL for auth-verify | The helper receives **only** `VPN_HELPER_SECRET` and the `awamer_vpn_auth` URL. It never sees the JWT secrets, `CREDENTIAL_ENCRYPTION_KEY`, the bootstrap password or the cluster-admin DB credentials. |
| **DB** | auth-verify lookup | `awamer_vpn_auth` can SELECT `server_id, username, password_hash, revoked` of `vpn_server_clients` and nothing else (DBLP-004). Before this phase the helper held the **superuser** URL, which was also written into each server's `verify.sh`. |

## Why elevation is required (cannot be removed without breaking VPN)

| Privilege | Needed for |
|---|---|
| `NET_ADMIN` | Creating and configuring tun interfaces, routes and per-server iptables rules |
| `/dev/net/tun` | The OpenVPN data plane |
| `network_mode: host` | Each VPN server binds its own dynamically assigned host port (20000–30000) without recreating the container. Client tunnels must change the host's routing to reach customer networks. |
| root (uid 0) inside the container | OpenVPN and iptables need it together with NET_ADMIN. Group 10001 lets the unprivileged backend reach the socket without `CAP_CHOWN`. |

## Hardening verified

Static evidence: `composeContract.test.ts` and `composeDbIdentity.test.ts`, both PASS.

| Control | State |
|---|---|
| Only the vpn-helper has NET_ADMIN | ✅ backend, migrate and db-provision have none (INFRA-VPN-002, COMPOSE-HARDEN-001) |
| Backend / frontend NET_ADMIN | ✅ none. The frontend is static files behind nginx, not a container in this stack |
| Unnecessary capabilities | ✅ `cap_drop: ALL` then `cap_add: NET_ADMIN` only (INFRA-VPN-008b) |
| Docker socket | ✅ not mounted in any service (COMPOSE-HARDEN-001) |
| `privileged: true` | ✅ none (INFRA-VPN-008a/b) |
| no-new-privileges | ✅ (INFRA-VPN-005b) |
| Mounted volumes | ✅ only `vpn-helper-run:/run/awamer` (the IPC socket directory) |
| Application secrets | ✅ only `VPN_HELPER_SECRET` and the dedicated DB role (was: superuser) |
| Dedicated DB credentials | ✅ `awamer_vpn_auth` (new) |
| Minimal image | ✅ `node:20-alpine` + `tini openvpn iproute2 iptables`; no compilers in the runtime stage; `npm ci` from the lockfile |
| Controlled writable paths | ⚠️ partial: runtime state in `/var/lib/awamer/vpn-runtime` (0700 directories, 0600 files) and the socket directory. **A read-only root filesystem was NOT enabled for the helper.** iptables needs a writable `/run/xtables.lock` and OpenVPN executes `verify.sh` from the runtime directory, so a tmpfs layout must be validated on a real image first. That is impossible here: the image build is blocked (see `DOCKER_BUILD_EVIDENCE.md`). It is tracked as OR-04. |

## Residual (documented, architectural)

- **Host network namespace.** Client profiles (admin-only) can still add specific `route`s to the host namespace. The default-route takeover is filtered, both pushed and local.
- **Recommended follow-up:** per-session network namespaces (OR-05).
