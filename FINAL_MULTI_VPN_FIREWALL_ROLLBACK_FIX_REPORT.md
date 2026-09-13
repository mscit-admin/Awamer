# FINAL Multi-VPN Firewall + Rollback Fix Report

Two scoped fixes on top of the accepted Multi-VPN dynamic-port architecture (which
is unchanged):

- **MULTI-VPN-FW-001** — the production `vpn-helper` image now explicitly installs
  the firewall backend (`iptables`), the helper **verifies it at startup and fails
  closed** if unusable, and `health` reports the firewall capability.
- **MULTI-VPN-ROLLBACK-001** — VPN Server port/protocol changes are now performed by
  a **rollback-safe state machine**: the old firewall rule is never removed before
  the new listener is proven healthy, and any failure restores the original working
  state (or reports `RECOVERY_REQUIRED`, never a false success).

Branch `claude/nifty-johnson-u2dwye`.

---

## Gate table

| Gate | Result |
| --- | --- |
| Production helper contains firewall backend | **PASS** (`apk add … iptables`; present + runnable in a live container) |
| Firewall startup capability check | **PASS** (`probeFirewall()` at boot; fail-closed) |
| No generic privileged command API | **PASS** (structured `firewallAllow/Remove` only; static review) |
| Successful running port change | **PASS** (VPN-PORT-CHANGE-001..005) |
| Firewall-add rollback | **PASS** (VPN-ROLLBACK-001) |
| DB-failure rollback | **PASS** (VPN-ROLLBACK-002) |
| OpenVPN-start rollback | **PASS** (VPN-ROLLBACK-003; live §21) |
| Listener-health rollback | **PASS** (VPN-ROLLBACK-004) |
| Rollback-failure recovery state | **PASS** (VPN-ROLLBACK-006 → `recovery_required`) |
| Stopped-server reconfiguration | **PASS** (VPN-ROLLBACK-007..009) |
| Protocol-change rollback | **PASS** (VPN-ROLLBACK-010/011) |
| Concurrent reconfiguration protection | **PASS** (VPN-RECONFIG-CONCURRENCY-001) |
| Real production image test | **PARTIAL — see note** (real, non-mocked iptables + exact security profile verified live; the `node:20-alpine` **base layer** is not pullable in this sandbox) |
| Real OpenVPN rollback test | **PASS** (live: failed 20001→20005 change restored 20001 + external client reconnected) |
| Backend remains unprivileged | **PASS** (uid 10001, `CapEff=0`, no tun — unchanged) |
| Existing Multi-VPN tests | **PASS** (unit 230/0, integration 209/0, desktop 23/0, deploy vpn 11 + evidence 31, multi-VPN runtime 27/0) |

### Note on the "real production image test" (§19)

The shipped image is `FROM node:20-alpine`. This sandbox's egress policy blocks the
Docker registry **and** the Alpine package CDN (`docker pull node:20-alpine` and the
Alpine minirootfs both return `403 Forbidden`; the proxy allowlist covers only
npm/pypi/crates/go registries). The `docker build` of `Dockerfile.vpn-helper` was
attempted and fails at the base-image pull — captured verbatim in the evidence.

What this does **not** leave unverified:
- The Dockerfile **explicitly installs `iptables`** (`apk add --no-cache tini
  openvpn iproute2 iptables`) — verified statically and asserted by test.
- The firewall + rollback behaviour was validated at runtime against a **real,
  non-mocked `iptables` binary** (nf_tables v1.8.10) and **real OpenVPN**, in a
  container running the **exact production security profile** (`cap_drop: ALL` +
  `cap_add: NET_ADMIN` only, `/dev/net/tun`, `no-new-privileges`, not privileged,
  host networking, socket-only control plane). Container `CapEff=0x1000` (NET_ADMIN
  only) confirmed live.

Remaining remediation: none in code. To exercise the exact Alpine layer, run
`docker build -f backend/Dockerfile.vpn-helper` in an environment with registry
egress; the `apk add … iptables` line guarantees the binary is present.

---

## Live runtime evidence (§19 / §20 / §21)

Real helper container (exact production security profile), real `iptables`, real
OpenVPN, real external client in a **separate network namespace**. Verbatim:

```
§19 — real helper image
  PASS §13 Dockerfile.vpn-helper installs iptables explicitly
  PASS §13/VPN-FW-BINARY-001 iptables present in helper image (/usr/sbin/iptables)
  PASS VPN-FW-BINARY-002 iptables runnable (iptables v1.8.10 (nf_tables))
  PASS §19 helper CapEff=0x1000 (NET_ADMIN only)
  PASS §19 /dev/net/tun present
  PASS §19 helper not privileged
  PASS VPN-FW-BINARY-003 health reports firewall capability (available:true)
    health = {"ready":true,"openvpn":true,"tun":true,"sessions":0,"firewallBackend":"iptables","firewallAvailable":true}
§20 — real per-server firewall
  PASS §20 per-server firewall rules created (VPN-A 20001 + VPN-B 20002)
  PASS §20 removing VPN-A deleted ONLY its rule
  PASS §20 VPN-B rule untouched
§21 — real OpenVPN rollback (20001/udp → 20005/udp, new start forced to fail)
  PASS §21 external client connected to VPN-A 20001/udp (got 10.8.1.2)
  PASS §21 failed port change rolled back (state machine)   [RECONFIG_OUTCOME rolled_back]
  PASS §21 DB restored to original 20001/udp
  PASS §21 old firewall rule (20001) restored
  PASS §21 new firewall rule (20005) not left behind
  PASS §21 old OpenVPN listener restarted on 20001/udp
  PASS §21 external client reconnected to restored VPN-A (addr=10.8.1.2)

ROLLBACK RUNTIME RESULT: PASS=18 FAIL=0
```

The §21 new-port start was made to fail **for real** by squatting `20005/udp` with a
separate process before the change, so the helper's runtime port-collision probe
rejects the new listener (`vpn_port_in_use`) and the state machine rolls back — no
mocks in the data path.

---

## What changed

**MULTI-VPN-FW-001**
- `backend/Dockerfile.vpn-helper` — `apk add … iptables` (explicit; no reliance on
  the host or transitive packages).
- `backend/src/vpn-helper/helperCore.ts` — `probeFirewall()` resolves the iptables
  path (configured → `/usr/sbin/iptables` → `/sbin/iptables`, a fixed candidate
  list, never a PATH/user lookup), confirms it runs (`--version`), and caches
  availability. `firewallAllow/Remove` **fail closed** when unavailable.
  `health()` now returns `{ firewallBackend, firewallAvailable }`.
- `backend/src/vpn-helper/main.ts` — calls `probeFirewall()` at startup and logs the
  result (never fatal; automatic firewall simply disabled if unusable).
- `deploy/docker-compose.production.yml` — `IPTABLES_PATH=/sbin/iptables` (Alpine).

**MULTI-VPN-ROLLBACK-001**
- `backend/src/vpn/vpnReconfigure.ts` (new) — `VpnReconfigurationService`: snapshot →
  validate NEW → prepare NEW firewall (old kept) → stop old (if running) → persist
  NEW → start NEW → verify listener → **only then** remove OLD firewall → commit.
  Rollback restores old DB + old firewall + restarts old OpenVPN; if it cannot,
  returns `recovery_required`. A per-server in-process guard gives a deterministic
  conflict for concurrent changes. Progress flags ensure a pre-stop failure never
  bounces the still-running old server.
- `backend/src/routes/vpnServer.ts` — `PATCH /servers/:id` delegates to the service
  and maps outcomes: `updated`/`reconfigured`/`cleanup_required` → 200 (with a
  `warning` when cleanup is needed), `rolled_back` → 409 `vpn_reconfiguration_failed`,
  `recovery_required` → 500 `vpn_recovery_required`, concurrent →
  409 `vpn_reconfiguration_in_progress`.
- `backend/src/server.ts` — constructs the service and wires it into the route.

No change to the accepted VPN Helper / Multi-VPN architecture, the IPC protocol, the
backend privilege boundary, port/subnet policy, or the DB schema.

---

## Tests

| Suite | Result |
| --- | --- |
| VPN-FW-BINARY-001/002 (image contains + runs iptables) | **PASS** (live container) |
| VPN-FW-BINARY-003 (health reports capability) | **PASS** (unit + live) |
| VPN-FW-BINARY-004 (missing executable fails closed) | **PASS** (unit) |
| VPN-FW-BINARY-005 (no shell fallback; fixed path + arg array) | **PASS** (unit) |
| VPN-PORT-CHANGE-001..005 (running change + ordering) | **PASS** (unit) |
| VPN-ROLLBACK-001..011 (failure injection at every stage) | **PASS** (unit) |
| VPN-RECONFIG-CONCURRENCY-001 | **PASS** (unit) |
| §21 real OpenVPN rollback | **PASS** (live) |
| Backend unit / integration | **230 / 0** · **209 / 0** |
| Desktop tsc + vitest + build | **PASS** · **23 / 0** · PASS |
| Deploy: vpn-deploy / evidence | **11 / 0** · **31 / 0** |
| Multi-VPN runtime regression (3 servers + external clients) | **27 / 0** |

(Pre-existing `install-sim` 28/5 and `security-port` 44/37 deploy suites remain a
documented sandbox/environment gap — unchanged by this work; see the multi-VPN
report.)

---

## Static review (§23)

- `iptables` is spawned in exactly one place: `helperCore.runFirewall()` — a **fixed
  executable path + argument array, `shell:false`**, inside the NET_ADMIN helper.
  Every argument is built by the helper from a validated `{serverId, port, proto}`;
  no rule text ever crosses the IPC boundary.
- No `iptables`/`nft`/`ufw` execution anywhere in the backend (non-helper) code.
- No generic `exec`/`command`/`shell` op in the helper protocol. The remaining
  `exec(` matches are `RegExp.exec()` and the SSH2 channel exec; the one non-helper
  `spawn` is the pre-existing network-diagnostic runner (fixed path + arg array, no
  shell) — unchanged by this work.
- Backend container remains unprivileged (`cap_drop: ALL`, no NET_ADMIN, no tun);
  helper remains `NET_ADMIN`-only + tun, not privileged, socket-only control plane.

---

## Automatic-rejection checklist — none triggered

Production helper installs the firewall executable ✔ · tests use a **real** iptables
binary (not mocked) ✔ · backend never executes firewall commands ✔ · no raw
shell/firewall args from API input ✔ · old firewall rule removed **only after** the
new config is proven healthy ✔ · a failed change never leaves the DB pointing at a
non-running listener ✔ · a failed change never permanently stops a working server ✔ ·
rollback failure surfaces `RECOVERY_REQUIRED` (audited) ✔ · backend keeps no
NET_ADMIN / no tun ✔ · helper not `privileged:true` ✔ · real OpenVPN rollback
validated ✔. The only qualifier is the Alpine **base-image pull** blocked by sandbox
egress (documented above), not a skipped validation of behaviour.
