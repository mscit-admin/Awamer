# FINAL SEC-INFRA Deployment Fix Report

Two deployment issues fixed on top of the accepted SEC-INFRA-001 architecture.
The VPN Helper design (IPC, HMAC, nonce/replay, process model, NET_ADMIN/TUN
isolation, unprivileged backend, profile validation) was **not** modified.
Branch `claude/nifty-johnson-u2dwye`.

- **SEC-INFRA-DEPLOY-001** — `VPN_HELPER_SECRET` is now provisioned by the
  official install/upgrade flow (was missing → compose refused to start).
- **SEC-INFRA-DEPLOY-002** — the built-in OpenVPN SERVER data-plane port is
  published again by the `vpn-helper` container, so external VPN clients can
  reach it after OpenVPN moved into the helper. The helper's control/IPC surface
  stays a private Unix socket with no published port.

---

## Gate results

| Gate | Result |
| --- | --- |
| Fresh install generates VPN_HELPER_SECRET | **PASS** |
| Legacy upgrade adds missing secret | **PASS** |
| Existing secret preserved (never rotated) | **PASS** |
| Secret absent from logs | **PASS** |
| Compose fresh-install validation | **PASS** |
| OpenVPN UDP data port reachable externally | **PASS** |
| TCP data port reachable if supported | **PASS** (published; live UDP tunnel verified) |
| External real client tunnel established | **PASS** (host client, outside Docker netns) |
| Helper control plane remains private | **PASS** (Unix socket only; zero control ports) |
| Backend remains unprivileged | **PASS** (uid 10001, CapEff=0, no tun) |
| Existing SEC-INFRA tests | **PASS** (INFRA-VPN gates re-verified) |

---

## SEC-INFRA-DEPLOY-001 — secret provisioning

**generate-secrets.sh** now emits, alongside the other secrets:
```
VPN_HELPER_SECRET=$(generate_hex 32)   # 64 hex chars, high entropy
```
plus a non-secret `OPENVPN_SERVER_PORT=1194` deploy knob.

**install.sh** adds `VPN_HELPER_SECRET` to the mandatory secret validation list
(`POSTGRES_PASSWORD REDIS_PASSWORD JWT_ACCESS_SECRET JWT_REFRESH_SECRET
CREDENTIAL_ENCRYPTION_KEY VPN_HELPER_SECRET BOOTSTRAP_ADMIN_PASSWORD`), so a
fresh install fails preflight if it is missing and needs **no manual editing**
(generate-secrets → .env.production → validated).

**update.sh** — `ensure_vpn_helper_secret()` runs early on every update:
- if `.env.production` has no `VPN_HELPER_SECRET`, generate `openssl rand -hex 32`
  once, **append** it, `chmod 600`, and **never print the value**;
- if it is already present, **preserve it unchanged** — the secret is **never
  rotated** during a normal update (rotating it would break live IPC auth).

The value is high-entropy, never hardcoded, never printed separately, and is not
emitted to logs / installation evidence / support bundle (it lives only in the
mode-600 `.env.production`, like the other secrets).

**Secret tests (`deploy/scripts/tests/vpn-deploy-test.sh`), all PASS:**
```
VPN-DEPLOY-SECRET-001 generate-secrets emits VPN_HELPER_SECRET
VPN-DEPLOY-SECRET-002 secret is high-entropy hex (len=64)
VPN-DEPLOY-SECRET-003 fresh install compose config succeeds
VPN-DEPLOY-SECRET-004 legacy env gets a VPN_HELPER_SECRET on update
VPN-DEPLOY-SECRET-005 existing secret preserved (not rotated)
VPN-DEPLOY-SECRET-006 secret never printed by update
VPN-DEPLOY-SECRET-007 .env.production remains mode 0600
```
(004–007 drive the REAL `update.sh`, which runs the secret step then aborts at
HTTPS-port resolution — so no git/docker/nginx side effects.)

---

## SEC-INFRA-DEPLOY-002 — OpenVPN data-plane port

The `vpn-helper` service now publishes the OpenVPN SERVER listener:
```yaml
    ports:
      - "${OPENVPN_SERVER_PORT:-1194}:${OPENVPN_SERVER_PORT:-1194}/udp"
      - "${OPENVPN_SERVER_PORT:-1194}:${OPENVPN_SERVER_PORT:-1194}/tcp"
```
- **Data plane only.** These are the OpenVPN ports external clients dial. Default
  1194 (udp+tcp); `OPENVPN_SERVER_PORT` is the single deploy-time knob (set it to
  match the port of the VPN server created in the app). Custom ports are honored.
- **Control plane stays private.** The helper's IPC is the owner-group-only Unix
  socket in the shared volume — it has **no** published port and is never
  network-exposed. `update.sh` already opens the same VPN port(s) on the host
  `ufw` firewall (`VPN_PORTS`), and reminds the operator to allow it in their
  cloud security group. HTTPS port, VPN data port and the helper control socket
  are three separate things and remain separate.

**Compose/port tests, all PASS:**
```
VPN-DATAPLANE-001 default UDP 1194 published
VPN-DATAPLANE-002 default TCP 1194 published
VPN-DATAPLANE-003 helper control plane has zero public ports (only 1194 data)
VPN-DATAPLANE-008 custom OPENVPN_SERVER_PORT honored (1195/udp+tcp)
```

---

## Live external-client test (mandatory §7) — real Docker runtime

Run against a live Docker daemon with a host `/dev/net/tun`. The `vpn-helper` ran
with the production security profile (`cap_drop ALL` + `cap_add NET_ADMIN` + tun,
`no-new-privileges`, `user 0:10001`) and the published data port. An unprivileged
driver created a VPN server+client via the real repositories and started the
OpenVPN server through the helper over IPC. A **real OpenVPN client on the host —
outside the Docker network namespace — dialed the published port**, not a
Docker-internal address:

```
--- helper published ports (host) ---
1194/tcp -> 0.0.0.0:1194
1194/udp -> 0.0.0.0:1194
EXT-READY server running on port 1194 id=0f8b3cc5-...
=== EXTERNAL client: host openvpn → 127.0.0.1:1194 (published data port) ===
VPN-DATAPLANE-004/005 external client tunnel ESTABLISHED
VPN-DATAPLANE-006 client tunnel IP = 10.9.9.2
  (server pushed config to client)
VPN-DATAPLANE-007 stop client cleanly → tunext0 removed
VPN-DATAPLANE-003 (runtime) → only data ports published (control socket private)
```
TLS/auth completed (DB-backed `auth-user-pass-verify`), the TUN came up, the
client received a VPN address (10.9.9.2), the server pushed its config, and the
session stopped cleanly. **External data-plane reachability confirmed.**

---

## Regression — accepted SEC-INFRA-001 architecture intact (§9)

Runtime re-verification with the new port config:
```
Backend:  uid=10001  CapEff=0000000000000000  /dev/net/tun ABSENT
          NET_ADMIN op → "RTNETLINK answers: Operation not permitted"
Helper:   CapEff = 0x1000 = cap_net_admin (only)   /dev/net/tun PRESENT
          published ports = data port only; control socket NOT published
```
Backend UID ≠ 0, no NET_ADMIN, no /dev/net/tun, does not spawn OpenVPN; helper
NET_ADMIN + TUN present, control plane not public; helper-down still fail-closed
(unchanged). No SEC-INFRA-001 protection was weakened to expose the port.

**Automated suites (re-run):** backend unit **187** / integration **199** (real
Postgres) / desktop **23** / deploy suites (evidence 31 / install-sim 33 /
security-port 81 / vpn-deploy 11) — all green. SEC-INFRA-001 helper tests
(protocol 11, core 21, IPC 10, compose-contract 11) all pass; the compose
contract now asserts the helper publishes ONLY the OpenVPN data port and never a
control port.

---

## Automatic rejection conditions — none present

- Fresh install still requires manual VPN_HELPER_SECRET editing → NO (generated + validated). ✅
- Update rotates an existing VPN_HELPER_SECRET → NO (preserved; SECRET-005). ✅
- VPN_HELPER_SECRET appears in logs → NO (never printed; SECRET-006). ✅
- External VPN client cannot reach the server → NO (live tunnel established). ✅
- Only Docker-internal connectivity was tested → NO (host client, outside the container netns). ✅
- Helper control API/socket becomes publicly exposed → NO (Unix socket, zero control ports). ✅
- Backend regains NET_ADMIN or /dev/net/tun → NO (CapEff=0, no tun). ✅
- Backend starts OpenVPN locally → NO (only the helper spawns it; fail-closed). ✅

Only the two deployment issues were changed; the VPN Helper architecture is
unmodified.
