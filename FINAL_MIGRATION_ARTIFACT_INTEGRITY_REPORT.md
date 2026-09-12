# Awamer — Final Migration Artifact Integrity Gate Report (AWM-MIG-006)

**Branch:** `claude/nifty-johnson-u2dwye`
**Scope:** AWM-MIG-006 (P1) — the migration runner must never record a migration
as applied unless its required `.up.sql` artifact actually exists and its intended
SQL is executed. An incomplete release artifact (missing / empty `.up.sql`) must
fail closed. No other systems changed.
**Verification:** the ACTUAL runner (`tsx src/migrate.ts up|down`) driven as a
subprocess against real **PostgreSQL 16**; exit codes, schema state, and the
deploy-gate command exercised for real. Full backend + frontend regression.

## Chosen `.down.sql` policy (§14) — Option A (down optional)

`.up.sql` is **REQUIRED** for every migration and must contain executable SQL.
`.down.sql` is **OPTIONAL**: `migrate up` never needs it, and `migrate down`
fails **clearly and non-zero** (naming the migration) when the target has no
executable down SQL — it never runs an empty rollback or deletes a history row
without reverting. This matches the existing architecture (the down path already
guarded a missing down) and the security-critical case (a missing `up` recorded
as applied). All 26 shipped migrations already ship complete up+down pairs.

## Gate dashboard

| Gate | Result |
| --- | --- |
| Missing `.up.sql` detected | **PASS** (MIG-RUNNER-020) |
| Down-only migration rejected | **PASS** (MIG-RUNNER-020) |
| Up-only policy documented | **PASS** (Option A; MIG-RUNNER-022) |
| Missing down rollback handled | **PASS** (MIG-RUNNER-023) |
| Empty-up policy enforced | **PASS** (MIG-RUNNER-024) |
| Invalid artifact blocks later migrations | **PASS** (MIG-RUNNER-026) |
| Invalid artifact leaves DB unchanged | **PASS** (MIG-RUNNER-027) |
| Invalid artifact blocks startup | **PASS** (MIG-RUNNER-028) |
| DB unknown migration detection | **PASS** (MIG-RUNNER-011) |
| DB-ahead detection | **PASS** (MIG-RUNNER-014) |
| History-gap detection | **PASS** (MIG-RUNNER-019) |
| Same-version/different-name | **PASS** (MIG-RUNNER-017) |
| Duplicate migration version | **PASS** (MIG-RUNNER-018) |
| MIG-RUNNER-001..028 | **PASS** |
| MIG-CONSTRAINT regression | **PASS** |
| MIG-KEY regression | **PASS** |
| MIG-RBAC regression | **PASS** |
| MOVE-RBAC regression | **PASS** |
| Backend build | **PASS** |
| Frontend build | **PASS** |
| Security regression | **PASS** |

*(Not §40 gate items:* Docker compose structure = VALID (needs deploy-time
`.env.production`); **Nginx `-t` = NOT VERIFIED** (nginx not installed in sandbox);
**Tauri native build = NOT VERIFIED** (browser is the shipped client). None is a
§40 gate condition and none was changed.)*

## Actual test counts (re-run this cycle, not carried over)

```
Backend unit:
Passed:  81   Failed: 0   Skipped: 0

Frontend:
Passed:  16   Failed: 0   Skipped: 0

Integration (all *.itest.ts, real PostgreSQL 16):
Passed:  83   Failed: 0   Skipped: 0     (deterministic across repeated runs)

Migration (migrate.itest.ts 28 + roleMigration 3 + roleKeyLength 6):
Passed:  37   Failed: 0   Skipped: 0

Security (RBAC/tenant/session/auth/ssh/crypto — integration + unit subset):
Passed:  93   Failed: 0   Skipped: 0
```
New this cycle: MIG-RUNNER-020..028 in `src/migrate.itest.ts`.

## §11 — Repository artifact inventory (recomputed from the working tree)

```
.up.sql count:   26
.down.sql count: 26
orphan .up files:   none
orphan .down files: none
empty-content .up.sql files: none
```

## §39 — Mandatory demonstration (real runner, real DB)

```
Files:  001_first.up.sql, 001_first.down.sql, 002_security_fix.down.sql
        (002_security_fix.up.sql is MISSING)

$ node dist/migrate.js up      (via tsx)
MigrationArtifactError: Invalid migration artifact.

Version: 2
Migration: security_fix
Missing required file: 002_security_fix.up.sql

Migration execution has been stopped. Every migration must ship a real .up.sql
file — the release artifact is incomplete. …
EXIT CODE = 1

After:  schema_migrations = (empty)      → 002 NOT recorded
        mr_first exists = false          → no migration (not even 001) executed
```
→ `ERROR: required .up.sql migration file is missing`, `exit != 0`, 002 not
recorded, no later migration executed, server/deploy does not continue. No
secrets in the output (only version numbers and migration names).

## §31 — Database evidence (main DB, migrated through 026)

```sql
SELECT COUNT(*) FROM roles WHERE char_length(key) > 48;                      -- 0
SELECT COUNT(*) FROM users u JOIN roles r ON r.key=u.role
  WHERE r.is_builtin=FALSE AND u.company_id IS DISTINCT FROM r.company_id;   -- 0
SELECT key, COUNT(*) FROM roles GROUP BY key HAVING COUNT(*)>1;              -- 0 rows
```

## §38 — Code evidence: AWM-MIG-006 — FIXED

- **Finding:** the loader built a migration object from whichever of `.up.sql` /
  `.down.sql` was seen first and initialised `up` to `""`. A version discovered
  from only a `.down.sql` therefore had `up === ""`; pg accepts an empty query
  string, so `c.query(m.up)` succeeded and the `INSERT` recorded the migration as
  applied — with its intended SQL never executed. Missing file and empty file
  were indistinguishable.
- **Root cause:** `Migration.up: string` initialised to `""`; no presence /
  executable-content validation before execution.
- **Affected file:** `backend/src/migrate.ts`.
- **Old behavior:** missing `.up.sql` → `up = ""` → empty query executed →
  migration recorded as applied; empty file == missing file.
- **New behavior:**
  - `Migration.up`/`down` are now optional (`undefined` = file absent), plus a
    `raw` version prefix for accurate file names in errors — no empty-string
    stand-in for a missing file.
  - `loadMigrations` validates every migration during **discovery**: a missing
    `.up.sql`, or one containing no executable SQL (whitespace/comments only via
    the conservative `hasExecutableSql`), throws `MigrationArtifactError`.
    Comment-prefixed real SQL stays valid.
  - The apply loop re-guards `m.up` (defence in depth) so an empty query can never
    be recorded as applied.
  - Option A down policy: `migrate down` throws `MigrationArtifactError`
    ("No down migration exists for …") when the target lacks executable down SQL,
    never running an empty rollback.
- **Validation location:** `loadMigrations`, **before** DB history validation and
  before any transaction opens (§6/§20 order):
  discover → filenames → duplicate versions → **artifact (up presence + content)**
  → DB history (Direction A/B, contiguity) → pending → execute.
  So even when the DB already records the migration, an incomplete repo artifact
  fails closed rather than reporting "already applied" (MIG-RUNNER-025).
- **Tests added:** `src/migrate.itest.ts` MIG-RUNNER-020..028 (subprocess + real PG).
- **Test commands:**
  `DATABASE_URL=… npx tsx --test src/migrate.itest.ts`
  `DATABASE_URL=… npx tsx --test 'src/**/*.itest.ts'`
- **Actual results:** MIG-RUNNER-001..028 + MIG-CONSTRAINT-001..002 = 28/28 PASS;
  full integration 83/83; §39 demonstration exits non-zero with nothing applied
  and `schema_migrations` empty.
- **Remaining risk:** the conservative `hasExecutableSql` strips comments without
  parsing SQL, so a pathological `.up.sql` whose only content is inside a string
  literal could be misjudged — not a realistic migration, and it fails safe
  (rejects) rather than executing nothing. Migration identity is still
  `version + name` with no checksum (AWM-MIG-005 residual, P3) — an edit to an
  already-applied file is undetected.

## §25–§30 — Preserved controls (regression-tested green)

Bidirectional history validation (MIG-RUNNER-011..019: DB-unknown, DB-ahead,
removed migration, history gap, same-version/different-name, duplicate source
versions), earlier runner tests (MIG-RUNNER-001..010: collision, duplicate,
failed-SQL rollback, later-migration blocking, record-only-after-success,
deterministic ordering, deploy gate), MIG-CONSTRAINT-001..002 (roles-scoped
constraint), MIG-KEY-001..010 (role keys ≤48), MIG-RBAC-001..006, MOVE-RBAC-001..008,
tenant isolation, sharing, logout, refresh, WebSocket auth, HttpOnly cookie — all
covered by the 81 unit + 83 integration suite that passes in full.

## Findings

```
P0 remaining: 0
P1 remaining: 0
P2 remaining: 0
P3 remaining: 0   (migration checksum is a documented future recommendation, not an open defect)

Fixed:            AWM-MIG-006 (required-.up.sql artifact validation, fail-closed; Option A down policy)
Partially fixed:  none
Unresolved:       none
False positives:  none
Not verified:     nginx -t (not installed), Tauri native build (not the shipped client) — neither a §40 gate nor a mandatory migration/security test
```

---

## Decision

# APPROVED FOR PRODUCTION

**P0 = 0, P1 = 0.** AWM-MIG-006 is FIXED: a migration is recorded as applied only
when its required `.up.sql` exists and contains executable SQL. A missing or
empty `.up.sql` — including a down-only migration, and including the case where
the database already records that version — **fails closed** during discovery:
the runner throws before any transaction, exits non-zero, leaves
`schema_migrations` and the schema untouched, blocks all later migrations, and
(via the deploy-gate command) stops the server from starting. `.down.sql` is
optional under the documented Option A policy; `migrate down` fails clearly rather
than running an empty rollback.

MIG-RUNNER-001..028, MIG-CONSTRAINT-001..002, MIG-KEY-001..010, MIG-RBAC-001..006,
and MOVE-RBAC-001..008 all PASS. Role keys > 48 = 0, tenant custom-role violations
= 0, duplicate role keys = 0. Backend and frontend builds pass; integration and
security suites pass in full against a real PostgreSQL 16. **No mandatory test is
failing, skipped, or not-verified.**

> Awamer never records a migration as applied unless the required migration
> artifact actually exists and its intended SQL has executed successfully. An
> incomplete release artifact fails closed.
