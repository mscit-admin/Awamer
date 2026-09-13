# FINAL PROXY-DEPLOY-001 Remediation Report
**Awamer / NetSphere Terminal**

Fixes the production Nginx → Docker → auth-service proxy-hop trust integration:
the backend runs in a container behind the host Nginx (published on
`127.0.0.1:8081`), so its peer is the Docker bridge **gateway**, not loopback.
The installer/updater now **discovers the actual gateway** and trusts it as an
**exact host route** (`loopback,<gw>/32[,<gw6>/128]`) — never a private range,
fail-closed if undeterminable. Scope limited to PROXY-DEPLOY-001. Branch
`claude/nifty-johnson-u2dwye`.

**Accepted fixes are intact:** app default `TRUST_PROXY=loopback` unchanged
(`uniquelocal` appears only in an explanatory comment); F1 spoof/rate-limit/audit
protections, F2 IPv6/mapped-IPv6/DNS/redirect SSRF, and JWT `["HS256"]` all still
pass (see Regression). No app/src code changed — deploy scripts only.

---

## Gate table

| Gate | Result |
| --- | --- |
| Docker gateway dynamically discovered | **PASS** (lib + runtime: `172.30.0.1`) |
| Exact /32 or /128 trust | **PASS** (`loopback,<gw>/32`; `/128` for IPv6) |
| No broad RFC1918 trust | **PASS** (broad values rejected; discovery emits only host routes) |
| Installer integration | **PASS** (install.sh discovers post-up, recreates auth-service) |
| Upgrade integration | **PASS** (update.sh Phase-2 discover/refresh; PROXY-DEPLOY-007) |
| Backend loopback publication | **PASS** (`127.0.0.1:8081:8081`; runtime `ss` loopback-only) |
| Real Nginx→Docker→Backend path | **PASS** (real Docker network + NAT + container + host nginx) |
| Two clients distinguishable | **PASS** (A=10.201.1.2, B=10.201.2.2; not the gateway) |
| XFF spoofing blocked | **PASS** (runtime: audit IP = real client, not spoof) |
| LAN spoofing blocked | **PASS** (private netns clients not trusted; XFF ignored) |
| Rate-limit rotation blocked | **PASS** (runtime: 429 after XFF rotation) |
| Audit client IP correct | **PASS** (runtime: audit_logs.ip_address = real client) |
| F1 regression | **PASS** (PROXY-TRUST/RATELIMIT/AUDIT + config green) |
| F2 IPv6 SSRF regression | **PASS** (SSRF-IPV6-001..012) |
| JWT HS256 regression | **PASS** (JWT-ALG-001..006) |

```
PROXY-DEPLOY-001: FIXED
```

---

## What changed (deploy integration only)

- **`deploy/scripts/lib/trustproxy.sh`** (new, sourceable, unit-tested): 
  - `tp_discover_gateway <container> <network>` — inspects the **actual** network
    the `netsphere-auth` container is attached to (falls back to the named
    network's IPAM), extracts the IPv4/IPv6 gateway, and **fails closed** on
    ambiguity (multiple distinct v4 gateways) or absence. Docker CLI is
    parameterized via `TP_DOCKER` (install.sh uses `sudo docker`).
  - `tp_valid_ipv4/ipv6`, `tp_is_broad_entry` — validation; reject `0.0.0.0`,
    `0.0.0.0/0`, `::/0`, `true/false/*`, `uniquelocal`/`linklocal`, RFC1918
    supernets and small (`/≤16`) prefixes.
  - `tp_build_managed` → `loopback[,<gw>/32][,<gw6>/128]` (exact host routes only).
  - `tp_configure_env` — the decision engine using a **managed marker**
    (`# awamer-managed-trust-proxy=<value>` above the `TRUST_PROXY=` line): writes
    the managed value on a fresh/absent config, migrates the legacy broad default,
    **refreshes a stale generated gateway** (no accumulation), and **preserves an
    administrator-customized value** (never overwrites a real reverse-proxy/LB
    entry; warns if broad or if the discovered gateway is missing). If the gateway
    cannot be determined it keeps `loopback` and emits an ACTION REQUIRED warning —
    it **never** broadens.
- **`deploy/scripts/install.sh`** — after the stack is up and `/readyz` passes,
  sources the lib, runs `tp_configure_env` (with `TP_DOCKER="sudo docker"`), and
  recreates **only** `auth-service` if the value changed, then re-verifies `/readyz`.
- **`deploy/scripts/update.sh`** — Phase 1 (pre-compose) keeps the safe baseline +
  legacy-broad migration; Phase 2 (post-compose, network exists) discovers the
  gateway, refreshes `TRUST_PROXY`, and recreates only `auth-service` if it
  changed — no PostgreSQL/VPN/secret churn.
- `docker-compose.production.yml` (`TRUST_PROXY=${TRUST_PROXY:-loopback}`) and
  `.env.production.example` (documented default + Docker-gateway note) were added
  in the prior F1 task and are unchanged here.

## Trust model

```
UNTRUSTED: Client / Internet / LAN
                 ↓
              Nginx  (overwrites X-Real-IP/Proto/Host; appends real $remote_addr to XFF; clears Forwarded)
                 ↓
TRUSTED INFRASTRUCTURE: exact Docker gateway  <gw>/32 (or /128)
                 ↓
             auth-service container

TRUST_PROXY = loopback + exact discovered gateway host route     (never a whole private network)
```
A private/LAN client stays untrusted — it cannot become a proxy just for being
RFC1918. The gateway is trusted, so Nginx-forwarded client IPs resolve correctly;
the client's own left-most XFF entries are discarded.

---

## Runtime evidence (§24) — REAL Docker topology

Executed: real Docker bridge network (`awpd-net`, subnet `172.30.0.0/24`, gateway
`172.30.0.1`) → **auth-service in a container** on that network, published
`127.0.0.1:18086:8081` → host **Nginx 1.24** (production header directives) →
two clients in **separate network namespaces** (`10.201.1.2`, `10.201.2.2`, both
private/LAN). Client IP verified from `audit_logs.ip_address`.

```
Docker network name:  awpd-net
Actual gateway:       172.30.0.1  (discovered by the shipped lib)
Effective TRUST_PROXY: loopback,172.30.0.1/32
auth-service network: awpd-net (container behind Docker NAT)
Backend peer:         Docker gateway (trusted /32)
Backend publication:  127.0.0.1:18086 only (ss: no 0.0.0.0)
Client-A effective IP: 10.201.1.2   (forged XFF 1.1.1.1 IGNORED)
Client-B effective IP: 10.201.2.2   (distinct from A; NOT the gateway)
Rate-limit (A, XFF rotation): 429   (not bypassed)
Rate-limit (B while A limited): 401  (B has its own identity)
Audit source IP:      the real client, never 172.30.0.1

PROXY-DEPLOY RUNTIME RESULT: PASS=7 FAIL=0
```

This proves both halves of PROXY-DEPLOY-001: (a) clients are **not** collapsed to
the shared Docker gateway identity, and (b) forged/rotated `X-Forwarded-For`
cannot choose `req.ip` or bypass the rate limit through the real Nginx→Docker→
container path.

**Image caveat (honest):** the container ran the locally-built runtime image
(`aw-runtime:local`, host rootfs) because the production `node:20-alpine` base is
**egress-blocked** (Docker Hub `403`) in this sandbox. The behavior under test —
Docker NAT gateway-peer resolution, gateway discovery, and trust — is
image-independent (it depends on Docker networking + the app's `trustProxy`, both
exercised for real). The exact production Alpine image was not built here.

---

## Tests

| ID | Result |
| --- | --- |
| PROXY-DEPLOY-001 gateway discovered (mock + runtime) | PASS |
| PROXY-DEPLOY-002 exact /32 | PASS |
| PROXY-DEPLOY-003 IPv6 /128 | PASS |
| PROXY-DEPLOY-004 no broad/RFC1918-wide trust | PASS |
| PROXY-DEPLOY-005 missing gateway fails closed | PASS |
| PROXY-DEPLOY-006 admin custom preserved | PASS |
| PROXY-DEPLOY-007 stale gateway replaced (no accumulation) + marker-less upgrade | PASS |
| PROXY-DEPLOY-008 backend loopback-only publication | PASS |
| PROXY-DEPLOY-RUNTIME-001..008 (real Docker topology) | **PASS (7/7 + exposure)** |

**Regression:** backend unit **263/0** (incl. PROXY-TRUST/AUDIT/CONFIG, SSRF-IPV6,
JWT-ALG), integration **209/0**, proxy-deploy unit **11/0**, proxy-trust-upgrade
**6/0**, vpn-deploy **11/0**. No app/src changed; `TRUST_PROXY` default is still
`loopback`.

---

## No scope creep

Only deploy scripts + their tests + this report + CHANGELOG changed. No change to
auth/JWT/RBAC/tenant/MFA/session/VPN/firewall/AI/schema; no dependency upgrades;
no application features.

---

## Automatic-rejection checklist — none triggered

`TRUST_PROXY` not back to `loopback, uniquelocal` ✔ · not `true` ✔ · no whole
RFC1918 range trusted ✔ · gateway **not** hard-coded (discovered) ✔ · installer
does not assume `172.17.0.1` ✔ · backend not publicly exposed on :8081 ✔ · clients
not all seen as the Docker gateway ✔ · LAN clients not trusted proxies ✔ · XFF
rotation cannot bypass rate limit ✔ · audit IP not attacker-selectable via headers
✔ · real Docker path validated in a **container** (not host-only) ✔ · F2 SSRF
intact ✔ · JWT HS256 intact ✔.
