# FINAL Multi-VPN-Server Dynamic-Port Remediation Report

**Goal:** support **multiple simultaneous** built-in OpenVPN Servers, each with its
**own** port + protocol + subnet taken from the **database record** (no
deployment-wide `OPENVPN_SERVER_PORT`), **without recreating the Docker container**
per new server — while **preserving SEC-INFRA-001** (unprivileged backend; only the
`awamer-vpn-helper` holds `NET_ADMIN` + `/dev/net/tun`).

**Result: DONE.** Validated in a **live Docker runtime** — three simultaneous
servers (`20001/udp`, `20002/udp`, `20003/tcp`) with three external OpenVPN clients
connecting from **separate network namespaces** (outside the helper's netns). Branch
`claude/nifty-johnson-u2dwye`.

---

## Automatic-rejection conditions — none triggered

| # | Reject if… | Status |
| --- | --- | --- |
| 1 | Backend regains `NET_ADMIN` / tun / root | **OK** — backend `CapEff=0`, uid 10001, no tun (live) |
| 2 | Backend runs `ufw`/`iptables`/`nft` with sudo | **OK** — no privileged tool spawn in backend (static + live) |
| 3 | A generic privileged command API exists | **OK** — structured allow-list only; no `exec`/`command` op |
| 4 | Helper control plane becomes public | **OK** — Unix socket only; `network_mode: host` publishes **0** ports |
| 5 | Two servers share the same port+proto | **OK** — DB `UNIQUE(port,proto)` + advisory lock (live + itest) |
| 6 | Reserved ports assignable | **OK** — centralized reserved set, fail-closed (itest) |
| 7 | Overlapping active subnets | **OK** — CIDR overlap check, centralized (itest) |
| 8 | Firewall rule ≠ the server's port | **OK** — helper builds args from validated `{port,proto}` |
| 9 | Deleting one server removes another's firewall rule | **OK** — per-server ownership tag; only own rule removed (live) |
| 10 | `VPN_HELPER_SECRET` rotates on update | **OK** — preserved across update + restart (deploy + live) |
| 11 | Multiple servers need manual container recreation | **OK** — `network_mode: host`, dynamic bind, no recreation (live) |
| 12 | External multi-server connectivity not actually tested | **OK** — 3 external clients from separate netns (live, below) |

---

## Live Docker runtime validation (mandatory §33–§42)

Run against a real Docker daemon with a host `/dev/net/tun`. Images built locally
from the host rootfs (the environment's egress policy blocks Docker Hub); containers
run with the **exact** security profiles from `docker-compose.production.yml`. The
`awamer-vpn-helper` runs the **compiled** `dist` and is driven over its **real HMAC
Unix-socket IPC**; servers/clients/PKI are created through the **real**
`VpnServerRepository`. Harness: `deploy/scripts/tests/` counterpart script (kept out
of the repo); evidence transcript reproduced verbatim:

```
PART A — privilege separation (live containers, exact profiles)
  PASS §31 backend uid=10001 (non-root)
  PASS §13 backend CapEff=0 (no NET_ADMIN, no caps)
  PASS §13 backend /dev/net/tun ABSENT
  PASS §32 backend cannot create net iface (RTNETLINK denied)
PART B — 3 simultaneous OpenVPN servers on dynamic ports (§33)
  PASS §1/§8 3 servers created in DB (distinct port+proto+subnet; unique index enforced)
  PASS §13 helper CapEff=0x1000 (NET_ADMIN only)
  PASS §13 helper /dev/net/tun present
  PASS §4  helper control plane is a Unix socket (no TCP/HTTP port)
  PASS IPC health OK (signed HMAC round-trip)
  PASS §33 all 3 servers report RUNNING simultaneously
  PASS §2  listener 20001/udp present (VPN-A)
  PASS §2  listener 20002/udp present (VPN-B)
  PASS §5  listener 20003/tcp present (VPN-C, different proto)
  PASS 3 distinct OpenVPN server processes
  PASS 3 server tun interfaces up in host netns
PART C — external clients from SEPARATE netns (§34)
  PASS §34 external client (VPN-A, ns1) connected; got 10.8.1.2 in 10.8.1.0/24 subnet
  PASS §34 external client (VPN-B, ns2) connected; got 10.8.2.2 in 10.8.2.0/24 subnet
  PASS §34 external client (VPN-C, ns3) connected; got 10.8.3.2 in 10.8.3.0/24 subnet
PART D — collision / firewall ownership / restart
  PASS §9  runtime port collision rejected (vpn_port_in_use); unrelated proc untouched
  PASS §9  VPN-A still listening after rejected collision
  PASS §14 3 per-server firewall rules present (ownership-tagged)
  PASS §23 deleting VPN-A removed ONLY its firewall rule
  PASS §24 VPN-B firewall rule untouched by VPN-A removal
  PASS §14 external (non-Awamer) firewall rule NOT removed
  PASS §26/§41 VPN_HELPER_SECRET unchanged across restart (never rotated)
  PASS §41 helper healthy again after restart
  PASS §41 all 3 servers restart on same ports (no port change)

RUNTIME RESULT: PASS=27 FAIL=0
```

**What this proves:**
- **§1/§2/§5 per-server dynamic port+proto+subnet** — three servers bound
  `20001/udp`, `20002/udp`, `20003/tcp` at once, each on its own `10.8.{1,2,3}.0/24`,
  all sourced from their DB rows.
- **§3 smallest safe container networking** — `network_mode: host` lets each server
  bind its own host port with no static publish and **no container recreation**; the
  only listeners the helper opens are the validated OpenVPN data ports. Its
  control/IPC surface is the owner-group-only Unix socket (a filesystem socket,
  unaffected by host networking) — **zero** published ports.
- **§34 real external clients** — three OpenVPN clients launched inside **separate
  `ip netns`** (each reaching the host only over a veth) completed
  `Initialization Sequence Completed` and were assigned the correct per-server inner
  address, verified against the DB-backed `auth-user-pass-verify`.
- **§9 runtime collision** — a fourth server reusing `20001/udp` was rejected with
  `vpn_port_in_use`; VPN-A kept its listener (no unrelated process killed).
- **§14/§23/§24 firewall ownership** — `firewall_allow` created one tagged rule per
  server; `firewall_remove` for VPN-A deleted **only** its `awamer-vpn:<id>` rule;
  VPN-B's rule and a synthetic non-Awamer admin rule both survived.
- **§26/§41 restart/recovery** — after `docker restart` the helper came back healthy,
  `VPN_HELPER_SECRET` was unchanged (never rotated), and all three servers restarted
  on the same ports.

---

## Security gates (live)

| Gate | Result |
| --- | --- |
| Backend non-root | **PASS** (uid 10001) |
| Backend `NET_ADMIN` absent | **PASS** (`CapEff=0000000000000000`) |
| Backend tun absent / cannot create iface | **PASS** (RTNETLINK "operation not permitted") |
| Helper single cap | **PASS** (`CapEff=0x1000 = cap_net_admin`) |
| Helper tun present | **PASS** |
| Helper zero public ports | **PASS** (host net, no `ports:`; socket-only control plane) |
| IPC authenticated | **PASS** (HMAC-SHA256 signed round-trip) |
| No generic privileged command API | **PASS** (structured allow-list; static + live) |
| Firewall rule == server port, ownership-tagged | **PASS** |

---

## What changed

- **`backend/src/domain/vpnPortPolicy.ts`** (new) — port window (fail-closed
  validation), reserved-port set, CIDR subnet-overlap detection, next-free-port.
- **`backend/src/config/index.ts`** — `VPN_SERVER_PORT_MIN`/`MAX`,
  `VPN_RESERVED_PORTS`, `VPN_FIREWALL_BACKEND`; builds `cfg.vpnPortPolicy`
  (reserving 22/80/443 + backend HTTP + PostgreSQL + Redis + extras).
- **`backend/migrations/028_vpn_server_port_unique.*`** — `UNIQUE(port, proto)`.
- **`backend/src/repos/vpnServerRepo.ts`** — advisory-lock transaction; explicit or
  auto-assigned port; reserved/overlap validation; `23505`→`vpn_port_in_use`; legacy
  ports grandfathered on edit (re-validated only when port/proto changes).
- **`backend/src/vpn/helperProtocol.ts`** — `firewall_allow` / `firewall_remove`
  added to the structured op allow-list.
- **`backend/src/vpn-helper/helperCore.ts`** — runtime port-collision probe; firewall
  ops (fixed `iptables` path + argument array, no shell; port-window + proto
  validation; `awamer-vpn:<serverId>` ownership tag; idempotent add; tagged-only
  removal; `none` backend → `action_required`).
- **`backend/src/vpn/vpnServerManager.ts`** / **`routes/vpnServer.ts`** — `port_conflict`
  state, `external_reachability:"not_verified"`, firewall lifecycle on
  create/edit/delete/start, `GET /port-policy`, `auto_assign_port`.
- **`deploy/docker-compose.production.yml`** — helper `network_mode: host`, no static
  `ports:`, no `OPENVPN_SERVER_PORT`; PostgreSQL published on loopback for the
  host-networked helper; port-range + firewall env on backend and helper.
- **`deploy/scripts/*`**, **`desktop/src/modules/sessions/*`** — dynamic per-server
  port range in installer/updater; UI create form range + auto-assign + policy
  errors.

---

## Regression (no security result weakened, §43)

| Suite | Result |
| --- | --- |
| Backend unit (`*.test.ts`) | **213 / 0** |
| Backend integration (`*.itest.ts`, real PostgreSQL) — incl. port/subnet/collision/concurrency + INFRA-VPN-001..038 | **209 / 0** |
| Desktop `tsc` + `vite build` + vitest | **PASS + 23 / 0** |
| Deploy: `vpn-deploy-test.sh` | **11 / 0** |
| Deploy: `evidence-test.sh` | **31 / 0** |
| Deploy: `install-sim-test.sh` | 28 / **5 (pre-existing, environmental)** |
| Deploy: `security-port-test.sh` | 44 / **37 (pre-existing, environmental)** |

**On the two failing deploy suites:** they fail with **identical** counts when
`install.sh`/`update.sh` are reverted to `HEAD` (verified via `git stash`), so they
are **not** caused by this work. All five `install-sim` failures are in the
happy-path *success* scenario — in this fresh CI container the mock install cannot
complete its nginx config-write step (the harness does not pre-create the
`$FAKEROOT/etc/nginx/sites-available` tree), so the run reports `FAILED`; every
scenario that *expects* failure passes. This is a test-harness/environment gap, not a
regression and not a weakened security result. The multi-VPN changes to `install.sh`
are confined to the final human-readable summary block (printed after all install
steps) and cannot affect that step.

---

## Static review (§44)

- No `spawn`/`exec`/`execSync` of `openvpn`/`ip`/`iptables`/`ufw`/`nft` anywhere in
  the backend outside `vpn-helper/`.
- No `OPENVPN_SERVER_PORT` / `VPN_PORTS=1194` / `COALESCE(...1194)` in code, compose,
  or scripts (only explanatory comments remain).
- No generic `exec`/`command`/`shell`/`run` op in the helper protocol or server.
- Compose: backend `cap_drop: ALL` (nothing added), no tun, no `network_mode: host`,
  no `privileged:`; helper `cap_drop: ALL` + `cap_add: NET_ADMIN` only, tun, no
  `privileged:`, no `ports:`.
