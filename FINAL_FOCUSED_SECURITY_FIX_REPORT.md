# Final Focused Security Fix Report

**Scope:** a small, controlled remediation of four items only — no broad rewrite,
no redesign of working subsystems. Branch `claude/nifty-johnson-u2dwye`.

1. **SEC-SESSION-002** — a stale access token must not open a NEW WebSocket session.
2. **MFA plaintext fail-closed hardening** — unexpected plaintext TOTP is rejected.
3. **Step-Up token `auth_version` binding** — a step-up token dies on a security change.
4. **Network CIDR hardening** — explicit allow-list, fail-closed by default.

Nothing outside these four areas was modified (see §Scope below). No new
migration was required — the fixes reuse the existing `auth_version` column
(migration `027`).

---

## Control results

| Control                                    | Result |
| ------------------------------------------ | ------ |
| HTTP stale token rejected                  | PASS   |
| SSH stale token rejected                   | PASS   |
| Telnet stale token rejected                | PASS   |
| Tunnel stale token rejected                | PASS   |
| VNC regression                             | PASS   |
| MFA plaintext runtime fallback removed     | PASS   |
| MFA malformed value fails closed           | PASS   |
| Step-up bound to auth_version              | PASS   |
| Old step-up after password change rejected | PASS   |
| Explicit network CIDR allowlist            | PASS   |
| No-allowlist private network denied        | PASS   |
| DNS rebinding diagnostic protection        | PASS   |
| Existing security regression suites        | PASS   |

---

## 1. SEC-SESSION-002 — stale access token cannot open a new WS session

**Root cause.** The HTTP middleware compared `claims.av` with `live.authVersion`,
but the direct-token WebSocket gateways (SSH, Telnet, TCP tunnel) only verified
the JWT + live account state — they did NOT compare `auth_version`. An access
token issued before a password/MFA change could open a fresh remote session
until it expired.

**Fix.** One authoritative helper, `verifyCurrentAccessToken(jwt, users, token)`
(`backend/src/middleware/auth.ts`), performs the full check for EVERY entry
point: (1) verify signature, (2) verify token type, (3) verify expiry, (4) load
the live user, (5-7) reject deleted / disabled / locked accounts, (8) compare
`claims.av === live.authVersion`, and returns the live user so callers authorize
on `live.role` — never the role embedded in the stale token. The HTTP middleware
and all three WS gateways now call this single helper; no path re-implements the
logic. VNC (`/ticket`) and SFTP already authenticate through the HTTP middleware,
so they inherit the check at issuance.

**Files:** `middleware/auth.ts` (helper + middleware), `ssh/gateway.ts`,
`telnet/gateway.ts`, `ssh/wsTunnelGateway.ts`.

**Tests (real PostgreSQL, real gateways):** `authInvalidateWs.itest.ts` —
AUTH-INVALIDATE-WS-001..010 + a VNC ticket-issuance regression (**11** tests):
old token rejected on SSH/Telnet/Tunnel after password change, forgot-password
reset, admin reset, MFA replacement, MFA disable; fresh tokens still work; an
unrelated user is unaffected; a stale token cannot mint a VNC ticket while a
fresh one can.

## 2. MFA plaintext fail-closed hardening

**Root cause.** `MFAUseCase.openSecret` fell back to
`secretEnc.toString("utf8")` for any value that was not a sealed envelope —
silently trusting DB plaintext as a TOTP seed.

**Fix.** `openSecret` now rejects any non-sealed value with a sanitized
`MfaSecretError` (no secret material in the message) instead of interpreting it
as a seed. A malformed/tampered envelope, or the wrong key, makes GCM decryption
throw — equally fail-closed. The startup migration
(`reencryptLegacyMfaSecrets`) still reads raw bytes and re-seals legacy plaintext
BEFORE the service accepts traffic, so the ordering is: migration completes →
runtime accepts encrypted format only. The secret is never logged.

**Files:** `usecases/mfa.ts` (`MfaSecretError`, fail-closed `openSecret`).

**Tests:** `mfaFailClosed.test.ts` — MFA-FAILCLOSED-001..008 (**8** tests):
encrypted seed decrypts; plaintext rejected (even with a "correct" code);
malformed/tampered/wrong-key rejected; migration converts plaintext and is
idempotent; no plaintext rows remain; the secret never appears in the error or
any log/audit call.

## 3. Step-Up token bound to auth_version

**Root cause.** Step-up tokens were short-lived, purpose-bound and single-use,
but not tied to the account security version — one issued before a password/MFA
change stayed valid for its full TTL.

**Fix.** The step-up token now carries `av` (`jwt.issueStepUp` embeds it,
`verifyStepUp` returns it; absent → `NaN` so an unbound token can never match).
`StepUpService.issue` pins the account's current `auth_version`; `consume`
verifies signature + expiry + purpose + user, then loads the live user and
rejects unless `claims.av === live.authVersion`, before the single-use JTI is
consumed atomically. A password change, forgot-password reset, admin reset, or
MFA replacement (all increment `auth_version`) therefore invalidate an
outstanding step-up token immediately.

**Files:** `jwt/index.ts`, `usecases/stepUp.ts`, `server.ts` (inject the user
source).

**Tests:** `mfaStepUpAv.itest.ts` — STEPUP-AV-001..010 (**10** tests): valid at
same version; invalidated by password change / forgot reset / admin reset / MFA
replacement; expired rejected; reuse rejected; wrong-purpose rejected; another
user's token rejected; a fresh step-up after a change works. The existing
`mfaStepUp.itest.ts` (**8**) still passes.

## 4. Network CIDR hardening

**Root cause.** Diagnostics allowed ANY RFC1918 target and only blocked
infra-sensitive addresses, so a privileged admin could probe the whole private
network (Docker, PostgreSQL, Redis, management interfaces).

**Fix.** A new explicit policy (`usecases/networkPolicy.ts`) driven by config
(`NETWORK_DIAGNOSTIC_ALLOWED_CIDRS`, optional `NETWORK_DIAGNOSTIC_DENY_CIDRS`):

- **Sensitive destinations are ALWAYS denied** — loopback `127.0.0.0/8`,
  unspecified `0.0.0.0`, link-local + cloud metadata `169.254.0.0/16`, multicast
  `224.0.0.0/4`, broadcast `255.255.255.255`, and the IPv6 equivalents.
- **Private/internal targets require the allow-list.** A private address is
  permitted only when contained in an allowed CIDR; **with no allow list every
  private target is denied (fail-closed)** — the production default. An optional
  deny list (the app's own infra) overrides even an allowed range.
- **Scanning requires full containment** — a requested CIDR must sit entirely
  within one allowed CIDR (no partial overlap); existing size/port/parallelism/
  timeout/rate limits are preserved.
- **DNS hardening (rebinding/TOCTOU).** A hostname is resolved once, EVERY
  resolved address is validated, and the tool is then run against the validated
  IP (not the hostname, which the binary would otherwise re-resolve). If any
  resolved address is disallowed the whole request is refused. The audit records
  **both** the requested host and the validated destination IP.
- Public addresses remain allowed (the finding is internal-infra exposure).

**Files:** `usecases/networkPolicy.ts` (new), `config/index.ts`,
`routes/network.ts`, `server.ts`, `.env.example`.

**Tests:** `networkPolicy.test.ts` (**8** unit) + `netCidr.itest.ts` —
NET-CIDR-001..015 (**15** integration): no-allowlist private denied; allowed /24
works; subnet-in-allowed scan works; outside-allowlist and partial-overlap
rejected; loopback/link-local/metadata rejected; Docker/internal subnet
rejected; hostname-outside-allowlist rejected; DNS-rebinding (allowed + sensitive)
rejected; authorized hostname→allowed-IP works; standard user still lacks
`network:diagnose`; authorized admin succeeds; audit contains requested host +
validated IP. The existing `netScope.itest.ts` (**9**) still passes.

---

## Static verification (§15)

**`verifyAccess(` / `jwt.verifyAccess(` — does each path enforce current `auth_version`?**

| Location | Enforces auth_version? |
| --- | --- |
| `jwt/index.ts:61` (interface decl) | N/A — type declaration |
| `jwt/index.ts:130` (primitive impl) | N/A — low-level verify; the caller enforces `av` |
| `middleware/auth.ts` (inside `verifyCurrentAccessToken`) | **YES** — the shared check |
| `routes/auth.ts:124` (`/mfa/verify`) | N/A — pre-session login challenge (`role === "mfa_pending"`), minted seconds earlier in the same login; not a session-resuming access token |

All session entry points route through `verifyCurrentAccessToken`: HTTP
middleware, SSH, Telnet, TCP tunnel (direct token); VNC `/ticket` and SFTP via
the HTTP middleware. **No direct access-token path skips the `auth_version`
check.**

**`secretEnc.toString` / plaintext MFA:** the only `.toString("utf8")` on a TOTP
secret is on already-decrypted bytes (`mfa.ts:70`), reached solely after
`isSealedBytes` passes; the plaintext fallback is gone. The migration still reads
raw bytes to re-seal legacy rows.

**`network:diagnose` / `RFC1918` / `10.0.0.0` / `172.16.` / `192.168.`:** the
route is permission-gated (`network:diagnose`, super_admin/admin only —
unchanged). RFC1918 literals appear only in the fail-closed classifier
(`isPrivateIp`, used to DENY unless allow-listed), config comments/examples, and
a CIDR-format hint — no blanket RFC1918 allow remains.

---

## Test counts (actual, re-run for this report)

Integration tests ran against a **real PostgreSQL 16** with all 27 migrations.

| Suite | pass | fail | skipped |
| --- | --- | --- | --- |
| Backend unit (`npm test`) | **144** | 0 | 0 |
| Backend integration (`npm run test:integration`, real Postgres) | **189** | 0 | 0 |
| Desktop (`vitest run`) | **23** | 0 | 0 |
| Deploy: evidence / install-sim / security-port | **31 / 33 / 81** | 0 | — |

Backend `tsc --noEmit` clean; desktop `tsc --noEmit` + `vite build` clean.

**New tests added by this fix (52):** AUTH-INVALIDATE-WS **11**, MFA-FAILCLOSED
**8**, STEPUP-AV **10**, networkPolicy(unit) **8**, NET-CIDR **15**. Delta vs the
prior baseline: unit 128 → 144 (+16), integration 153 → 189 (+36).

**Regression suites re-run, all green:** AUTH-INVALIDATE (12), AUTHZ-STATE
(authState 6 / authStateWs 4), MFA-CRYPT (6), MFA-STEPUP (8), AI-SSRF
(safeFetch 16), NET-SCOPE (9), TENANT-NULL (10), RESET-HOST (7),
AUDIT-DURABILITY (6). No previously passing security suite regressed; nothing was
skipped, deleted, weakened, or mocked away.

---

## Scope (what was NOT touched, §13)

No changes to: AI `safeFetch`, password-reset URL security, `TenantScope`,
`AuditRepository` behavior, dynamic HTTPS port, TLS installer, support bundle,
Docker `NET_ADMIN` architecture, `@xmldom/xmldom`, the RBAC model, JWT signing
algorithms, refresh-token rotation, the RBAC privilege ceiling, or the
`ActiveSessionManager` design. The one test-fixture edit
(`telnet/gateway.itest.ts`) adds the required `authVersion` field to a fake user
so the newly-enforced check has a value to compare; `secretBox.test.ts` gains one
field on a config literal for compilation.

---

## Automatic rejection conditions (§17) — none present

- Old access token cannot open a new SSH/Telnet/Tunnel session after a security
  change (AUTH-INVALIDATE-WS-001..007). ✅
- Plaintext TOTP row is rejected by runtime (MFA-FAILCLOSED-002). ✅
- Step-up token does NOT survive an `auth_version` change (STEPUP-AV-002..005). ✅
- Private RFC1918 networks are NOT globally permitted by default (NET-CIDR-001,
  networkPolicy unit). ✅
- Hostname validation is not bypassable by a second DNS resolution — the tool
  runs against the pre-validated IP (NET-CIDR-011/012). ✅
- Ordinary users do not regain network diagnostics (NET-CIDR-013). ✅
- No previously accepted security test regressed. ✅

## Final state

Security-state change → old HTTP access token invalid; old SSH/Telnet/Tunnel
access token invalid; established remote sessions closed (existing
`ActiveSessionManager`); previous step-up token invalid. MFA DB value → encrypted
only; unexpected plaintext → fail closed. Network diagnostics → permission +
explicit allowed CIDR; no configured CIDR → private network denied.
