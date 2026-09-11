# Awamer — Final Migration History Integrity Gate Report (AWM-MIG-005)

**Branch:** `claude/nifty-johnson-u2dwye`
**Scope:** AWM-MIG-005 (P1) — the migration runner must validate migration history
**bidirectionally** (repo↔DB) and reject non-contiguous history **before** running
any pending migration, so the application can never start against a database whose
applied history is unknown, newer, divergent, or incomplete relative to the
deployed repository. No other systems changed.
**Verification:** the ACTUAL runner (`tsx src/migrate.ts up`) driven as a
subprocess against real **PostgreSQL 16**; exit codes, schema state, and the
deploy-gate command all exercised for real. Full backend + frontend regression.

## Gate dashboard

| Gate | Result |
| --- | --- |
| DB unknown migration detection | **PASS** (MIG-RUNNER-011) |
| DB ahead of repository detection | **PASS** (MIG-RUNNER-014) |
| Removed migration detection | **PASS** (MIG-RUNNER-012) |
| Same version / different name | **PASS** (MIG-RUNNER-017) |
| Duplicate source migration versions | **PASS** (MIG-RUNNER-018) |
| History gap detection | **PASS** (MIG-RUNNER-019) |
| Pending migrations execute normally | **PASS** (MIG-RUNNER-015) |
| Failed SQL rollback | **PASS** (MIG-RUNNER-008/009) |
| Later migration blocking | **PASS** (MIG-RUNNER-004/016) |
| Validate history before executing pending | **PASS** (MIG-RUNNER-016) |
| MIG-RUNNER-001..019 | **PASS** |
| MIG-CONSTRAINT-001..002 | **PASS** |
| MIG-KEY-001..010 | **PASS** |
| MIG-RBAC-001..006 | **PASS** |
| MOVE-RBAC-001..008 | **PASS** |
| Role-key invariant (≤48) | **PASS** (0 rows) |
| Tenant-role invariant | **PASS** (0 rows) |
| Role key uniqueness | **PASS** (0 duplicates) |
| Backend build | **PASS** |
| Frontend build | **PASS** |
| Integration tests | **PASS** |
| Security tests | **PASS** |

*(Not §39 gate items:* Docker compose structure = VALID (needs deploy-time
`.env.production` for interpolation); **Nginx `-t` = NOT VERIFIED** (nginx not
installed in sandbox); **Tauri native build = NOT VERIFIED** (browser is the
shipped client). None is a §39 gate condition and none was changed.)*

## Actual test counts (re-run this cycle, not carried over)

```
Backend tests (unit)
Passed:  81   Failed: 0   Skipped: 0

Frontend tests
Passed:  16   Failed: 0   Skipped: 0

Integration tests (all *.itest.ts, real PostgreSQL 16)
Passed:  74   Failed: 0   Skipped: 0     (deterministic across repeated runs)

Migration tests (migrate.itest.ts 19 + roleMigration 3 + roleKeyLength 6)
Passed:  28   Failed: 0   Skipped: 0

Security tests (RBAC/tenant/session/auth/ssh/crypto — integration + unit subset)
Passed:  93   Failed: 0   Skipped: 0
```
New this cycle: MIG-RUNNER-011..019 in `src/migrate.itest.ts`.

## §38 — Mandatory demonstration (real runner, real DB)

```
Database:   001_first, 002_second, 003_unknown_change
Repository: 001_first, 002_second

$ node dist/migrate.js up      (via tsx)
MigrationCollisionError: Unknown applied migration detected.

Version: 3
Database migration: 3_unknown_change
Repository status: missing

The database records a migration this repository does not contain — the deployed
code is older than, or divergent from, the database schema. Migration execution
has been stopped. …
EXIT CODE = 1

After:  schema_migrations = 1_first, 2_second, 3_unknown_change   (UNCHANGED)
        no pending migration executed
```
→ `ERROR: unknown applied migration 003_unknown_change`, `process exit != 0`, no
pending migration executed, deployment/server does not continue. No secrets in
the output (only version numbers and migration names are logged).

## §32 — Database evidence (main DB, migrated through 026)

```sql
SELECT COUNT(*) FROM roles WHERE char_length(key) > 48;                      -- 0
SELECT COUNT(*) FROM users u JOIN roles r ON r.key=u.role
  WHERE r.is_builtin=FALSE AND u.company_id IS DISTINCT FROM r.company_id;   -- 0
SELECT key, COUNT(*) FROM roles GROUP BY key HAVING COUNT(*)>1;              -- 0 rows
```

## §37 — Code evidence: AWM-MIG-005 — FIXED

- **Finding:** the runner validated only **repo → DB** (a repository migration
  recorded under a different name). It never validated **DB → repo**, so a
  database containing an applied migration the codebase does not know about — DB
  ahead of code, wrong branch, stale artifact, rolled-back image, a removed
  historical migration, or a manually-applied migration — was not detected:
  `pending = []`, the runner exited 0, and the app started against an unknown
  schema. A non-contiguous history (an earlier migration unrecorded while a later
  one is applied) was also undetected and would have run the missing migration
  out of order.
- **Root cause:** history verification was one-directional and computed `pending`
  without first proving history integrity.
- **Affected file:** `backend/src/migrate.ts`.
- **Old behavior:** Direction A only (repo→DB name mismatch); no DB→repo check; no
  contiguity check.
- **New behavior — validation runs before computing/running any pending migration
  (§18 order):**
  1. discover repo migrations; reject duplicate repo versions (existing).
  2. load DB history.
  3. **Direction A** (existing): a repository migration recorded under a different
     name → `MigrationCollisionError`.
  4. **Direction B** (new): every applied DB migration must exist in the
     repository; an applied migration absent from the repo →
     `MigrationCollisionError("Unknown applied migration detected …")`.
  5. **Contiguity** (new): the applied history must be an exact PREFIX of the
     repository's ordered versions — every repo migration at or below the highest
     applied version must itself be applied; a gap →
     `MigrationCollisionError("Migration history gap detected …")`.
  6. only then compute `pending` and execute.
  Every failure throws before any migration runs → non-zero exit → deploy gate
  (`migrate up || exit 1`) stops the server; `schema_migrations` and the schema
  are left untouched; **no automatic repair**; no secrets logged.
- **Allowed state (still passes):** applied DB history == an exact known prefix of
  the repository, with additional pending migrations = a normal upgrade
  (MIG-RUNNER-013/015).
- **Tests added:** `src/migrate.itest.ts` MIG-RUNNER-011..019 (subprocess + real PG).
- **Test commands:**
  `DATABASE_URL=… npx tsx --test src/migrate.itest.ts`
  `DATABASE_URL=… npx tsx --test 'src/**/*.itest.ts'`
- **Actual results:** MIG-RUNNER-001..019 + MIG-CONSTRAINT-001..002 = 19/19 PASS;
  full integration 74/74; §38 demonstration exits non-zero with no pending
  executed and `schema_migrations` unchanged.
- **Remaining risk:** no per-migration **checksum**, so an edit to an
  already-applied file (same version+name) is still undetected — see below.

## §24 — Checksum residual risk (P3, documented, not implemented)

`schema_migrations` stores `version, name, applied_at` — **no checksum**. History
identity is `version + name`, so the SQL body of an already-applied migration
could change without detection if version and name stay the same. Adding a
checksum column would touch every environment's history table and backfill
existing rows, which is beyond this focused fix.

```
Residual risk:
applied migration SQL can change without detection if version/name remain unchanged
```

**Recommended future model:** `version, name, checksum, applied_at`, verifying the
stored checksum of every already-applied migration on each run and failing closed
on mismatch — extending the AWM-MIG-005 fail-closed posture from identity drift to
content drift. Severity P3 (no evidence of active impact).

## §26 — Preserved migration controls (regression-tested green)

Same version/different name → FAIL (MIG-RUNNER-001/017); duplicate repository
versions → FAIL (MIG-RUNNER-006/018); failed SQL rolls back and is not recorded
(MIG-RUNNER-008/009); later migrations blocked after failure/collision
(MIG-RUNNER-004/016); record only after SQL success; deterministic numeric
ordering (MIG-RUNNER-007); `roles_key_len_chk` scoped to `roles`
(MIG-CONSTRAINT-001/002); role keys ≤ 48 (MIG-KEY, invariant 0). AWM-MIG-001/002,
SEC-020, RBAC ceiling, tenant isolation, sharing, logout, refresh, WebSocket auth,
HttpOnly cookie — all covered by the 81 unit + 74 integration suite that passes in
full.

## Findings

```
P0 remaining: 0
P1 remaining: 0
P2 remaining: 0
P3 remaining: 0   (migration checksum is a documented future recommendation, not an open defect)

Fixed:            AWM-MIG-005 (bidirectional history validation + contiguity, fail-closed)
Partially fixed:  none
Unresolved:       none
False positives:  none
Not verified:     nginx -t (not installed), Tauri native build (not the shipped client) — neither a §39 gate nor a mandatory migration/security test
```

---

## Decision

# APPROVED FOR PRODUCTION

**P0 = 0, P1 = 0.** AWM-MIG-005 is FIXED: migration history is now validated in
both directions before any pending migration executes. A database migration
absent from the repository (unknown / DB-ahead / removed / manually-applied) and a
non-contiguous history both **fail closed** — the runner throws before executing
anything, exits non-zero, leaves `schema_migrations` and the schema untouched,
blocks all pending migrations, and (via the deploy-gate command) stops the server
from starting. Normal upgrades (repository ahead of an exact DB prefix) still pass.

MIG-RUNNER-001..019, MIG-CONSTRAINT-001..002, MIG-KEY-001..010, MIG-RBAC-001..006,
and MOVE-RBAC-001..008 all PASS. Role keys > 48 = 0, tenant custom-role violations
= 0, duplicate role keys = 0. Backend and frontend builds pass; integration and
security suites pass in full against a real PostgreSQL 16. **No mandatory test is
failing, skipped, or not-verified.** The only residual is a recommendation-only
migration-checksum enhancement (§24), which is not a §39 gate condition.

> Awamer can no longer start against a database whose applied migration history is
> unknown, newer, divergent, or incomplete relative to the deployed repository.
> Migration history is validated in both directions before any pending migration
> executes.
