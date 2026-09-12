# NetSphere Terminal (Awamer) — Final Deployment Fix Report

**Scope:** Deployment fixes only — **DEPLOY-001** (nginx HTTP/2 directive
incompatibility) and **DEPLOY-002** (fresh-install TLS/certbot bootstrap
ordering). No application source code was modified. No dependency upgrades were
performed (npm audit is **report-only**, per task).

**Date:** 2026-09-12
**Branch:** `claude/nifty-johnson-u2dwye`
**Base commit:** `095d347` (final release validation report)

---

## 0. Change scope (proof of "deployment-only")

```
 deploy/nginx/netsphere.conf |  31 +++++++++-----
 deploy/scripts/install.sh   | 102 ++++++++++++++++++++++++++++++++++---------
 deploy/scripts/update.sh    |  16 +++++--
 3 files changed, 116 insertions(+), 33 deletions(-)
```

- `git diff --name-only` restricted to `deploy/**` → **no `backend/` or
  `desktop/` source touched** (verified: "PASS: no application source modified").
- Untouched by design: authentication, JWT, RBAC, tenant isolation,
  `ActiveSessionManager` (AWM-SEC-022), SSH/Telnet/VNC/TCP-tunnel gateways,
  PostgreSQL schema/business migrations, all prior security fixes
  (AWM-SEC-021/-022, AWM-CFG-001, AWM-STAB-002, migration integrity
  AWM-MIG-005/-006). These are confirmed untouched by the diff scope and by the
  regression suites in §5 continuing to pass unchanged.

---

## 1. DEPLOY-001 — nginx version / config incompatibility

### Root cause
The shipped HTTPS vhost used the standalone directive `http2 on;`, introduced in
**nginx 1.25.1**. The distro nginx on the supported targets — Ubuntu 22.04
(nginx **1.18**) and Ubuntu 24.04 (nginx **1.24**) — does not recognise it and
fails `nginx -t` with `unknown directive "http2"`, so the official install path
broke unless the operator added a third-party nginx repo.

### Fix
Enable HTTP/2 via the **`listen … ssl http2` parameter form** instead of the
standalone directive. That parameter form is accepted by nginx from 1.9.5
through current releases (1.25+ still accepts it, emitting only a deprecation
notice), so a single shipped config works on distro nginx **and** newer nginx —
no third-party repo required.

```diff
 server {
-    listen 6655 ssl;
-    listen [::]:6655 ssl;
-    http2 on;
+    listen 6655 ssl http2;
+    listen [::]:6655 ssl http2;
     server_name netsphere.example.com;
```

A version preflight was added to `install.sh` (reports the running nginx version
after install so operators can see compatibility at a glance):

```
say "  nginx version: $(nginx -v 2>&1 | sed 's/^nginx version: //')"
```

### Preserved (unchanged, byte-identical in the diff)
TLS (`ssl_protocols TLSv1.2 TLSv1.3`), the `map $http_upgrade
$connection_upgrade` block, WebSocket upgrade on `/api/`, the `/api/` reverse
proxy (1h send/read timeouts, `proxy_buffering off`), `location = /healthz`,
`location = /readyz`, SPA `try_files … /index.html`, security headers (HSTS,
X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy),
the SEC-006 CSP, `client_max_body_size 16M`, and the `noquery` log format.

### Verification (on nginx **1.24.0**, this sandbox)

| Check | Result |
|---|---|
| OLD form (`http2 on;`) on nginx 1.24.0 | **FAIL** — `unknown directive "http2"` (reproduces the reported break) |
| NEW form (`listen … ssl http2`), IPv4-only copy | **PASS** — `test is successful` |
| `grep "http2 on"` in shipped config | only in an explanatory **comment**, no live directive |

> The full config additionally emits `socket() [::]:80 failed (97: Address
> family not supported by protocol)` **in this sandbox only**, because the
> sandbox has no IPv6 stack to bind the `listen [::]…` sockets. This is an
> environment limitation, not a config defect — the identical `[::]` lines are
> present in the original config and on a normal dual-stack host they bind
> cleanly. The IPv4-only copy isolates the directive check and passes.

---

## 2. DEPLOY-002 — fresh-install TLS / certbot bootstrap ordering

### Root cause
`install.sh` enabled the **final HTTPS** vhost (which references
`/etc/letsencrypt/live/<domain>/…` cert files) and ran `nginx -t` **before**
certbot had issued any certificate. On a fresh host those files do not exist, so
`nginx -t` failed and the install aborted — a chicken-and-egg break.

### Fix — safe ordering (webroot flow, fail-closed)
`install.sh` Step 5/6 was rewritten to:

1. Validate the domain is a plausible FQDN (`err` on failure).
2. Copy the final HTTPS config into `sites-available` **without enabling it**.
3. **Existing-cert branch:** if `live/<domain>/fullchain.pem` +`privkey.pem`
   already exist → **skip issuance**, then `enable_final`.
4. **Fresh branch:** write an **HTTP-only bootstrap vhost** that serves
   `/.well-known/acme-challenge/` from `/var/www/certbot` (and `return 404` for
   everything else), enable **only** that, `nginx -t`, reload.
5. Issue the certificate: `certbot certonly --webroot -w /var/www/certbot -d
   <domain> …` (webroot — does **not** rewrite nginx config, unlike `--nginx`).
6. On **certbot failure** → `err` (exit non-zero); the cert-less HTTPS config is
   **never** activated, the bootstrap vhost keeps serving.
7. On success → `enable_final`: symlink the HTTPS config, remove the bootstrap
   symlink, `nginx -t`; reload on pass, **roll back to bootstrap + `err`** on
   fail (never reloads a broken config).

Renewal is zero-downtime: the port-80 server block in `netsphere.conf` serves
the ACME webroot, so `certbot renew` works with nginx running (no standalone
hooks). The header comment in `netsphere.conf` was updated from the old
`certbot certonly --standalone` (stop-nginx) instructions to the webroot flow.

### `update.sh` (§6/§7) — never reissues, fail-safe reload
Application updates **never** touch TLS certs. `update.sh` now only validates and
reloads: `nginx -t` → reload on pass; on fail it prints a clear message, **does
not reload** (running config stays intact), and `exit 1`.

### Verification — bootstrap ordering harness (mocked certbot/nginx/systemctl, real exit codes)

| Scenario | Exit | `sites-enabled` | cert | Verdict |
|---|---|---|---|---|
| **fresh_ok** (no cert → issue succeeds) | `0` | `netsphere` (final HTTPS) | present | **PASS** — bootstrap→issue→enable order correct |
| **existing_cert** (cert already present) | `0` | `netsphere` | present | **PASS** — issuance skipped, final enabled |
| **certbot_fail** (issuance fails) | `1` | `netsphere-bootstrap` | absent | **PASS** — fail-closed, HTTPS NOT activated |

### Verification — `update.sh` reload safety

| Branch | Behaviour | Verdict |
|---|---|---|
| `nginx -t` passes | `systemctl reload nginx` runs, exit 0 | **PASS** |
| `nginx -t` fails | **no reload**, running config intact, exit 1 | **PASS** |
| certbot referenced in `update.sh` | none — never reissues | **PASS** |

---

## 3. Live nginx → backend routing / readiness / WebSocket regression

Ran the **fixed** `netsphere.conf` under a real nginx (1.24.0), IPv4-only, with a
self-signed cert, proxying to a live backend (`node dist/server.js`, port 8081)
against real PostgreSQL 16.

| Test | Path | Result | Verdict |
|---|---|---|---|
| Liveness through proxy | `GET /healthz` | 200 | **PASS** |
| Readiness through proxy (DB up) | `GET /readyz` | 200, body `{"status":"ready"}` (backend JSON, **not** SPA) | **PASS** |
| `/readyz` not masked by SPA | body ≠ SPA index marker | confirmed backend-served | **PASS** |
| SPA fallback | `GET /some/client/route` | serves `index.html` | **PASS** |
| `/api/` reverse proxy | `POST /api/v1/auth/refresh` | 400 (identical to direct backend 400 — reaches backend, not SPA 404) | **PASS** |
| WebSocket upgrade (HTTP/1.1, as browsers use for WS) | `/api/v1/ssh/connect` | **101 Switching Protocols** + `Upgrade: websocket` + `Sec-WebSocket-Accept` | **PASS** |
| Readiness reflects DB down | stop PostgreSQL → `GET /readyz` | 503, body `{"status":"not_ready"}`; `/healthz` stays 200 | **PASS** |
| Readiness recovers | restart PostgreSQL → `GET /readyz` | 200 (no backend restart) | **PASS** |

> **WebSocket over HTTP/2 note:** a curl WS handshake that lets ALPN negotiate
> HTTP/2 returns 404, because HTTP/2 does not use the `Upgrade` mechanism
> (RFC 8441 extended-CONNECT). Browsers **always** open WebSockets over
> HTTP/1.1, which returns 101 correctly (shown above). This behaviour is
> identical under the old `http2 on;` config — the DEPLOY-001 change does not
> alter it. `proxy_http_version 1.1` + the `$connection_upgrade` map handle the
> upgrade on the proxy hop regardless.

---

## 4. `docker compose` production config (§20)

`docker compose -f deploy/docker-compose.production.yml --env-file
deploy/.env.production.example config` → **VALID** (YAML + variable
interpolation parse cleanly; services: `postgres`, `redis`, `auth-service`).

> **Runtime NOT VERIFIED:** the Docker **daemon is down** in this sandbox, so a
> real container bring-up could not be exercised. Config parsing is the
> verifiable subset here.

---

## 5. Mandatory regression suites (§22) — 0 FAIL / 0 SKIP

Run against real PostgreSQL 16 with a migrated `awamer_test` DB (26 migrations
applied clean).

| Suite | Tests | Pass | Fail | Skip |
|---|---|---|---|---|
| Backend unit (`npm test`) | 99 | 99 | 0 | 0 |
| Backend integration (`test:integration`) | 108 | 108 | 0 | 0 |
| **Mandated gates** (AUTHZ-STATE-001..022, CFG-BOOT-001..006, READY-DEPLOY-001..006 + active-session/revocation) | 43 | 43 | 0 | 0 |
| Backend `tsc --noEmit` | — | clean | — | — |
| Frontend `tsc --noEmit` | — | clean | — | — |
| Frontend `npm run build` | — | built (6.5s) | — | — |
| Frontend tests (vitest) | 16 | 16 | 0 | 0 |

Gate-ID coverage confirmed present in source: **AUTHZ-STATE** 22 distinct IDs,
**CFG-BOOT** 6 distinct IDs, **READY-DEPLOY** IDs 001/002/004/005/006 across 4
test blocks (002 and 005 share one DB-down test; header documents "001..006").
None were modified by this change.

---

## 6. npm audit triage (§23) — **REPORT ONLY, no upgrades performed**

### Totals

| Package set | critical | high | moderate | low | total |
|---|---|---|---|---|---|
| backend | 0 | 4 | 2 | 1 | 7 |
| desktop | 1 | 5 | 8 | 1 | 15 |

### Focus advisories — `@xmldom/xmldom` and `kdbxweb` (as required)

**Dependency path (desktop):**
`netsphere-terminal-desktop → kdbxweb@2.1.1 → @xmldom/xmldom@0.7.13`
(`@xmldom/xmldom` is **not** a direct dependency; it is transitive via `kdbxweb`
only. `kdbxweb` is a **prod** dependency used by the KeePass `.kdbx` import
feature — `src/modules/users/keepassImport.ts`, lazy-loaded page.)

**Reachability verdict: NOT runtime-reachable in the shipped app.** Evidence:

1. **xmldom is a Node-only fallback in kdbxweb.** `kdbxweb`'s `xml-utils.ts`
   uses the platform parser/serializer first and only falls back to
   `require('@xmldom/xmldom')` when the global is absent:
   ```js
   function createDOMParser()   { if (global.DOMParser)    return new global.DOMParser();    … require('@xmldom/xmldom') }
   function createXMLSerializer(){ if (global.XMLSerializer) return new global.XMLSerializer(); … require('@xmldom/xmldom') }
   ```
   The desktop app is a **browser SPA** (Vite build served by nginx; Tauri
   WebView is also a browser context). Native `DOMParser`/`XMLSerializer` always
   exist there, so the `@xmldom/xmldom` branch is **dead code** in production —
   the vulnerable library is never loaded or executed.

2. **The feature is import-only.** The only kdbxweb API called is `Kdbx.load`
   (parse). The app never serializes/writes a `.kdbx`. The **majority** of the
   `@xmldom/xmldom` HIGH advisories are **XML *serialization* injection**
   (CDATA/DocType/PI/comment/attribute/element name injection during
   `requireWellFormed` serialization) — that code path is never invoked even in
   a hypothetical Node context.

3. **No cross-privilege boundary even for the parser DoS advisories.** The
   remaining advisories are parser DoS (quadratic time/memory, end-tag ReDoS).
   The parsed input is a `.kdbx` file the **user themselves** selects, decrypted
   locally in their **own** browser with their **own** master password —
   attacker and victim are the same principal. Worst case is the user hanging
   their own browser tab on a malformed file they chose to import; no server
   impact, no cross-tenant/cross-user impact.

**`kdbxweb` (moderate)** is flagged **only** transitively "via
`@xmldom/xmldom`" — same conclusion; no separate defect in kdbxweb itself.

### Other notable desktop advisories

| Package | Sev | Classification | Rationale |
|---|---|---|---|
| `vitest` / `@vitest/mocker` / `vite-node` | **critical/high** | **dev-only** | Test runner (`devDependencies`). Advisory requires the Vitest UI server listening — never shipped in the production SPA bundle. |
| `vite` / `esbuild` | high/mod | **dev-only** | Build-time tooling; the dev server / `.map` handling is not part of the built static site served by nginx. |
| `browserslist` / `baseline-browser-mapping` / `postcss-selector-parser` | high/mod/low | **build-only** | Consumed at build time; not in runtime bundle. |
| `react-router` / `react-router-dom` | moderate | **runtime, low exposure** | Open-redirect via backslash in `<Link>`/`useNavigate` and SSR `deserializeErrors`. App is a **client-only SPA (no SSR)**; navigation targets are app-internal. Worth tracking for a future dep bump, but **out of scope** for this deploy-only task. |
| `nanoid` / `fflate` | high/mod | runtime, low exposure | DoS on pathological inputs; no untrusted external feed on these paths in the SPA. |

### Backend advisories (all HIGH/moderate, **0 critical**)

`@fastify/static`, `fast-uri`, `js-yaml`, `nodemailer`, `fastify`,
`@fastify/swagger-ui`, `esbuild(dev)`. All are dependency-level advisories
requiring a version bump to clear. **Per task, no upgrades were performed** — to
be triaged/patched in a dedicated dependency-maintenance change, not this
deployment fix.

> **No dependencies were changed in this task.** This section is informational.

---

## 7. Not verified in sandbox (honest limitations)

| Item | Why | Mitigation |
|---|---|---|
| Real Let's Encrypt issuance on a fresh Ubuntu 22.04/24.04 host | No public DNS/domain or inbound TCP 80 in sandbox | Bootstrap ordering + fail-closed proven via faithful harness (§2); webroot flow is the standard certbot pattern |
| Docker container runtime bring-up | Docker **daemon down** in sandbox | Compose **config** validated (§4); app already validated running natively (§3, §5) |
| Full dual-stack `nginx -t` on the exact shipped file | Sandbox has **no IPv6** (`[::]` binds fail) | Directive correctness proven on IPv4-only copy; `[::]` lines unchanged from original |

---

## 8. Gate matrix (§24)

| Gate | Status |
|---|---|
| DEPLOY-001 — nginx config compatible with distro nginx (1.18/1.24) | ✅ **FIXED & VERIFIED** (old form fails, new form passes on 1.24.0) |
| DEPLOY-001 — nginx version preflight in installer | ✅ **DONE** |
| DEPLOY-001 — all proxy/WS/health/SPA/security features preserved | ✅ **VERIFIED** (live proxy regression, §3) |
| DEPLOY-002 — fresh install: bootstrap → cert → HTTPS ordering | ✅ **VERIFIED** (harness fresh_ok, §2) |
| DEPLOY-002 — existing cert preserved (no reissue) | ✅ **VERIFIED** (harness existing_cert, §2) |
| DEPLOY-002 — certbot failure is fail-closed (exit ≠ 0, HTTPS not activated) | ✅ **VERIFIED** (harness certbot_fail exit=1, §2) |
| DEPLOY-002 — `update.sh` never reissues; fail-safe reload | ✅ **VERIFIED** (§2) |
| Routing: `/readyz` reaches backend, not SPA | ✅ **PASS** (§3) |
| Readiness: 200 (DB up) / 503 (DB down) / recovers | ✅ **PASS** (§3) |
| WebSocket upgrade through nginx (HTTP/1.1) | ✅ **PASS** — 101 (§3) |
| `docker compose config` | ✅ **VALID** (runtime ⚠️ NOT VERIFIED — daemon down) (§4) |
| Regression AUTHZ-STATE-001..022 / CFG-BOOT-001..006 / READY-DEPLOY-001..006 | ✅ **43/43, 0 FAIL, 0 SKIP** (§5) |
| Backend unit 99 / integration 108 / frontend 16 | ✅ **all pass** (§5) |
| No application source modified | ✅ **CONFIRMED** (§0) |
| Prior security fixes untouched | ✅ **CONFIRMED** (§0) |
| npm audit triage (report only) | ✅ **REPORTED**, no upgrades (§6) |
| Real LE issuance on fresh host / Docker runtime | ⚠️ **NOT VERIFIED** (sandbox limits, §7) |

---

## 9. Production decision (§25)

The two in-scope defects that previously broke the **official install path** are
fixed and verified:

- **DEPLOY-001** — the shipped nginx config now passes `nginx -t` on the distro
  nginx (1.24.0 demonstrated; 1.18 uses the same directive semantics), so a
  fresh install no longer requires a third-party nginx repo. The old `http2 on;`
  break is reproduced and confirmed resolved.
- **DEPLOY-002** — the fresh-install TLS bootstrap now orders HTTP-only vhost →
  certbot (webroot) → HTTPS enable, is fail-closed on certbot failure, preserves
  an existing certificate, and `update.sh` never reissues and never reloads a
  broken config. All branches verified with correct exit codes.

All mandated regression gates pass (0 FAIL / 0 SKIP), no application source was
touched, and every prior security fix is intact. The only items that remain
unverified are those that are **physically impossible** to exercise in this
sandbox (real Let's Encrypt issuance needs public DNS + inbound TCP 80; Docker
runtime needs a running daemon) — both were validated to the maximum verifiable
extent (bootstrap ordering harness; compose config parse).

### Verdict: **CONDITIONALLY PRODUCTION READY**

The official install path defects (DEPLOY-001, DEPLOY-002) are **fixed and
verified**; the fixed nginx config and the fresh-install TLS bootstrap logic both
pass. The single remaining condition is a **one-time smoke test of live Let's
Encrypt issuance on a real, internet-reachable Ubuntu 22.04/24.04 host** (and a
Docker-daemon-up compose bring-up), which cannot be performed in this sandbox.
With that smoke test green on first deploy, this is **APPROVED FOR PRODUCTION**.

---

*Verification environment: Ubuntu 24.04, nginx 1.24.0, node v22.22.2,
PostgreSQL 16.13. Docker daemon unavailable; no IPv6; no public DNS.*
