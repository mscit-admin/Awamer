# FINAL Exact-Production-Runtime Validation Report
**Awamer / NetSphere Terminal** — validation only, **no code changes** (tree clean at `1330f29`).

This round's authority is **exact production runtime evidence**, not unit tests or
prior remediation reports. The build was NOT modified. The task's own rules
(§1, §25, §28, §31) govern the verdict.

---

## Environment capability check (§1) — the deciding factor

Three **mandatory** capabilities are **unavailable in this sandbox**, verified with
fresh evidence this session:

| Mandatory capability | Status | Evidence |
| --- | --- | --- |
| Docker registry egress (to build the EXACT production images) | **UNAVAILABLE** | `docker pull node:20-alpine` / `postgres:16-alpine` / `redis:7-alpine` → **HTTP 403 Forbidden**; `docker build -f backend/Dockerfile` fails at `FROM node:20-alpine` (`failed to resolve … Forbidden`) |
| Real IPv6 stack | **UNAVAILABLE** | no `inet6` addresses; `socket(AF_INET6)` → `OSError 97 Address family not supported` |
| Real browser against the exact production HTTPS frontend | **UNAVAILABLE** | no standalone browser; the exact production frontend/nginx stack cannot be built (depends on the blocked images) |

Per **§1**: *"If any mandatory capability is unavailable → PRODUCTION APPROVAL NOT
VERIFIED."* Per **§28**: mandatory runtime tests **may not** be marked PASS using an
alternative Docker image, host-only backend, fake Nginx, IPv4-instead-of-IPv6, or an
HTTP client instead of a browser. Therefore the exact-production-runtime gates below
that require these capabilities are **NOT VERIFIED** — not PASS, not FAIL.

This is a limitation of the **validation environment**, not a discovered defect in
the build. No new vulnerability was found.

---

## Summary table

| Security Gate | PASS | FAIL | NOT VERIFIED |
| --- | ---: | ---: | ---: |
| Exact production images | | | ✔ (registry 403) |
| Production Compose | | | ✔ (depends on images) |
| Production Nginx | | | ✔ runtime through exact stack (config `nginx -t`-valid statically) |
| Proxy/Docker client IP | | | ✔ exact image (behaviourally shown w/ local image; unit/integration PASS) |
| Rate limiting | | | ✔ exact stack (executed unit/integration PASS) |
| Audit IP | | | ✔ exact stack (behaviourally shown w/ local image) |
| IPv6 SSRF | | | ✔ runtime IPv6 (unit SSRF-IPV6-001..012 PASS) |
| Browser security | | | ✔ (no exact HTTPS frontend / browser) |
| Tenant isolation | ✔ executed (real PG) | | ✔ exact-Docker overlay |
| JWT | ✔ executed (JWT-ALG-001..006 + prior live) | | |
| Session invalidation | ✔ executed (AUTH-INVALIDATE + WS, real PG) | | ✔ exact-Docker overlay |
| VPN privilege isolation | | | ✔ exact image (shown w/ local image) |
| Multi-VPN | | | ✔ exact image (shown w/ local image, prior 27/0) |
| VPN rollback | | | ✔ exact image (shown w/ local image, prior 18/0) |
| Malicious uploads | | | ✔ (not runtime-tested against exact stack) |
| Audit durability (§24 induced failure) | | | ✔ (not run against exact stack) |
| Restart/recovery | | | ✔ exact stack (behaviourally shown w/ local image) |
| Dependencies | ✔ (audit executed + recorded) | | |

(A "✔ exact image / exact stack" in NOT VERIFIED means the control has strong
executed evidence at the code/local-image level, but the **exact-production-image**
runtime the task mandates was not reproducible here.)

---

## What WAS executed this session (real, not mocks)

- **Exact-image build attempt** (§2): `docker build -f backend/Dockerfile` → fails at
  `FROM node:20-alpine` with registry `403 Forbidden`. Captured verbatim.
- **Regression suites (§27), all green:**
  - Backend unit **263 / 0 / 0** (pass/fail/skip) — includes JWT-ALG-001..006,
    PROXY-TRUST/RATELIMIT/AUDIT/CONFIG, AI-SSRF + SSRF-IPV6-001..012.
  - Backend integration **209 / 0 / 0** against **real PostgreSQL 16** — includes
    AUTH-INVALIDATE(+WS), MFA-CRYPT, MFA-STEPUP, tenantIsolation/NullScope/Shares,
    rbacRoles/moveRbac, netCidr/netScope, helperIpc, vpnServerPorts, migration integrity.
  - Desktop vitest **23 / 0**.
  - Deploy: `proxy-deploy` **11/0**, `proxy-trust-upgrade` **6/0**, `vpn-deploy` **11/0**,
    `evidence` **31/0**.
- **Dependency audit (§26), recorded, no `npm audit fix`:**
  - Backend: 0 critical / **4 high** / 2 moderate / 1 low (deps: `@fastify/static`
    — reachable only if `ENABLE_API_DOCS=true`, off by default —, `fast-uri`,
    `js-yaml`, `fastify`, `nodemailer`, `esbuild`).
  - Desktop: **1 critical** (`vitest`/`@vitest/mocker`) / **4 high** (`vite`,
    `browserslist`, `js-yaml`, `nanoid`) — **all dev/build-time**, none shipped in the
    built SPA/Tauri artifact.
  - **`@xmldom/xmldom` v0.8.15 present (transitive via kdbxweb) but NOT flagged by
    `npm audit`** → the prior @xmldom critical **remains resolved** (§26). ✔
- **App defaults intact (no regression):** `TRUST_PROXY` default `loopback`,
  `trustProxy: cfg.trustProxy` (never `true`/`uniquelocal`); JWT `algorithms:["HS256"]`
  present on all verify paths; SSRF IPv6/mapped/redirect guards present.

## Behavioural evidence from earlier this branch (local image — NOT the exact prod image)

Recorded honestly as **NOT** exact-production-image evidence, but demonstrating the
behaviour the exact gates would confirm: PROXY-DEPLOY real Docker-topology runtime
**7/0** (two netns clients distinguished, not the gateway; forged/rotated XFF blocked;
audit IP = real client; backend loopback-only), Multi-VPN runtime **27/0**, FW+rollback
runtime **18/0**, live DB-outage fail-closed. All used `aw-runtime:local` (host rootfs)
because `node:20-alpine` is egress-blocked; the Docker-NAT / OpenVPN / iptables
behaviour is image-independent, but this does **not** satisfy §28's exact-image
requirement.

---

## Findings

No new vulnerability was discovered in this round. Standing dependency findings
(recorded, not fixed per the rules; carried from the penetration report):

- **P3** — dependency advisories (backend 4 high/2 mod/1 low; desktop 1 crit/4 high
  **dev-only**). Exploitability in the shipped artifact is low/none (`@fastify/static`
  gated off by default; desktop crit/high are test/build tooling not shipped). Recommend
  a scheduled `npm audit` remediation in a normal maintenance change (out of scope here).

```
Confirmed P0: 0
Confirmed P1: 0
Confirmed P2: 0 (new)
Confirmed P3: dependency advisories (record-only; see above)

Mandatory FAIL: 0
Mandatory SKIP: 0
Mandatory NOT VERIFIED: exact production images; production compose; production
  Nginx runtime; proxy/Docker client-IP (exact image); rate limiting (exact stack);
  audit IP (exact stack); IPv6 SSRF runtime; browser security; VPN privilege isolation
  (exact image); Multi-VPN (exact image); VPN rollback (exact image); malicious
  uploads; audit durability (§24); restart/recovery (exact stack).

FINAL DECISION: PRODUCTION APPROVAL NOT VERIFIED
```

---

## Why NOT VERIFIED (not APPROVED, not NOT-APPROVED)

- **Not APPROVED** — §31 requires `NOT VERIFIED = 0` and all mandatory runtime tests
  PASS. The exact-production-runtime environment (registry egress for `node:20-alpine`
  et al., a real IPv6 stack, and a real browser against the exact HTTPS frontend) is
  **unavailable in this sandbox**, so those gates cannot be honestly marked PASS.
- **Not NOT-APPROVED** — no confirmed **P0/P1** blocker was found; every control that
  *could* be exercised here (263 unit + 209 integration + deploy suites) passed, and
  the accepted F1/F2/JWT/VPN protections show no regression.

## To close this out (what a qualifying environment must run)

Run this exact validation on a host with **Docker Hub/registry egress, IPv6, and a
real browser**, using the unmodified repo at `1330f29`:
1. `docker compose -f deploy/docker-compose.production.yml … build` (exact
   `node:20-alpine` images) + `up -d`; record image digests; `nginx -t` + run the
   shipped production Nginx.
2. §5–§8 two real clients through Nginx→Docker→exact auth-service container (client-IP,
   XFF rotation, audit IP); §9/§10 in-container `/proc/1/status` privilege checks.
3. §11/§12 Multi-VPN + rollback with the exact `vpn-helper` image and external clients.
4. §13–§16 IPv6 / mapped-IPv6 / mixed-DNS / redirect SSRF on a real IPv6 network.
5. §17–§19 real browser: token storage, logout revocation, browser-enforced CSP/HSTS.
6. §20 malicious uploads, §21 cross-tenant matrix, §22 JWT, §23 session invalidation,
   §24 induced audit-persistence failure, §25 restart/recovery — all against the exact
   running stack.

The build is a strong candidate on all executed evidence; **final production sign-off
requires the exact-production-runtime environment this sandbox cannot provide.**
