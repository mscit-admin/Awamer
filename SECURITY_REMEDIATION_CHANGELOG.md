# Security Remediation Changelog

Per-finding record of the remediation program. Baseline in
`SECURITY_REMEDIATION_BASELINE.md`.

---

## SEC-RESET-001 — Password-reset link host/origin poisoning  (Phase 1)

- **Files modified:**
  - `backend/src/usecases/publicBaseUrl.ts` (new) — trusted base URL validation
    + resolution + startup assertion.
  - `backend/src/config/index.ts` — `APP_PUBLIC_BASE_URL` env; validated
    `config.publicBaseUrl` (invalid value fails startup).
  - `backend/src/usecases/passwordReset.ts` — resolve link base from trusted
    config only; production fail-closed when none; removed header fallback param.
  - `backend/src/routes/passwordReset.ts` — removed `originOf()`; no request
    headers passed to the usecase.
  - `backend/src/server.ts` — pass config to the usecase; startup fail-closed
    assertion (`assertResetEmailBaseUrl`).
  - `backend/src/crypto/secretBox.test.ts` — Config literal updated.
  - `deploy/scripts/install.sh`, `deploy/.env.production.example` — installer
    sets `APP_PUBLIC_BASE_URL` from the selected domain+port.
- **Root cause:** reset-link base URL fell back to attacker-controllable request
  headers (`Origin`/`Referer`/`Host`/`X-Forwarded-Host`/`X-Forwarded-Proto`)
  when the DB `app_base_url` setting was blank.
- **Fix:** reset links are built ONLY from a validated trusted base URL
  (`APP_PUBLIC_BASE_URL` env, else a valid `app_base_url` setting). Request
  headers are never consulted. Production fails closed (no email, audited) when
  no trusted base is configured; dev/test uses an explicit localhost default.
  URL validation requires https (http only in dev), a real hostname, and rejects
  embedded credentials and non-http(s) schemes.
- **Tests added:** RESET-HOST-001..008 (+ precedence) — 7 tests,
  `backend/src/usecases/passwordResetHost.test.ts`.
- **Test result:** PASS (7/7). Backend unit 99→106, integration 108 unchanged;
  deploy install-sim + security-port PASS.
- **Migration required:** none.
- **Operational impact:** production deployments should set `APP_PUBLIC_BASE_URL`
  (the installer now does so automatically from the chosen domain+port). If email
  is enabled in production without it, reset requests fail closed.
- **Remaining risk:** none for this vector; reset links can no longer be poisoned.

---

## SEC-TENANT-001 — Null-company tenant escape  (Phase 2)

- **Files modified:** `backend/src/domain/tenantScope.ts` (new — explicit
  `TenantScope` type + `tenantScopeForActor`); `backend/src/repos/userRepo.ts`
  (`list` takes explicit scope); `backend/src/repos/otherRepos.ts`
  (`AuditRepository.list` takes explicit scope, fails closed on none);
  `backend/src/repos/roleRepo.ts` (`listForScope` replaces `listForCompany`;
  none → built-ins only); `backend/src/repos/sessionRepos.ts` +
  `backend/src/repos/notesRepo.ts` (`setShares` forbids null-company sharing —
  no more `IS NOT DISTINCT FROM NULL`); callers `routes/admin.ts`,
  `routes/users.ts`, `routes/audit.ts`, `routes/roles.ts`.
- **Root cause:** a non-super user with `company_id=NULL` collapsed onto the
  same `null`/`undefined` sentinel Super Admins used for "global", so the
  company filter was dropped and every tenant's rows were returned (users,
  audit, custom roles); `setShares` `IS NOT DISTINCT FROM NULL` let null-company
  users share across the "null tenant".
- **Fix:** global access is now EXPLICIT via `TenantScope` (global | company |
  none). A non-super actor with no company resolves to `none`, which the
  repositories treat as an EMPTY/forbidden result — never global. Super Admin
  global access is preserved; company users remain confined to their company.
- **Tests added:** TENANT-NULL-001..010 (+ residual null-company share) — 10
  tests, `backend/src/repos/tenantNullScope.itest.ts`.
- **Test result:** PASS (10/10). Backend unit 106, integration 108→118. Existing
  tenant-isolation / RBAC suites unchanged and green.
- **Migration required:** none.
- **Operational impact:** a non-super account with no company now sees nothing
  tenant-scoped (previously it saw everything). Assign such accounts a company.
- **Remaining risk:** none for the null-company escape; global access requires an
  explicit permission-derived scope.
