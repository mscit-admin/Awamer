# FINAL F1 + F2 + JWT Hardening Fix Report
**Awamer / NetSphere Terminal**

Scope strictly limited to the three items from the penetration report; no
unrelated application logic, and no redesign of auth/RBAC/VPN/tenant/session/
deployment. Branch `claude/nifty-johnson-u2dwye`.

- **F1** — restrict proxy trust so spoofed `X-Forwarded-*` cannot influence
  `req.ip` / rate limiting / audit IP.
- **F2** — normalize IPv6 / IPv4-mapped-IPv6 literals before SSRF classification.
- **Hardening** — pin JWT verification to `HS256` explicitly on every verify path.

---

## Gate table

| Gate | Result |
| --- | --- |
| trustProxy restricted | **PASS** — `trustProxy: cfg.trustProxy` (default `loopback, uniquelocal`); literal `"true"` rejected by config |
| spoofed X-Forwarded-For blocked | **PASS** — PROXY-TRUST-001/006 (unit) + live (untrusted peer) |
| rate-limit spoofing blocked | **PASS** — PROXY-TRUST-002/003 + **live**: rotating XFF → 10×401 then 429 |
| audit IP protected | **PASS** — PROXY-AUDIT-001 (req.ip = trusted resolved IP, not header) |
| IPv6 loopback SSRF blocked | **PASS** — SSRF-IPV6-001 (`[::1]`), 007 (`[::]`) |
| IPv4-mapped IPv6 blocked | **PASS** — SSRF-IPV6-002/003/004 (loopback/RFC1918/metadata) |
| mixed DNS fail-closed | **PASS** — SSRF-IPV6-008 (any forbidden resolved addr → reject) |
| redirect IPv6 SSRF blocked | **PASS** — SSRF-IPV6-009/010 (revalidated each hop) |
| HS256 explicitly enforced | **PASS** — `algorithms:["HS256"]` on access/refresh/mfa_pending/step-up |
| JWT wrong algorithms rejected | **PASS** — JWT-ALG-001..006 (+ refresh/step-up) |
| relevant regression suites | **PASS** — unit 255/0, integration 209/0 |

---

## F1 — Restrict proxy trust

**Before:** `server.ts` used `trustProxy: true` (trust every hop → the left-most,
client-supplied `X-Forwarded-For` became `req.ip`). Combined with the shipped
nginx `X-Forwarded-For $proxy_add_x_forwarded_for` (append), a direct client could
spoof `req.ip`, bypassing the IP rate limiter and forging the audit source IP.

**Change (smallest safe solution):**
- `config/index.ts` — new `TRUST_PROXY` env (proxy-addr syntax), **default
  `"loopback, uniquelocal"`**, surfaced as `cfg.trustProxy`. The literal `"true"`
  is rejected by a zod refine so trust can never silently widen to all clients.
- `server.ts` — `trustProxy: cfg.trustProxy` (was `true`).
- `deploy/nginx/netsphere.conf` — documented + hardened the `/api/` proxy headers:
  `Host`/`X-Real-IP`/`X-Forwarded-Proto`/`X-Forwarded-Host` are Nginx-derived
  (overwritten), `X-Forwarded-For` appends the real `$remote_addr` as the
  right-most hop, and the unused RFC 7239 `Forwarded` header is cleared
  (`proxy_set_header Forwarded "";`).

**Trust model (documented):** the backend trusts `X-Forwarded-*` only when the
immediate peer is loopback or a private/ULA address — i.e. the reverse proxy on
the host (127.0.0.1:8081 publish) or a private Docker network. With nginx
appending `$remote_addr`, proxy-addr walks the chain from the trusted peer and
stops at the first untrusted (public) address = the real external client, so the
client's own left-most `X-Forwarded-For` entries are discarded. A direct client
on an **untrusted** (public) address cannot spoof `req.ip` at all. (A process
already on the host's loopback is inside the trust boundary by design — the
production backend binds `127.0.0.1` only, so nothing external can reach it
directly. Operators can tighten `TRUST_PROXY` to a specific proxy CIDR.)

**Live proof (§17).** With `TRUST_PROXY=10.0.0.0/8` (making the local curl an
untrusted peer), 15 login attempts each with a different `X-Forwarded-For` →
`401 ×10` then `429 ×5`: the limiter keys on the real peer and ignores XFF
rotation. This is the exact attack from the penetration report, now defeated
(previously each new XFF minted a fresh `401` bucket).

**PROXY-TRUST / PROXY-AUDIT tests** (`src/routes/proxyTrust.test.ts`, real
Fastify + `@fastify/rate-limit`, `inject({remoteAddress})` — actual behavior, not
header parsing):
- 001 forged XFF (untrusted peer) → `req.ip` = real peer.
- 002 forged `X-Real-IP` → same rate-limit bucket (2nd → 429).
- 003 forged `Forwarded` → same bucket (2nd → 429).
- 004 trusted proxy → `req.ip` = forwarded real client.
- 005 two clients behind the proxy → distinct `req.ip` + distinct buckets.
- 006 untrusted proxy hop ignored.
- AUDIT-001 forged XFF does not poison the audited IP.

---

## F2 — IPv6 / IPv4-mapped-IPv6 SSRF normalization

**Root cause:** `assertSafeUrl` classified literals with `isIP(u.hostname)`, but
`URL.hostname` keeps the brackets for an IPv6 literal (`"[::1]"`,
`"[::ffff:7f00:1]"`), so `isIP` returned 0 and the literal was treated as a
hostname and deferred to DNS — and Node's http/https client skips the pinning
`lookup` for IP literals, so a bracketed IPv6 literal reached the socket without
the SSRF IP check.

**Change (one spot, minimal):** in `safeFetch.ts`, strip the surrounding brackets
before `isIP`/`isBlockedIp`:
```ts
const hostLiteral = u.hostname.replace(/^\[(.*)\]$/, "$1");
if (isIP(hostLiteral) && isBlockedIp(hostLiteral, { allowLoopback })) throw new SsrfError(...);
```
`isBlockedIp`/`ipv6Blocked` already decode `::1`, `::/128`, `fc00::/7`,
`fe80::/10`, `ff00::/8` and IPv4-mapped `::ffff:a.b.c.d` (inheriting the mapped
IPv4 classification), so bracket-stripping is the whole fix. Redirect targets are
re-validated through the same `assertSafeUrl` (unchanged), so IPv6-form redirect
Locations are covered too.

**Anti-rebinding preserved:** the single pinned `lookup` is untouched — hostnames
still resolve once, every resolved address is checked (`reject if ANY is
unsafe`), and the socket connects to the validated address. No second lookup was
introduced.

**SSRF-IPV6 tests** (`src/ai/safeFetch.test.ts`): 001 `[::1]`; 002
`[::ffff:127.0.0.1]` (+ uncompressed `[0:0:0:0:0:ffff:7f00:1]`); 003 mapped
RFC1918; 004 mapped metadata; 005 `fc00::/7`; 006 `fe80::/10`; 007 `ff00::/8` +
`[::]`; 008 hostname→forbidden fails closed; 009/010 redirect to IPv6-form
forbidden target; 011 valid public IPv6 allowed; 012 public IPv4 unchanged.

**Runtime note (§17).** IPv6 end-to-end connection could **NOT be exercised** in
this sandbox — no IPv6 stack (`connect EAFNOSUPPORT`). The normalization/blocking
is verified by unit tests against the shipped guard; live IPv6 reachability is
**NOT VERIFIED** here (environment).

---

## JWT hardening

`jwt/index.ts` — both `jwtVerify` calls now pass `algorithms: ["HS256"]`:
- the shared `verify()` (access, refresh, `mfa_pending`),
- `verifyStepUp()` (step-up tokens).

Password-reset tokens are **not** JWTs (random token, hashed in DB), so no change
is needed there. This is defense-in-depth: even if a future key/library change
would otherwise permit it, `none`, `HS384/HS512` downgrade, and asymmetric
(`RS256`) confusion are rejected.

**JWT-ALG tests** (`src/jwt/algVerify.test.ts`): 001 valid HS256 accepted; 002
`alg=none` rejected; 003 HS384 rejected; 004 HS512 rejected; 005 RS256 rejected;
006 tampered alg header rejected; plus refresh + step-up HS512 rejection.

---

## Regression (§16) — no security expectation weakened

| Suite | Result |
| --- | --- |
| Backend unit (incl. new JWT-ALG, PROXY-TRUST, SSRF-IPV6) | **255 / 0** |
| Backend integration (real PG) — login, AUTH-INVALIDATE(+WS), MFA, step-up, tenant, RBAC, netCidr, VPN | **209 / 0** |
| tsc / build | clean |

Test fixtures updated only to stay in sync with the `Config` type (`trustProxy`
added to the `secretBox.test.ts` fake) and to add new positive/negative cases —
no assertion was loosened.

---

## Static confirmation

- `trustProxy: true` no longer present in source (`server.ts` uses `cfg.trustProxy`).
- `assertSafeUrl` strips IPv6 brackets before literal classification.
- Both JWT `jwtVerify` calls carry `algorithms: ["HS256"]`.

---

## NOT VERIFIED (environment)

- **Live IPv6 SSRF reachability** — no IPv6 stack in the sandbox (`EAFNOSUPPORT`);
  F2 verified by unit tests against the shipped guard.
- **Real production nginx runtime** header behavior — the production nginx
  container is not buildable here (Docker Hub egress blocked); the nginx config
  change is a static edit, and the backend-side trust behavior is verified live +
  by unit tests.

---

## Automatic-rejection checklist — none triggered

trustProxy no longer `true`/unrestricted ✔ · direct (untrusted) client cannot
spoof `req.ip` ✔ · rate limit not bypassable with forwarded headers (live) ✔ ·
`[::1]` classified + blocked ✔ · `::ffff:127.0.0.1` blocked ✔ · mapped
RFC1918/metadata blocked ✔ · redirect IPv6 target revalidated ✔ · mixed DNS fails
closed ✔ · JWT verification pinned to HS256 (others rejected) ✔ · implementation
fixed, tests added not weakened ✔.
