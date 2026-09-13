# FINAL Production Penetration & Adversarial Security Report
**Awamer / NetSphere Terminal**

Validation-only adversarial acceptance test. **No source code was modified**
(`git status` clean at test time). Findings were recorded, proven safely, and
classified; nothing was fixed. Controls were reproduced independently rather than
trusted from prior remediation reports.

---

## Executive Summary

The build was exercised with a **clean install + build + full test suites**, a
**live backend running in production mode** for direct attack (auth, JWT, SSRF,
trust-proxy, password reset, headers, error handling, DB-outage), a **real OpenVPN
+ real iptables runtime** (multi-server, firewall ownership, adversarial rollback),
and a **static security search**. Real PostgreSQL, real OpenVPN, real iptables, real
Node were used.

**Two MEDIUM (P2) findings** were confirmed. **No P0/P1** were found. Several
**mandatory runtime tests cannot be executed in this sandbox** because the egress
policy blocks the Docker registry and Alpine CDN (`403 Forbidden`), so the exact
production Alpine image stack (`postgres:16-alpine`, `redis:7-alpine`,
`node:20-alpine`) and the production **nginx** container cannot be built/run here.
Per the report's own rule (§47/§48), those are marked **NOT VERIFIED**, never PASS.

**FINAL DECISION: PRODUCTION APPROVAL NOT VERIFIED** — no confirmed P0/P1, but
mandatory production-stack runtime validation (real nginx / real Alpine images /
in-browser storage / IPv6 SSRF reach) could not be completed in this environment,
and two P2 findings remain to remediate.

---

## Environment / Build Identification

| Item | Value |
| --- | --- |
| Git commit | `70a3b7c72d8bcec5d5673e99e3e4d3859b557546` (clean tree) |
| OS | Ubuntu 24.04.4 LTS |
| Kernel | Linux 6.18.44-fc-v24 x86_64 |
| Docker | 29.3.1 |
| Docker Compose | v5.1.1 |
| Node | v22.22.2 (host dev); production image targets node:20-alpine |
| npm | 10.9.7 |
| PostgreSQL | 16.13 (real, used) |
| OpenVPN | 2.6.19 (real, used) |
| iptables | v1.8.10 (nf_tables) (real, used) |
| Nginx | 1.24.0 (host binary; production **container** NOT runnable — see limits) |

**Environmental limitation (affects verdict):** outbound egress allows only package
registries (npm/pypi/crates/go) + Anthropic APIs. Docker Hub and the Alpine CDN
return `403`, so `docker pull node:20-alpine|postgres:16-alpine|redis:7-alpine` and
`docker build -f Dockerfile.vpn-helper` (base pull) all fail. The full production
`docker-compose.production.yml` stack and the production nginx container therefore
**cannot be instantiated here**. Runnable substitutes were used where they preserve
the security property under test (real backend from source, real PG/redis, real
OpenVPN + iptables, a container with the **exact** production security profile).

---

## Methodology

1. Clean `npm ci` + `npm audit` (record only, **no `audit fix`**) + build + tests, backend & desktop.
2. Live backend in `NODE_ENV=production` (`127.0.0.1:18081`) driven with `curl`/Node for direct attack.
3. Real-runtime OpenVPN + iptables suites (helper container, exact security profile; external clients in separate netns).
4. Direct exercise of shipped guard code (`safeFetch`, JWT verify) on adversarial inputs.
5. Re-executed the project's integration suite (209 tests, real PG) as evidence for controls whose assertions I re-ran (not trusted from reports).
6. Static security search + manual review of every security-relevant sink.

---

## Summary table

| Area | PASS | FAIL | NOT VERIFIED |
| --- | ---: | ---: | ---: |
| Authentication | ✔ (live: invalid/enumeration/SQLi/rate-limit) | — | — |
| Session/JWT | ✔ (live: none/wrong-key/tamper/refresh-as-access; AUTH-INVALIDATE 001–015/WS) | — | — |
| Tenant isolation | ✔ (tenantIsolation/NullScope/Shares itests) | — | — |
| RBAC | ✔ (rbacRoles/moveRbac/roleService itests) | — | — |
| MFA | ✔ (MFA-CRYPT 001–008 encryption+fail-closed; live DB) | — | — |
| Password reset | ✔ (live: host/XFH ignored; trusted base URL only) | — | — |
| IDOR/BOLA | ✔ (tenantIsolation itests; ownership-scoped repo queries) | — | cross-tenant *live* multi-company matrix |
| Injection (SQL/cmd) | ✔ (live SQLi on login; static + netCidr; helper arg-arrays) | — | — |
| SSRF | ✔ (literal/private/metadata/encoded blocked live) | 1 P2 (IPv6-literal bypass) | end-to-end IPv6 reach |
| Network diagnostics | ✔ (fail-closed allowlist; resolved-IP; netCidr/netScope) | — | — |
| VPN privilege isolation | ✔ (live: backend CapEff=0/uid 10001/no tun; helper NET_ADMIN-only) | — | — |
| Multi-VPN | ✔ (live: 3 servers 20001u/20002u/20003t + external clients) | — | — |
| Firewall | ✔ (live: per-server ownership tags; only own rule removed) | — | — |
| VPN rollback | ✔ (live: failed 20001→20005 restored; client reconnected) | — | — |
| Secrets | ✔ (app logs clean; MFA/certs sealed) | — | Docker/nginx/support-bundle logs |
| Deployment | ✔ (bootstrap rejects weak pw; compose contract tests) | — | real nginx headers/CORS; prod Alpine stack |
| Recovery | ✔ (DB outage fail-closed; VPN restart no secret rotation) | — | full-stack restart (prod images) |
| Audit | ✔ (audit events for auth/role/VPN/firewall via itests) | — | audit-persistence-failure fail-closed *live* |

---

## Findings

### F1 — Rate-limit bypass & audit-IP spoofing via X-Forwarded-For (trustProxy) — **P2 MEDIUM**
- **Where:** `backend/src/server.ts:196` `trustProxy: true`; rate-limit `keyGenerator: req => req.ip` (`server.ts:220`); `deploy/nginx/netsphere.conf:133` `X-Forwarded-For $proxy_add_x_forwarded_for` (append).
- **Attack (live, reproduced):** 12 login attempts with `X-Forwarded-For: 1.1.1.1` → `429`; switching to `2.2.2.2` / `3.3.3.3` → `401` (fresh bucket each). Because nginx *appends* the client XFF and Fastify `trustProxy:true` takes the **leftmost** (attacker) value, `req.ip` is attacker-controlled through the production ingress.
- **Impact:** the IP-based login/auth rate limiter can be bypassed by rotating XFF (aids credential stuffing across many usernames), and audit-log/`ipAddress` identity is forgeable. **Mitigated** by per-account lockout (`failed_attempts` + `locked_until`, observed locking `admin` at 5 attempts), which still throttles single-account brute force regardless of IP.
- **Not** a direct auth bypass (still requires valid credentials; per-account lockout independent of IP).
- **Remediation:** set `trustProxy` to a fixed hop count (`1`) or the nginx IP/subnet so Fastify uses the real client address, not the client-supplied leftmost XFF.

### F2 — SSRF IP-filter bypass via bracketed IPv6 literals — **P2 MEDIUM** (could be P1 on IPv6-enabled hosts)
- **Where:** `backend/src/ai/safeFetch.ts` `assertSafeUrl` uses `isIP(u.hostname)`; for a bracketed IPv6 URL `u.hostname` is `[::1]` / `[::ffff:7f00:1]` (brackets), so `isIP` returns 0 and the literal-IP block (`isBlockedIp`) is skipped. The connect-time pinned `lookup` is **not called by Node for IP literals**, so the guard is bypassed for IPv6-literal destinations.
- **Attack (reproduced):** via the shipped `safeFetch`, `http://127.0.0.1:PORT` → `SsrfError` (blocked), but `http://[::1]:PORT`, `http://[::ffff:127.0.0.1]:PORT` raised **no `SsrfError`** — they attempted a direct connect and only failed with `EAFNOSUPPORT` because **this sandbox has no IPv6 stack**. On a host with IPv6 (common in production), `https://[::1]/` or `https://[::ffff:<internal-ipv4>]/` (Linux maps `::ffff:` to IPv4) would reach the target, bypassing the loopback/private IP allowlist.
- **Reach requires:** an authenticated user with AI-provider-config rights (`ai:manage` or `ai:use_personal`) setting the provider `base_url`. Production policy is `allowHttp:false` (https-only) + Node TLS validation, so practical impact is **blind SSRF / internal TCP probing over HTTPS** (data return needs a TLS service with a valid cert). HTTP-only targets (e.g. cloud metadata `169.254.169.254`) are blocked by the https-only scheme.
- **NOT VERIFIED:** end-to-end retrieval from a live internal service — no IPv6 stack in this sandbox. The **filter bypass itself is confirmed** (guard does not fire).
- **Remediation:** in `assertSafeUrl`, strip brackets before `isIP`, and reject IPv6 literals (or run them through `isBlockedIp`); do not rely on the pinned `lookup` for literals.

### F3 — Dependency vulnerabilities (npm audit) — **P3 LOW** (record-only; no fix per instructions)
- **Backend:** 7 (0 critical / **4 high** / 2 moderate / 1 low): `@fastify/static` (path auth-bypass — **only reachable if `ENABLE_API_DOCS=true`, which is off by default**), `fast-uri`, `js-yaml`, `fastify` (schema coercion), `nodemailer` (IDN/ReDoS/file-access — used only for templated reset mail to validated addresses), `esbuild` (dev).
- **Desktop:** 13 (**1 critical**/4 high) — all **dev/build-time only** (`vitest`/`@vitest/mocker`, `vite`, `browserslist`, `js-yaml`, `nanoid`); none ship in the built SPA/Tauri artifact.
- **§43 regression:** `@xmldom/xmldom` is **no longer a dependency**; `kdbxweb` (runtime) carries no current advisory → prior kdbxweb/@xmldom issue **remains resolved**.

### F4 — JWT verify has no explicit `algorithms` allowlist — **P3 LOW (hardening / not exploitable)**
- `jwtVerify(token, key, { issuer })` relies on jose's symmetric-key handling to reject `none`/asymmetric. Live tests confirmed `alg=none`, wrong-secret, and payload-tamper all → 401, and alg-confusion is not possible with a symmetric key. Adding `algorithms:["HS256"]` is defense-in-depth only.

### F5 — No Content-Security-Policy at the API layer — **P3 LOW (informational)**
- API JSON responses set HSTS, `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: no-referrer`, and leak no `X-Powered-By`. CSP for the served SPA would be nginx's responsibility — **NOT VERIFIED** (production nginx container not runnable here).

---

## Section evidence (condensed)

- **§2 Build/audit:** backend unit **230/0**, integration **209/0** (real PG); desktop build OK, vitest **23/0**. Audit recorded (F3); no `audit fix` run.
- **§3 Migrations:** fresh DB → migration 028 applied cleanly (live); unique(port,proto) index present; roleMigration/roleKeyLength/migrate itests executed.
- **§4 Auth:** wrong password and unknown user → identical `invalid_credentials` (no enumeration); login usecase does a `dummyHashCheck` to equalize timing; rate limiter fires ("Rate limit exceeded"); SQLi payloads on username → `invalid_credentials`, `users` table intact.
- **§5/§6 Stolen token / revocation:** AUTH-INVALIDATE-001..015 + WS-001..010 + VNC and AUTHZ-STATE-001..022 executed — old access token rejected after password/reset/MFA/role/company change across HTTP + SSH/Telnet/Tunnel/VNC; live SSH/Telnet gateways in itests.
- **§7/§8 Tenant / null-company:** tenantIsolation / tenantNullScope / tenantShares itests — ownership-scoped queries; null-company users get no global visibility.
- **§9/§10 IDOR / RBAC:** repo queries scoped by `user_id`/company; rbacRoles / moveRbac / roleService itests (escalation, cross-tenant role reuse, move-with-incompatible-role denied). *Live cross-company matrix NOT VERIFIED (single-tenant live instance).*
- **§11 Reset host poisoning:** live `forgot-password` with spoofed `Host`/`X-Forwarded-Host` → 200, no header influence; reset URL derives only from `resolveTrustedBaseUrl` (config), never request headers.
- **§12 MFA:** MFA-CRYPT-001..008 — TOTP seed AES-256-GCM sealed at rest, wrong-key/tamper/legacy-plaintext all fail closed.
- **§13 Step-up:** MFA-STEPUP-001..008 — sensitive ops need step-up; expired/reused/purpose-mismatch rejected; activation increments `auth_version`.
- **§14/§15 Injection:** live SQLi rejected; static search shows no `eval`/`new Function`; the only `spawn`s are the helper (fixed openvpn/iptables paths, arg arrays, `shell:false`) and network diagnostics (`ping`/`traceroute` fixed binaries, resolved-IP arg, no shell).
- **§16 SSRF:** literal loopback/private/link-local/metadata + decimal/hex/short-IP + `ftp:` all blocked live; connect-time pinned lookup rejects if ANY resolved address is unsafe (anti-rebinding). **F2** bypass for bracketed IPv6 literals.
- **§17 Network diagnostics:** fail-closed default allowlist; every resolved address validated; netCidr/netScope itests.
- **§18 Uploads:** *NOT independently exercised live this run* — relies on existing controls; marked NOT VERIFIED for the live upload matrix.
- **§19 VPN backend unprivileged:** live container — `uid=10001`, `CapEff=0000000000000000`, `/dev/net/tun` absent, `ip link add` → "Operation not permitted".
- **§20 VPN helper:** live — `CapEff=0x1000` (NET_ADMIN only), tun present, not privileged, socket-only control plane, `health` reports `firewallAvailable:true`; helperIpc itests (HMAC/replay/unknown-op/traversal).
- **§21 Multi-VPN:** live — VPN-A 20001/udp, VPN-B 20002/udp, VPN-C 20003/tcp up simultaneously; 3 external clients in separate netns got 10.8.1.2 / 10.8.2.2 / 10.8.3.2.
- **§22 Cross-server isolation:** by design — each server has its own CA + `verify-client-cert require`; `authVerify` queries `WHERE server_id=$1` so VPN-A creds/cert do not authenticate to VPN-B. *Live cross-connect not separately scripted → verified-by-architecture.*
- **§23/§24/§25 Collision/reserved/subnet:** vpnServerPorts itests (unique(port,proto), 20-way concurrency → 1 ok/19 conflict, reserved 22/80/443/8081/5432/6379 denied, subnet overlap rejected) + live collision (`vpn_port_in_use`, unrelated proc untouched).
- **§26/§28 Firewall abuse/ownership:** helper builds `iptables` args itself from validated {serverId,port,proto}; port-window + proto enforced; live — removing VPN-A deleted only its `awamer-vpn:<id>` rule; VPN-B rule and a manually-created non-Awamer rule survived.
- **§27 Rollback:** live — failed 20001→20005 change (new port squatted) rolled back: DB restored to 20001/udp, old firewall restored, new rule removed, old OpenVPN restarted, external client reconnected. Unit VPN-ROLLBACK-001..011 cover firewall-add/DB/OpenVPN-start/listener-health/old-cleanup + recovery_required.
- **§29 OpenVPN config injection:** INFRA-VPN-032 + assertSafeOvpnConfig (dangerous directives rejected; server config assembled from structured inputs, `--script-security` controlled).
- **§30 Path traversal:** helper session dirs keyed by validated ref; realpath escape check (INFRA-VPN traversal tests).
- **§31 Secrets:** live backend log — admin password 0 occurrences, access token 0 occurrences, no private keys; MFA/cert/tls sealed. *Docker/nginx/support-bundle logs NOT VERIFIED (no prod stack).*
- **§32 Browser storage:** refresh token stored in OS keyring; legacy `netsphere.refresh_token` localStorage entry purged on boot (`main.tsx` SEC-019A). *Live browser inspection NOT VERIFIED (no browser).*
- **§33 Headers:** app sets HSTS/nosniff/frame/referrer, no `X-Powered-By`. *Real nginx CSP/CORS NOT VERIFIED.*
- **§34 Trust proxy:** **F1** (XFF spoofable through nginx-append + trustProxy:true).
- **§35 Bootstrap admin:** live — production `loadConfig` **rejects** empty / `ChangeMe123` / `password` / short passwords (min 16 in prod).
- **§36 Readiness:** live — `/readyz` 200 (DB up) → 503 (DB down) → 200 (restarted); `/healthz` stays 200.
- **§37 DB outage:** live — during outage, login → 401 and authed request → 401 (fail closed; no permissive fallback).
- **§38 Redis outage:** the backend **does not use Redis** (rate-limit is in-memory; sessions are JWT+DB) → no auth/rate-limit/session dependency on Redis; no bypass possible. Intended degraded behavior documented.
- **§39 Restart/recovery:** live VPN — helper restart preserved `VPN_HELPER_SECRET` (unchanged), servers restart on same ports, no duplicate firewall rules; migration history stable. *Full prod-stack restart NOT VERIFIED.*
- **§40 Audit:** audit events asserted in itests (login failures, role change, company move, VPN create/port-change, firewall lifecycle, MFA/reset). *Live audit-persistence-failure fail-closed NOT VERIFIED this run.*
- **§41 Error disclosure:** malformed JSON → clean error code; bad path → `route not found`; no stack traces / paths / SQL.
- **§42 DoS (bounded):** login rate limiter enforced (429). Per-account lockout enforced.
- **§43 Dependencies:** see F3; kdbxweb/@xmldom resolved.
- **§44 Static search:** no `eval`/`new Function`/`shell:true`; `spawn` confined + structured; no localStorage auth material in the client.

---

## Findings & decision

```
Confirmed P0: none
Confirmed P1: none
Confirmed P2: 2
  - F1 rate-limit bypass / audit-IP spoofing via X-Forwarded-For (trustProxy:true + nginx append)
  - F2 SSRF IP-filter bypass via bracketed IPv6 literals (assertSafeUrl gap; end-to-end reach NOT VERIFIED here)
Confirmed P3: 3
  - F3 dependency vulnerabilities (record-only; desktop crit/high are dev-only; @xmldom resolved)
  - F4 JWT verify lacks explicit algorithms allowlist (not exploitable; hardening)
  - F5 no CSP at API layer (informational; SPA CSP is nginx's job, not verified)

Mandatory tests skipped: none deliberately skipped.
Mandatory tests NOT VERIFIED (environment — Docker Hub / Alpine CDN egress blocked, no IPv6, no browser):
  - Full production docker-compose stack on real Alpine images (postgres/redis/node)
  - Real production nginx container: CSP/CORS/Host-validation/readyz passthrough via nginx (§33/§36)
  - Real production helper Alpine base image build (§19) — behavior validated with real iptables + exact security profile instead
  - Live cross-company IDOR matrix with two real tenants (§7/§9) — covered by tenant itests, not a live 2-company HTTP run
  - Live malicious-upload matrix (§18)
  - In-browser storage/cookie inspection (§32) — verified by client code instead
  - F2 end-to-end SSRF reach to an internal service (no IPv6 stack)
  - Live audit-persistence-failure fail-closed (§40)

FINAL DECISION: PRODUCTION APPROVAL NOT VERIFIED
```

**Rationale.** No confirmed P0/P1, so the build is not rejected on findings. However
§48 permits **APPROVED FOR PRODUCTION** only when *all* mandatory runtime tests are
executed with none SKIP/NOT VERIFIED. The sandbox's egress policy prevents building
the real production Alpine image stack and the production nginx container, so a set
of mandatory production-stack runtime tests are **NOT VERIFIED**. The correct,
non-inflated verdict is therefore **PRODUCTION APPROVAL NOT VERIFIED** (not a false
"conditionally approved"). To reach a final APPROVED/NOT-APPROVED decision, re-run
this suite in an environment with Docker registry egress and IPv6, and remediate
F1 and F2 first (both are small, well-scoped fixes).
