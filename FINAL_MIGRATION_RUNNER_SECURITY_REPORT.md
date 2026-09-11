# Awamer — Final Migration-Runner Security Gate Report (AWM-MIG-003 / AWM-MIG-004)

**Branch:** `claude/nifty-johnson-u2dwye`
**Scope:** AWM-MIG-003 (P1) — the migration runner fails closed when the database
and repository disagree about migration history (or the repository carries two
migrations at one version); AWM-MIG-004 (P3) — the role-key ceiling constraint
check is scoped to the `roles` relation. No other systems changed.
**Verification:** the ACTUAL runner (`tsx src/migrate.ts up`) driven as a
subprocess against a real **PostgreSQL 16**; exit codes, schema state, and the
production deploy-gate shell command all exercised for real. Full backend +
frontend regression executed.

## Gate dashboard

| Gate | Result |
| --- | --- |
| DB/repository version collision fails closed | **PASS** (MIG-RUNNER-001) |
| Duplicate repository versions rejected | **PASS** (MIG-RUNNER-006) |
| Collision stops deployment (non-zero exit) | **PASS** (MIG-RUNNER-001/010) |
| Collision blocks later migrations | **PASS** (MIG-RUNNER-004) |
| No partial state after collision | **PASS** (MIG-RUNNER-004/005) |
| Failed SQL rolls back | **PASS** (MIG-RUNNER-008) |
| Migration recorded only after success | **PASS** (MIG-RUNNER-008/009) |
| Deterministic migration ordering | **PASS** (MIG-RUNNER-007) |
| Deployment gate stops server on collision | **PASS** (MIG-RUNNER-010) |
| Constraint scoped to roles table | **PASS** (MIG-CONSTRAINT-001) |
| No duplicate constraint | **PASS** (MIG-CONSTRAINT-002) |
| Role keys ≤ 48 | **PASS** (0 rows) |
| Tenant role invariant | **PASS** (0 rows) |
| Role key uniqueness | **PASS** (0 duplicates) |
| MIG-RUNNER-001..010 | **PASS** |
| MIG-CONSTRAINT-001..002 | **PASS** |
| MIG-KEY-001..010 | **PASS** |
| MIG-RBAC-001..006 | **PASS** |
| MOVE-RBAC-001..008 | **PASS** |
| Backend build | **PASS** |
| Frontend build | **PASS** |
| Integration tests | **PASS** |
| Security tests | **PASS** |

*(Not §45 gate items:* Docker compose structure = VALID (interpolation needs the
deploy-time `.env.production`, which is expected); **Nginx `-t` = NOT VERIFIED**
(nginx not installed in the sandbox); **Tauri native build = NOT VERIFIED**
(browser is the shipped client). None is a §45 production-gate condition and none
was changed in this cycle.)*

## Actual test counts (re-run this cycle, not carried over)

```
Backend unit tests
Passed:  81   Failed: 0   Skipped: 0

Frontend tests
Passed:  16   Failed: 0   Skipped: 0

Integration tests (all *.itest.ts, real PostgreSQL 16)
Passed:  65   Failed: 0   Skipped: 0     (deterministic across repeated runs)

Migration tests (migrate.itest.ts 10 + roleMigration 3 + roleKeyLength 6)
Passed:  19   Failed: 0   Skipped: 0

Security tests (RBAC/tenant/session/auth/ssh/crypto — integration + unit subset)
Passed:  93   Failed: 0   Skipped: 0
```
New this cycle: `src/migrate.itest.ts` (MIG-RUNNER-001..010, MIG-CONSTRAINT-001..002).

## §43 — Mandatory collision demonstration (real runner, real DB)

Setup: database migrated to 024, then a foreign record planted at version 25;
repository provides `025_shorten_role_keys` and `026_scope_role_key_constraint`.

```
Database:   25_another_branch_change
Repository: 25_shorten_role_keys

$ node dist/migrate.js up      (via tsx)
MigrationCollisionError: Migration version collision detected.

Version: 25
Database migration: 25_another_branch_change
Repository migration: 25_shorten_role_keys

Migration execution has been stopped to prevent an inconsistent schema. …
EXIT CODE = 1

After:
  schema_migrations tail:  25 | another_branch_change   (UNCHANGED)
  025_shorten_role_keys executed:      NO
  026 executed / roles_key_len_chk:    NO (0)
```
→ `ERROR: migration version collision`, `process exit != 0`, migration 025 **not
executed**, migration 026 **not executed**. No secrets in the output (only
version numbers and migration names are logged).

## §44 — Final database evidence (main DB, migrated through 026)

```sql
SELECT COUNT(*) FROM roles WHERE char_length(key) > 48;                      -- 0
SELECT COUNT(*) FROM users u JOIN roles r ON r.key=u.role
  WHERE r.is_builtin=FALSE AND u.company_id IS DISTINCT FROM r.company_id;   -- 0
SELECT key, COUNT(*) FROM roles GROUP BY key HAVING COUNT(*)>1;              -- 0 rows
SELECT conname, conrelid::regclass FROM pg_constraint
  WHERE conname='roles_key_len_chk';                                        -- roles_key_len_chk | roles
```

## §42 — Code evidence

### AWM-MIG-003 — migration runner does not fail closed on history disagreement (P1) — FIXED
- **Finding:** the runner tracks applied migrations by numeric version only. A
  version recorded under a *different* name than the repository file at that
  number was treated as "already applied": the repository migration was silently
  skipped, later migrations still ran, and the runner exited 0 — so the
  production container (`node dist/migrate.js up || exit 1 ; … exec server.js`)
  started the server with a required migration missing. Repository-side, two
  files at one version merged silently (map keyed by version).
- **Root cause:** `migrate.ts` collision guard used `log.warn` (not an error),
  and `loadMigrations` deduplicated by version with no distinct-name check.
- **Affected file:** `backend/src/migrate.ts`.
- **Old behaviour:** db-vs-repo mismatch → warn, continue, exit 0; repo-vs-repo
  duplicate → silent merge.
- **New behaviour:** both cases **throw `MigrationCollisionError` before any
  migration executes** → non-zero exit → deployment/startup stops. The db-vs-repo
  error names the version, the database migration, and the repository migration;
  the repo-vs-repo error names the version and both conflicting files. **No
  automatic repair** (no rename/renumber/delete/reset); secrets are never logged.
  Detection is order-independent (distinct-name set per version). The guard runs
  before the pending filter and apply loop, so `schema_migrations` and the schema
  are untouched on failure.
- **Tests:** `src/migrate.itest.ts` MIG-RUNNER-001..010 (real subprocess + PG).
- **Test result:** 10/10 PASS; §43 demonstration exits non-zero with 025 and 026
  unexecuted and `schema_migrations` unchanged.
- **Remaining risk:** the runner still has no per-migration **checksum**, so an
  edit to an already-applied file (same version+name) is not detected. Out of
  scope here and called out as future hardening (see below).

### AWM-MIG-004 — role-key constraint check not scoped to roles (P3) — FIXED
- **Finding:** migration 025 guarded its ceiling constraint with
  `pg_constraint WHERE conname='roles_key_len_chk'` — a name that is not unique
  across relations. A same-named constraint on another table would make the guard
  skip adding it to `roles`, leaving `roles` without its intended CHECK.
- **Root cause:** existence check by `conname` alone.
- **Affected file (fix):** new `backend/migrations/026_scope_role_key_constraint.up.sql`
  (025 is shipped and left untouched, per project rule).
- **Old behaviour:** unscoped `conname` existence check.
- **New behaviour:** `026` ensures the constraint on the `roles` relation
  specifically (`conname='roles_key_len_chk' AND conrelid='roles'::regclass`);
  idempotent (no duplicate when `roles` already has it).
- **Tests:** `src/migrate.itest.ts` MIG-CONSTRAINT-001 (same-named constraint on
  another table does not hide a missing `roles` constraint), MIG-CONSTRAINT-002
  (no duplicate).
- **Test result:** 2/2 PASS; post-migration `roles_key_len_chk` is on `roles`.
- **Remaining risk:** none for this scope.

## §34 — Migration history audit

001–025 (+ new 026) are contiguous; every version has exactly one name and a
matched up/down pair. No duplicate numeric versions, no gaps, no orphan up/down
files. `schema_migrations` PK on `version` prevents duplicate DB rows per version.

## §35 — Migration immutability (residual risk, recommendation only)

The runner records `version, name, applied_at` but **no checksum**. It cannot
detect an already-applied migration file being edited afterward (same
version+name). This cycle deliberately does not add a checksum redesign.
**Recommended future hardening:** extend `schema_migrations` with a `checksum`
column and verify the stored checksum of each already-applied migration on every
run, failing closed on a mismatch — mirroring the AWM-MIG-003 fail-closed posture
for content drift as well as identity drift.

## Preserved controls — regression-tested green

AWM-MIG-002 (role-key ≤48 + deterministic generation + DB constraint), AWM-MIG-001
(cross-tenant role split), SEC-020 (user-move role integrity), permission ceiling,
`companies:manage` protection, tenant isolation + explicit sharing, logout
revocation + logout-all, refresh rotation/reuse protection, WebSocket auth (no
secret in any WS URL), HttpOnly browser refresh cookie + legacy cleanup,
PostgreSQL readiness, SSH host-key validation — all covered by the 81 unit + 65
integration suite that passes in full.

## Findings

```
P0 remaining: 0
P1 remaining: 0
P2 remaining: 0
P3 remaining: 0   (AWM-MIG-004 fixed; migration checksum is a documented future recommendation, not an open P3)

Fixed:            AWM-MIG-003 (migrate.ts fail-closed + duplicate-version detection),
                  AWM-MIG-004 (migration 026 roles-scoped constraint)
Partially fixed:  none
Unresolved:       none
False positives:  none
Not verified:     nginx -t (not installed), Tauri native build (not the shipped client) — neither a §45 gate nor a mandatory migration/security test
```

---

## Decision

# APPROVED FOR PRODUCTION

**P0 = 0, P1 = 0.** AWM-MIG-003 is FIXED: a database/repository migration-history
disagreement, and a duplicate repository version, both **fail closed** — the
runner throws before executing anything, exits non-zero, leaves `schema_migrations`
and the schema untouched, blocks all later migrations, and (proven via the real
deploy-gate command) stops the server from starting. AWM-MIG-004 is FIXED: the
`roles_key_len_chk` constraint is verified specifically on the `roles` relation.

MIG-RUNNER-001..010, MIG-CONSTRAINT-001..002, MIG-KEY-001..010, MIG-RBAC-001..006,
and MOVE-RBAC-001..008 all PASS. Role keys > 48 = 0, tenant custom-role
violations = 0, duplicate role keys = 0. Backend and frontend builds pass;
integration and security suites pass in full against a real PostgreSQL 16. **No
mandatory test is failing, skipped, or not-verified.** The only residual item is a
recommendation-only migration-checksum enhancement (§35), which is not a §45 gate
condition.

> Awamer can no longer silently treat a different migration as already applied
> merely because it shares the same numeric migration version. Migration-history
> disagreement fails closed.
