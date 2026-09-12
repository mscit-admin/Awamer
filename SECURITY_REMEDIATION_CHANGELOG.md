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
