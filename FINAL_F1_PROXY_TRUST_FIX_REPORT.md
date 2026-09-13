# FINAL F1 Proxy-Trust Fix Report
**Awamer / NetSphere Terminal**

Tightens the remaining F1 issue found in independent review: the previous default
`TRUST_PROXY=loopback, uniquelocal` still trusted private/LAN addresses as proxy
hops, so a LAN client could rotate `X-Forwarded-For` to poison `req.ip` / rate
limiting / audit. Scope strictly limited to proxy trust. Branch
`claude/nifty-johnson-u2dwye`.

**Nothing already accepted was weakened** — F2 IPv6/mapped-IPv6 SSRF, DNS-rebinding
and redirect SSRF protection, and the JWT `algorithms:["HS256"]` pin all still pass
their suites (see Regression).

---

## Gate table

| Gate | Result |
| --- | --- |
| trustProxy `true` removed | **PASS** — `server.ts` uses `trustProxy: cfg.trustProxy` |
| default loopback only | **PASS** — `TRUST_PROXY` default `"loopback"` (PROXY-CONFIG-001) |
| uniquelocal removed from default | **PASS** — default no longer contains `uniquelocal` |
| LAN client not trusted automatically | **PASS** — PROXY-TRUST-LAN-001 |
| X-Forwarded-For rotation blocked | **PASS** — PROXY-RATELIMIT-LAN-001 + real-nginx runtime |
| rate-limit bypass blocked | **PASS** — unit + **live real-nginx** (429 after rotation) |
| audit IP poisoning blocked | **PASS** — PROXY-AUDIT-LAN-001 |
| legitimate Nginx path works | **PASS** — PROXY-NGINX-001 (**real nginx runtime**, healthz via netns client) |
| backend remains loopback-only | **PASS** — compose publishes `127.0.0.1:8081:8081` |
| old default upgrade handled | **PASS** — PROXY-UPGRADE-001 (`update.sh` migrates to `loopback`) |
| custom proxy config preserved safely | **PASS** — PROXY-UPGRADE-002/004 (preserved; broad values warned) |
| F2 IPv6 SSRF regression | **PASS** — SSRF-IPV6-001..012 green |
| JWT HS256 regression | **PASS** — JWT-ALG-001..006 green |

```
F1 STATUS: FIXED
F2 REGRESSION: PASS
JWT HARDENING REGRESSION: PASS
```

---

## Changes (proxy trust only)

- **`backend/src/config/index.ts`**
  - `TRUST_PROXY` default changed `"loopback, uniquelocal"` → **`"loopback"`**.
  - New `isDangerousTrustProxy()` + zod refine: **fail-closed** rejection of values
    that trust everyone or nothing — `true`, `false`, `*`, `0.0.0.0/0`, `::/0`,
    `0.0.0.0`, `::`, and empty/whitespace. An invalid trust config makes
    `loadConfig()` throw; it never silently falls back to broad trust.
- **`deploy/docker-compose.production.yml`** — `auth-service` now passes
  `TRUST_PROXY: ${TRUST_PROXY:-loopback}` with a comment: this backend is
  containerized behind the host Nginx, so for accurate per-client IPs the operator
  sets `loopback,<docker-bridge-gateway>/32`; never a whole private range.
- **`deploy/.env.production.example`** — documents `TRUST_PROXY=loopback` (secure
  default) and the rule: *a private/LAN address is a client, not a proxy; add an
  exact proxy CIDR only for a real reverse proxy / load balancer; broad values are
  rejected.*
- **`deploy/scripts/update.sh`** — `ensure_trust_proxy_default()` (upgrade safety):
  migrates the exact old generated default `loopback, uniquelocal` → `loopback`;
  adds `loopback` when the key is absent; **preserves an administrator-customized
  value** and prints a WARNING when a broad custom value (RFC1918 supernets, `/≤16`
  prefixes, `uniquelocal`/`linklocal`, all-zero CIDRs) remains. No secrets printed.

`server.ts` already reads `cfg.trustProxy` (from the prior F1 change) — unchanged
here. Nginx already overwrites `X-Real-IP`/`Proto`/`Host` and clears the unused
RFC 7239 `Forwarded` header (prior change) — reconfirmed.

## Trust model (documented)

```
Client → Nginx → 127.0.0.1:8081 backend      DEFAULT: TRUST_PROXY=loopback
```
The backend trusts `X-Forwarded-*` only from the loopback proxy hop. Nginx appends
the real `$remote_addr` as the right-most `X-Forwarded-For` entry; proxy-addr walks
from the trusted loopback peer and stops at that first untrusted (client) address,
so any client-injected left-most entries are discarded. **A private/LAN client is a
client, not a proxy** — it is not trusted, so it cannot rotate `X-Forwarded-For` /
`X-Real-IP` / `Forwarded` to choose `req.ip`. Additional proxies (a load balancer,
a containerized proxy) must be added as **exact** addresses/CIDRs.

---

## Runtime validation (§16/§17)

**Real Nginx + real backend (executed, not unit-only).** A client in a separate
network namespace (`10.200.9.2`, non-loopback) reached **real Nginx 1.24**
(`10.200.9.1:8090`) which proxied to the backend (`127.0.0.1:18083`,
`TRUST_PROXY=loopback`) using the production header directives:
- **PROXY-NGINX-001** — legitimate client → nginx → backend path works (`/healthz`
  200 through the netns client).
- **LAN spoof through real nginx** — 14 login attempts each rotating
  `X-Forwarded-For` → the backend attributed all to the real client `10.200.9.2`
  and returned **429** (rate limit tripped). Rotation did **not** create new
  identities. Evidence: `NGINX RUNTIME RESULT: PASS=3 FAIL=0`.

**Backend-side (executed earlier this branch).** With an untrusted peer, rotating
`X-Forwarded-For` produced 10×401 then 429 — the limiter keys on the real peer.

**§10 backend binding.** Production compose publishes `127.0.0.1:8081:8081`
(loopback-only); the backend is not publicly exposed (nginx is the only ingress).

---

## Tests

| ID | Result |
| --- | --- |
| PROXY-TRUST-001/002/003 (untrusted peer / X-Real-IP / Forwarded) | PASS |
| PROXY-TRUST-004/005/006 (explicit trusted proxy; two clients; untrusted hop) | PASS |
| PROXY-TRUST-LAN-001 (LAN client not a trusted proxy) | PASS |
| PROXY-RATELIMIT-LAN-001 (XFF rotation cannot bypass rate limit) | PASS |
| PROXY-AUDIT-LAN-001 (XFF/X-Real-IP/Forwarded rotation cannot poison audit IP) | PASS |
| PROXY-NGINX-001 (legitimate nginx path) | PASS (real nginx runtime) |
| PROXY-CONFIG-001 (default loopback) | PASS |
| PROXY-CONFIG-002 (explicit CIDR accepted) | PASS |
| PROXY-CONFIG-003 (invalid fails closed) | PASS |
| PROXY-CONFIG-004 (broad dangerous rejected) | PASS |
| PROXY-UPGRADE-001..004 (migrate old default; preserve custom; warn on broad) | PASS |
| SSRF-IPV6-001..012 (F2 regression) | PASS |
| JWT-ALG-001..006 (HS256 regression) | PASS |

**Regression:** backend unit **263 / 0** (incl. all above), integration **209 / 0**
(login, AUTH-INVALIDATE + WS, MFA, step-up, tenant, RBAC, netCidr, VPN),
proxy-trust-upgrade deploy test **6 / 0**, real-nginx runtime **3 / 0**. No test was
weakened; the `secretBox.test.ts` fake `Config` still carries a valid non-dangerous
`trustProxy` value.

---

## No scope creep

Only proxy-trust config/deploy files + their tests changed. No change to VPN /
helper / firewall / RBAC / tenant / MFA / session / password-reset / AI-provider
architecture or the database schema; no dependency upgrades.

---

## Automatic-rejection checklist — none triggered

Default is `loopback` (not `loopback, uniquelocal`) ✔ · `trustProxy` never `true`
✔ · private/RFC1918 clients not auto-trusted ✔ · LAN client cannot rotate XFF to
alter `req.ip` (real-nginx runtime) ✔ · LAN client cannot bypass rate limiting via
forwarding headers ✔ · audit source IP not poisonable ✔ · invalid config fails
closed (never broad) ✔ · upgrade migrates the known broad default and warns on
custom broad values ✔ · legitimate nginx path works ✔ · IPv6 SSRF fix intact ✔ ·
JWT algorithm allowlist intact ✔.
