# AWAMER PRODUCTION GO-LIVE ASSESSMENT

**Release:** 1.8.0

**Commit:** `4e5d4bd4ecf382d13aa2bb880063de779d9a0aaa` (code). The commit that follows it adds only these evidence documents.

**Assessment Date:** 2026-10-02

**Security Baseline:** `security-final/`: PRODUCTION SECURITY ACCEPTED WITH CONDITIONS. Re-verified at the start of this phase: 525 passed / 0 failed / 0 skipped.

**Final Tests:** 550 passed / 0 failed / 0 skipped (backend unit 299, integration 227, frontend 23, desktop SSH live 1). Smoke: 60/60 twice. Startup refusals: 4/4.

**Production Build:**
- Backend and frontend builds VERIFIED.
- Commit `4e5d4bd` built from `git archive` in `node:20-alpine` and run under the production container restrictions: VERIFIED.
- **Final container images: BLOCKED BY ENVIRONMENT** (Alpine package mirror denied).

**Go-Live Decision:** **GO-LIVE APPROVED WITH OPERATIONAL CONDITIONS**

---

## 1. Executive Summary

This phase closed the conditions the security assessment left open. It did not re-run the audit or redesign working controls.

**Closed:**

| Item | Outcome |
|---|---|
| **Single release** | 1.8.0 is traceable from commit to `/api/v1/version` to the About screen |
| **Database least privilege** | The backend, helper and migrations no longer use the PostgreSQL superuser |
| **russh** | The desktop SSH advisory is closed by upgrading to 0.63.3, verified live against OpenSSH |
| **Production configuration gate** | API docs, CORS, and the helper secret |
| **Logging** | Redaction now covers tokens and the query string |
| **Container hardening** | Read-only root filesystem for backend, migrate and db-provision |
| **Backup/restore** | Correct under the new privilege model |
| **CI** | A real gate, not advisory only |

**Found and fixed during verification:**
- **The VPN PKI issued about 1 in 650 certificates that OpenSSL/OpenVPN cannot parse.** The full test gate surfaced this as an intermittent failure; it was root-caused rather than dismissed as flaky.
- A hard-coded `v1.0.0` on the login page.
- A real server address used as a UI placeholder.
- Pre-existing lint errors that made the CI lint step fail.

**Regression gate:** every previously fixed vulnerability (VPN injection, MFA token confusion, SMTP authorization, super-admin protection, remote-session SSRF, VPN file access) is still DENIED. Each was proven by unit/integration tests **and** by the smoke test against the production-mode build.

**Why "with operational conditions":** the final container images could not be built in this environment. This is a verification gap, not a vulnerability. Every application layer of those images was verified in the real base image under the real runtime restrictions, but the images themselves must be built and smoke-tested on the target or in CI before serving traffic (OR-01).

## 2. Previous Security Conditions

From `security-final/PRODUCTION_ACCEPTANCE.md`:

| Condition | Status |
|---|---|
| C-1 deploy the remediated commit | Superseded by commit `4e5d4bd` (contains it) |
| C-2 single version | **Closed** |
| C-3 CI image build | **CI job added**; build blocked here (OR-01) |
| C-4 remote-session policy defaults | **Kept and verified** |
| C-5 API docs off | **Enforced in code** |
| C-6 audit alert | **Defined** |
| C-7 compromise review | **Carried** (OR-02) |
| R-01 russh | **Closed** |
| R-02 DB superuser | **Closed** |
| R-03 helper | **Hardened** (OR-04, OR-05 remain) |
| R-04 versions | **Closed** |
| R-05 Docker | **Partially closed** (OR-01) |

## 3. Changes Performed

| Area | Change | Files |
|---|---|---|
| Release | 1.8.0 everywhere; `/api/v1/version`; About/login show the real release; Dockerfile tag guard + OCI labels; CI release gate | `backend/src/version.ts`, `server.ts`, `desktop/vite.config.ts`, `SettingsPage.tsx`, `LoginPage.tsx`, Dockerfiles, `scripts/check-release-version.mjs` |
| DB least privilege | Provisioning script; migration 029; DB-only migration config; runtime role guard; compose `db-provision` + `migrate` services; installer, env, backup/restore | `deploy/db/provision-roles.sh`, `backend/migrations/029_*`, `migrate.ts`, `db/runtimeRole.ts`, compose, `deploy/scripts/*` |
| VPN helper | Dedicated `awamer_vpn_auth` DB identity | compose |
| VPN PKI | Minimal DER certificate serials | `backend/src/vpn/pki.ts` |
| Desktop SSH | russh 0.63.3; `ssh_auth.rs`; live test | `desktop/src-tauri/src/commands/*` |
| Config | Production refuses API docs, unsafe CORS, a missing/short helper secret; lazy Swagger | `config/index.ts`, `server.ts` |
| Logging | Query-string-free request logs; extended redaction | `logger/index.ts` |
| CI | Release / audit / build / live-SSH / images gates | `.github/workflows/ci.yml` |

## 4. Version Closure

The release is 1.8.0 in all 9 first-party declarations. `/api/v1/version`, the About screen and the login page show the real release, and the image build refuses a mismatched tag. See `RELEASE_VERSION_EVIDENCE.md`.

## 5. Database Least Privilege

- **Roles:** the migrator owns the schema without superuser; the app has DML only; the helper has 4 columns.
- **No silent fallback:** the runtime refuses privileged roles.
- **Verified** on fresh install, upgrade, and backup/restore.

See `DATABASE_PRIVILEGE_MATRIX.md`.

## 6. VPN Helper Hardening

Elevation is documented as required: NET_ADMIN, tun, host network, root. Everything else is minimised, and the DB identity went from superuser to 4 columns. A read-only root filesystem is deferred to the first real image build. See `VPN_HELPER_SECURITY_BOUNDARY.md`.

## 7. Dependency Status

- **russh:** closed.
- **Production runtime:** no Critical, and no reachable High.
- **Remaining:** triaged (unreachable, build-time or dev-only) in `DEPENDENCY_FINAL_STATUS.md`.
- **SBOMs:** in `sbom/`.

## 8. Docker / Build Verification

- **Final images:** BLOCKED BY ENVIRONMENT.
- **Base-image emulation of commit `4e5d4bd`:** version guard, `npm ci`, build, prune, argon2 on musl, and the migrate + backend runtime under uid 10001, read-only rootfs, zero capabilities and `NoNewPrivs` all passed, plus the 60/60 smoke. See `DOCKER_BUILD_EVIDENCE.md`.

## 9. Security Regression Results

All six gate items are DENIED across tests and both smoke runs. See `SECURITY_REGRESSION_RESULTS.md`.

## 10. RBAC Verification

All §19 requirements pass, including `settings:manage` restricted to super_admin and admin unable to touch super_admin. See `SECURITY_REGRESSION_RESULTS.md`.

## 11. Tenant Isolation Verification

All seven cross-tenant attempts are denied. See `SECURITY_REGRESSION_RESULTS.md`.

## 12. Production Configuration

Fail-closed startup validation; the insecure-default search is classified; logging, audit monitoring, environment separation and backup/recovery are defined. See `PRODUCTION_CONFIGURATION.md` and `REMOTE_DESTINATION_POLICY.md`.

## 13. Release Traceability

The chain runs commit → version → build → image tag/labels → `/api/v1/version` → About screen. It was verified for commit `4e5d4bd` except the final image link (OR-01). See `RELEASE_TRACEABILITY.md`.

## 14. Remaining Operational Risks

See `REMAINING_OPERATIONAL_RISKS.md`.
- **Blocking before traffic:** OR-01 (build and smoke-test the final images).
- **For an upgrade of an existing deployment:** OR-02 (compromise review).
- **Everything else:** low-severity hardening or accepted dependency risk.

## 15. Go-Live Decision

# GO-LIVE APPROVED WITH OPERATIONAL CONDITIONS

**Gate assessment:**

| Gate criterion | Met? |
|---|---|
| No Critical vulnerabilities | Yes |
| No exploitable High | Yes |
| Security regression tests pass | Yes |
| RBAC | Yes |
| Tenant isolation | Yes |
| Version consistent | Yes |
| Production configuration secure | Yes |
| DB privilege model acceptable | Yes, now least privilege |
| Smoke test succeeds | Yes, on the production-mode build and on commit `4e5d4bd` under container restrictions |
| Release evidence exists | Yes |
| Required images verified | **No.** Blocked by the environment, which prevents an unconditional GO-LIVE APPROVED |

**Why not REJECTED:** there is no authentication bypass, privilege escalation, cross-tenant access, secret disclosure or security regression. The artifact is reliably associated with the tested source: the tag guard, the commit reported by `/api/v1/version`, and the lockfile-exact `npm ci`.

**Operational conditions:**

1. **OR-01 (before serving traffic).** Build `netsphere/auth-service:1.8.0` and `netsphere/vpn-helper:1.8.0` from commit `4e5d4bd` (or its merge), using the CI `images` job or the target host.
   - Record the image digests.
   - Run `docker compose up` with a throwaway environment, then `backend/scripts/smoke-production.mjs` (60/60 required).
   - Confirm `/api/v1/version` reports that commit.
   - Perform one manual VPN connect.
2. **OR-02 (upgrades only).** Complete the post-upgrade compromise review.
3. **OR-03.** Configure the `audit_write_failures_total > 0` alert at deployment.
