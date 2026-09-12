# Final Security Remediation Report

**Program:** Awamer / NetSphere Terminal — Full Security Remediation (10 findings, 10 phases)
**Branch:** `claude/nifty-johnson-u2dwye`
**Baseline commit:** `9b22cee` (see `SECURITY_REMEDIATION_BASELINE.md`)
**Scope:** the 10 confirmed findings below only. No broad rewrite; working
subsystems were not redesigned. Per-phase detail is in
`SECURITY_REMEDIATION_CHANGELOG.md`.

---

## 1. Findings status

| ID | Title | Severity | Status | Phase |
|----|-------|----------|--------|-------|
| SEC-RESET-001 | Password-reset link host/origin poisoning | P1 | **FIXED** | 1 |
| SEC-TENANT-001 | Null-company tenant escape | P0 | **FIXED** | 2 |
| SEC-SESSION-001 | Password/MFA change didn't invalidate sessions | P1 | **FIXED** | 3 |
| SEC-MFA-001 | TOTP secrets stored in plaintext | P1 | **FIXED** | 4 |
| SEC-MFA-002 | MFA change lacked step-up re-auth | P2 | **FIXED** | 4 |
| SEC-SSRF-001 | AI provider SSRF (redirect / DNS rebinding) | P1 | **FIXED** | 5 |
| SEC-NET-001 | Network diagnostics too broad | P2 | **FIXED** | 6 |
| SEC-AUDIT-001 | Audit writes failed silently | P2 | **FIXED** | 7 |
| SEC-INFRA-001 | API container runs root + NET_ADMIN | P2 | **ACCEPTED TEMPORARY ARCHITECTURAL RISK** | 8 |
| SEC-DEP-001 | Vulnerable `@xmldom/xmldom` in KDBX chain | P2 | **FIXED** | 9 |

**9 of 10 FIXED and test-verified. 1 (SEC-INFRA-001) is NOT marked FIXED** —
it is documented and accepted as a temporary architectural risk per program
§43, because the genuine fix (privilege separation into a dedicated VPN helper)
cannot be built *and* runtime-verified in this environment (no Docker daemon,
no `/dev/net/tun`, no live OpenVPN). It is deliberately not faked as fixed. See
`docs/SECURITY_SEC-INFRA-001.md`.

---

## 2. What each fix does (root cause → remedy)

- **SEC-RESET-001** — Reset links no longer derive their base URL from
  attacker-controllable `Host`/`Origin`/`X-Forwarded-*` headers. The base is
  resolved from validated config (`APP_PUBLIC_BASE_URL`) via
  `usecases/publicBaseUrl.ts`; production fails closed if it is missing/unsafe.
  Header derivation (`originOf`) was removed from `routes/passwordReset.ts`.
- **SEC-TENANT-001** — A non-super actor with `company_id = NULL` no longer
  collapses to "global". An explicit `TenantScope` (`global | company | none`,
  `domain/tenantScope.ts`) is threaded through user/audit/role list repos and
  callers; `none` fails closed to empty. Null-company host/note sharing is
  rejected.
- **SEC-SESSION-001** — New monotonic `auth_version` (migration `027`) is
  embedded in access tokens (`av` claim) and compared live in
  `middleware/auth.ts`. A password or MFA change increments it and revokes
  refresh sessions + live sessions, invalidating every previously issued token.
- **SEC-MFA-001** — TOTP secrets are encrypted at rest with the existing
  AES-256-GCM envelope (`crypto/secretBox.ts` `sealBytes`/`openBytes`). Legacy
  plaintext secrets are re-encrypted idempotently at startup
  (`usecases/mfaMigration.ts`).
- **SEC-MFA-002** — Enabling/disabling MFA now requires a fresh single-use
  step-up token (`usecases/stepUp.ts`, `step_up` JWT type), so a stolen
  long-lived session cannot silently alter MFA.
- **SEC-SSRF-001** — All AI-provider outbound traffic goes through
  `ai/safeFetch.ts`: a single DNS resolution point (custom socket `lookup`,
  rebinding-safe), IP-range blocking (loopback/private/link-local/metadata,
  incl. IPv4-mapped IPv6), manual per-hop redirect re-validation, timeouts and
  a response-size cap.
- **SEC-NET-001** — Network diagnostics moved off a generic permission onto a
  dedicated `network:diagnose` (granted to super_admin/admin only), added
  target restrictions (`assertDiagnosableTarget` blocks
  loopback/link-local/metadata/multicast while still allowing RFC1918 LAN — the
  tool's purpose), a per-user rate limit, and per-operation audit.
- **SEC-AUDIT-001** — Audit-write failures are no longer swallowed: they
  increment an observable counter (`getAuditWriteFailuresTotal`) and emit a
  structured application error with correlation fields **only** (no secret
  payload). The real action is preserved verbatim instead of being rewritten to
  `config_change`.
- **SEC-DEP-001** — `@xmldom/xmldom` pinned to patched `0.8.15` via a
  `package.json` override; KDBX import (kdbxweb) verified still correct.

---

## 3. Test results (actual, re-run for this report — §54)

Numbers below were produced by re-running the suites for this report, not
copied. Integration tests ran against a **real PostgreSQL 16** instance with all
27 migrations applied (§48/§49).

| Suite | Command | pass | fail | skipped |
|-------|---------|------|------|---------|
| Backend unit | `npm test` | **128** | 0 | 0 |
| Backend integration (real Postgres) | `npm run test:integration` | **153** | 0 | 0 |
| Desktop (vitest) | `vitest run` | **23** | 0 | 0 |
| Deploy: evidence | `evidence-test.sh` | **31** | 0 | — |
| Deploy: install-sim | `install-sim-test.sh` | **33** | 0 | — |
| Deploy: security-port | `security-port-test.sh` | **81** | 0 | — |

**Backend `tsc --noEmit`:** clean. **Desktop `tsc --noEmit` + `vite build`:** clean.

Delta vs baseline (`SECURITY_REMEDIATION_BASELINE.md`): unit 99 → 128 (+29),
integration 108 → 153 (+45), frontend 16 → 23 (+7). Deploy suites unchanged
(no regression).

### New security tests added by this program (81 total)

| Group | File | Count |
|-------|------|-------|
| SEC-RESET-001 | `usecases/passwordResetHost.test.ts` | 7 |
| SEC-TENANT-001 | `repos/tenantNullScope.itest.ts` | 10 |
| SEC-SESSION-001 | `usecases/authInvalidate.itest.ts` | 12 |
| SEC-MFA-001 | `usecases/mfaCrypt.itest.ts` | 6 |
| SEC-MFA-002 | `usecases/mfaStepUp.itest.ts` | 8 |
| SEC-SSRF-001 | `ai/safeFetch.test.ts` | 16 |
| SEC-NET-001 | `routes/netScope.itest.ts` | 9 |
| SEC-AUDIT-001 | `repos/auditDurability.test.ts` | 6 |
| SEC-DEP-001 | `desktop .../keepassImport.test.ts` | 7 |

No test was skipped, disabled, quarantined, or had its expected value weakened
to pass (§57). Every fix was validated by a test asserting the *secure*
behavior.

---

## 4. Non-regression verification (§1)

All preserved-architecture invariants still pass in their existing suites
(re-run above, 0 failures): Argon2id hashing; JWT access/refresh secret
separation; refresh rotation + reuse detection; HttpOnly/Secure/SameSite=Strict
refresh cookie; live auth-state check; `ActiveSessionManager` SSH/Telnet/
Tunnel/VNC revocation; tenant-aware host/note sharing; custom-role privilege
ceiling; role/company session revocation; migration integrity (27 migrations
apply cleanly, up/down pairs intact); dynamic HTTPS port; installation-evidence
redaction; bootstrap-password non-display; support-bundle secret scanning. The
`auth_version` mechanism was added additively (`issuePair` defaults `av=1`,
`verify` defaults `av=1`), so existing token flows are unchanged.

---

## 5. Static security review (§51)

Manual `git grep` sweep over `backend/src` and `desktop/src`:

- **`child_process` / `spawn`** — only `network.ts`, `vpn/vpnManager.ts`,
  `vpn/vpnServerManager.ts`, all using `spawn` with **argument arrays (no
  shell)**; `ssh/gateway.ts` `conn.exec` is the intended remote-shell feature.
  No `execSync`/`shell:true` in runtime code. Other `.exec(` hits are `RegExp.exec`.
- **`eval` / `new Function`** — none.
- **`dangerouslySetInnerHTML`** — none.
- **Outbound `fetch`/`axios`/`http.request`** — none in backend runtime except
  a code comment; all AI outbound goes through `safeFetch`.
- **`Host`/`Origin`/`X-Forwarded-*` header reads** — none in backend (removed by
  SEC-RESET-001). `trustProxy:true` remains (nginx fronts the API) and is safe
  now that reset links no longer trust request headers.
- **`companyId == null`** — the two hits (`routes/admin.ts`, `routes/roles.ts`)
  both **fail closed** (`companyId != null && …`).
- **Empty `catch {}`** — none in runtime code.
- **`rejectUnauthorized:false`** — one, in `email/mailer.ts`, gated behind an
  explicit admin opt-in (`allowInvalid === "true"`) for self-signed SMTP;
  pre-existing, out of program scope.

### Secret scan (§50) — no secret values printed

`git grep` for private-key blocks / `ghp_…` / `AKIA…` / `postgres://user:pass@`
matched **only non-secrets**: `.env.example` dev DSN, CI test DSN, docker-compose
`${VAR}` interpolation, `generate-secrets.sh` comment, the `support-bundle.sh`
scanner's own pattern, and a UI placeholder string. **No real committed
secrets.** Credential secrets remain AES-256-GCM encrypted at rest.

---

## 6. Residual risk & follow-up

- **SEC-INFRA-001 (accepted).** API container still runs root + `NET_ADMIN` +
  `/dev/net/tun`. Mitigations in place: `cap_drop: ALL` (only `NET_ADMIN` added
  back), `no-new-privileges`, not `--privileged`, backend bound to
  `127.0.0.1`, OpenVPN spawned as an arg array, `assertSafeOvpnConfig` +
  `--script-security 1`, permission-gated VPN routes. Real fix (vpn-helper
  split) scheduled for a dedicated cycle with Docker + TUN. Full analysis:
  `docs/SECURITY_SEC-INFRA-001.md`.
- **npm-audit advisories (out of scope).** SEC-DEP-001's target
  (`@xmldom/xmldom`) is resolved to patched `0.8.15` and no longer appears in
  audit output. Remaining advisories are in **unrelated** packages not part of
  the 10-finding scope — desktop dev tooling (vite/esbuild/vitest chain) and a
  transitive fastify/nodemailer chain — and are tracked separately. CI's
  `npm audit` step is advisory (`continue-on-error`).
- **TLS** remains PARTIAL (documented pre-existing posture; unchanged).

---

## 7. Mandatory failure conditions (§55)

None present: no mandatory test failed; no test was skipped/deleted/mocked-away
to hide vulnerable behavior; no root cause was papered over; no regression in a
preserved subsystem; no secret value exposed in this report or logs; the one
unremediated finding (SEC-INFRA-001) is explicitly **not** claimed as fixed.

---

## 8. Final production decision (§56)

> ## CONDITIONALLY PRODUCTION READY

All ten findings are addressed: **9 fixed and test-verified**, and
**SEC-INFRA-001 accepted as a documented temporary architectural risk** with
compensating controls. The single condition on production readiness is:

1. **SEC-INFRA-001** must be closed by the vpn-helper privilege split (built and
   runtime-verified on a host with Docker + `/dev/net/tun`) before the API
   container can be considered unprivileged; until then it runs with the
   documented mitigations and residual risk.
2. Operational prerequisites the fixes depend on: `APP_PUBLIC_BASE_URL`,
   `CREDENTIAL_ENCRYPTION_KEY`, and the JWT secrets must be set in production
   (the app fails closed without them), and migration `027` must be applied.

This is **not** an unqualified *APPROVED FOR PRODUCTION*, solely because
SEC-INFRA-001's privilege is not yet genuinely separated. It is **not** *NOT
APPROVED* either: every P0/P1 finding is fixed and verified against real
Postgres and real session flows, with no mandatory gate failing.
