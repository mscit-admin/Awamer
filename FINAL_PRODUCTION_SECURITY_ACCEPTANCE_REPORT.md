# FINAL Production Security Acceptance Report
**Awamer / NetSphere Terminal** — independent validation-server acceptance

- **Exact commit tested:** `dc74d9f4901c5b63a0e05166fd15a0c13587a77b`
- **Validation server:** Ubuntu 24.04.4 LTS, x86_64, 4 vCPU / 15 GiB RAM / 21 GB free
- **Tooling present:** Docker Engine 29.3.1 + Compose v5.1.1, PostgreSQL 16, OpenVPN 2.6.19, iptables 1.8.10 (nft), nginx 1.24.0, `/dev/net/tun` present, Playwright Chromium.
- **Source integrity:** **UNCHANGED** — 32 security-critical files identical before/after (`source-integrity-before.sha256` == `source-integrity-after.sha256`); no application code modified.
- **Evidence dir:** `/var/log/awamer/final-validation/<RUN-ID>/` (sanitized).

---

## §8 Docker Registry Gate — the deciding blocker

The task (§8) requires proving the server can pull the **exact** production base
images before any approval, and mandates: *"If any required production image cannot
be downloaded → STOP PRODUCTION APPROVAL → PRODUCTION APPROVAL NOT VERIFIED."*

```
node:20-alpine      -> Forbidden (HTTP 403)
postgres:16-alpine  -> Forbidden (HTTP 403)
redis:7-alpine      -> Forbidden (HTTP 403)
REGISTRY_GATE_FAIL=1
```

This validation server's egress policy **blocks the Docker registry**. The exact
production images therefore **cannot be built or run here**, so the entire
exact-production-runtime layer (§19–§58) is **NOT VERIFIED**. Per §8/§62 no
substitute image may be used to obtain a PASS.

Two further **mandatory** capabilities are also unavailable on this server:
- **Real IPv6** — `socket(AF_INET6)` → `Errno 97 Address family not supported`; 0 `inet6` addresses. §37/§13 real-IPv6 SSRF runtime = NOT VERIFIED.
- **Real browser against the exact HTTPS frontend** — Playwright Chromium exists, but the exact production frontend/Nginx/TLS stack cannot be built (depends on the blocked images). §42–§46 = NOT VERIFIED.

---

## Summary table

| Gate | PASS | FAIL | NOT VERIFIED |
| --- | ---: | ---: | ---: |
| Environment | ✔ (OS/tooling inventoried) | | ✔ (registry egress, IPv6, prod-frontend browser missing) |
| Exact production images | | | ✔ (registry 403) |
| Docker Compose | | | ✔ (depends on images) |
| Nginx/TLS | | | ✔ (site fragment; needs deployed certs + http-context include) |
| Proxy/client IP | | | ✔ exact-image runtime (behaviourally shown w/ local image, prior 7/0) |
| Authentication | ✔ executed (integration, real PG) | | ✔ exact-stack overlay |
| JWT/session | ✔ executed (JWT-ALG-001..006; AUTH-INVALIDATE + WS) | | |
| Tenant isolation | ✔ executed (tenantIsolation/NullScope/Shares, real PG) | | |
| RBAC | ✔ executed (rbacRoles/moveRbac/roleService) | | |
| MFA/Step-Up | ✔ executed (MFA-CRYPT-001..008, MFA-STEPUP-001..008) | | |
| IPv6 SSRF | | | ✔ runtime IPv6 (unit SSRF-IPV6-001..012 PASS) |
| Network diagnostics | ✔ executed (netCidr/netScope) | | |
| Browser security | | | ✔ (no exact HTTPS frontend/browser) |
| Upload security | | | ✔ (needs exact running app) |
| Backend privilege | | | ✔ exact image (shown w/ local image, prior CapEff=0) |
| VPN helper | | | ✔ exact image (shown w/ local image) |
| Multi-VPN | | | ✔ exact image (shown w/ local image, prior 27/0) |
| Firewall | ✔ executed (VPN-FW unit + prior runtime) | | ✔ exact image |
| VPN rollback | | | ✔ exact image (shown w/ local image, prior 18/0) |
| Audit durability (§56 induced failure) | | | ✔ (needs exact stack; not run) |
| DB outage | ✔ (prior live: readyz 503, auth fails closed) | | ✔ exact stack overlay |
| Restart/recovery | | | ✔ exact stack (behaviourally shown w/ local image) |
| Secret leakage | ✔ (app logs clean; audit read-back) | | ✔ Docker/Nginx/support-bundle on exact stack |
| Dependencies | ✔ (audit executed + recorded) | | |
| Regression suites | ✔ (see below) | | |

("✔ exact image/stack" under NOT VERIFIED = strong executed evidence at the
code/local-image level exists, but the **exact production image** the task mandates
was not reproducible here.)

---

## Executed evidence (real, this run)

- **Regression (§61), all green:** backend unit **263/0**, integration **209/0**
  (real PostgreSQL — AUTH-INVALIDATE(+WS), MFA-CRYPT, MFA-STEPUP, tenant*, RBAC,
  netCidr, SSRF-IPV6, helperIpc, migration integrity), desktop vitest **23/0**,
  deploy `proxy-deploy` **11/0**, `proxy-trust-upgrade` **6/0**, `vpn-deploy`
  **11/0**, `evidence` **31/0**.
- **Pre-existing environmental deploy-harness failures (not app defects, not new):**
  `install-sim-test` **28/5** and `security-port-test` **44/37** — identical counts
  to the documented baseline; these mocks require a `$FAKEROOT` nginx
  sites-available tree that a fresh container does not pre-create (the mock `sudo
  tee` step fails), so the happy-path scenarios report failure. They do not exercise
  the proxy/VPN/auth security logic. Recorded, not a P0/P1.
- **Dependency audit (§60), recorded, no `npm audit fix`:** backend 0 crit / 4 high
  / 2 mod / 1 low; desktop 1 crit (`@vitest/mocker`) / 4 high (`vite`,
  `browserslist`, `js-yaml`, `nanoid`) — **all dev/build-time, not shipped**.
  **`@xmldom/xmldom` present but NOT flagged by `npm audit`** → prior critical
  **remains resolved**. (P3, record-only.)
- **App defaults intact (no regression):** `TRUST_PROXY` default `loopback`;
  `trustProxy: cfg.trustProxy` (never `true`/`uniquelocal`); JWT
  `algorithms:["HS256"]` on all verify paths; SSRF IPv6/mapped/redirect guards
  present.

---

## Findings

No new vulnerability discovered. Standing (record-only, carried from prior rounds):
- **P3** — dependency advisories (backend deps; desktop dev/build tooling). Low/none
  shipped-artifact exploitability (`@fastify/static` gated off by default; desktop
  crit/high are test/build tools). Recommend a scheduled `npm audit` remediation in a
  normal maintenance change (out of scope: no fixes this round).

```
Exact commit tested: dc74d9f4901c5b63a0e05166fd15a0c13587a77b

Confirmed P0: 0
Confirmed P1: 0
Confirmed P2: 0 (new)
Confirmed P3: dependency advisories (record-only)

Mandatory FAIL: 0
Mandatory SKIP: 0
Mandatory NOT VERIFIED: exact production images; Docker Compose; Nginx/TLS runtime;
  proxy/client-IP (exact image); browser security; upload security; backend-privilege
  (exact image); VPN helper (exact image); Multi-VPN (exact image); VPN rollback
  (exact image); IPv6 SSRF runtime; audit durability (§56); restart/recovery (exact
  stack).

Source integrity: UNCHANGED

FINAL DECISION: PRODUCTION APPROVAL NOT VERIFIED
```

---

## Why NOT VERIFIED (and not APPROVED / not NOT-APPROVED)

- **Not APPROVED** — §66 requires `Mandatory NOT VERIFIED = 0` and the exact images
  /Compose/Nginx/IPv6/browser/VPN/proxy/audit-durability all tested on the exact
  stack. The §8 registry gate fails on this server (Docker Hub 403), and IPv6 + a
  production-frontend browser are unavailable, so those mandatory gates cannot be
  honestly marked PASS.
- **Not NOT-APPROVED** — no confirmed **P0/P1** was found; every control exercisable
  here (263 unit + 209 integration + deploy suites) passed with no regression, and
  the accepted F1/F2/JWT/VPN protections are intact.

## To obtain final sign-off

Run this exact procedure on a validation server that has **Docker registry egress,
a real IPv6 stack, and a real browser**, against the unmodified repo at `dc74d9f`:
build the exact `node:20-alpine`/`postgres:16-alpine`/`redis:7-alpine` images, start
`deploy/docker-compose.production.yml`, run the shipped Nginx with real TLS, then
execute §23–§58 (two-client proxy path, in-container privilege checks, Multi-VPN +
rollback with the exact `vpn-helper` image and external clients, real-IPv6 SSRF,
browser token-storage/logout/CSP, induced audit-persistence failure,
restart/recovery). On all evidence obtainable here the build is a strong candidate
with no regressions; **final production sign-off requires the exact-production-runtime
environment this sandbox cannot provide.**
