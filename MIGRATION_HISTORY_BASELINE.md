# Migration History Baseline — AWM-MIG-005

**Branch:** `claude/nifty-johnson-u2dwye` · **Head at baseline:** `37ffc8c`
**Purpose:** document the migration runner's *actual* history-validation behaviour
before adding bidirectional verification, and confirm the finding.

## Files inspected

- `backend/src/migrate.ts` — the runner.
- `backend/migrations/NNN_*.{up,down}.sql` — migration files (001–026, contiguous).
- `backend/src/server.ts` / `db/readiness.ts` — startup does not run migrations;
  `/readyz` is a `SELECT 1` connectivity probe only.
- `deploy/docker-compose.production.yml` — migrations run in the auth-service
  container command (`node dist/migrate.js up || exit 1 ; … exec server.js`).
- `backend/src/migrate.itest.ts` — existing runner test harness (subprocess + real PG).

## `schema_migrations`

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    BIGINT PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)
```
- `appliedMap()` reads `version, name` → `Map<number, name>`. Name is stored
  **without** the numeric prefix or `.up.sql` suffix (e.g. `shorten_role_keys`),
  matching the parser's capture group. No checksum column.
- DB history is **not** sorted/normalized on read; it is a plain map. The runner
  computes `applied = new Set(appliedNames.keys())` (version numbers only).

## Current validation (migrate.ts)

Order today:
1. `loadMigrations(dir)` — discovers repo migrations; **rejects duplicate repo
   versions** (AWM-MIG-003, throws `MigrationCollisionError`).
2. `appliedMap()` — loads DB history.
3. **Direction A only** — for every *repository* migration, if the DB recorded a
   *different name* at that version → throw (AWM-MIG-003). This is repo→DB.
4. `pending = migrations.filter(m => !applied.has(m.version))` — compute pending.
5. Apply each pending migration in its own transaction (record only after the
   SQL commits).

## The gap (AWM-MIG-005) — CONFIRMED

The runner validates **repo → DB** but not **DB → repo**. It never iterates the
DB history to ask "does every applied migration still exist in the repository?"
Consequences, none of which are currently detected:

| State | Today | Should be |
| --- | --- | --- |
| DB has an applied migration ABSENT from repo (e.g. DB `027_x`, repo max `026`) | Direction A never iterates v27 → `pending=[]` → **exit 0, server starts** | FAIL |
| DB ahead of repo (DB `001..004`, repo `001..003`) | same as above → **exit 0** | FAIL |
| Removed historical migration (DB `001,002,003`; repo `001,003`) | Direction A matches 001/003; v2 in DB not iterated → **exit 0** | FAIL |
| History gap (DB `001,003`; repo `001,002,003`) | Direction A matches 001/003; v2 is *pending* → **runner would run 002 out of order** | FAIL |
| Same version / different name (DB `025_old`, repo `025_new`) | Direction A → FAIL ✔ | FAIL (already) |
| Duplicate repo version (`025_a`,`025_b`) | loadMigrations → FAIL ✔ | FAIL (already) |

So the database can contain an applied migration the codebase does not know
about, and the app starts anyway — the AWM-MIG-005 finding.

## Startup / deployment

- `server.ts` does not run migrations. The production gate is the container
  command `node dist/migrate.js up || exit 1 ; exec server.js` — a non-zero
  migrate exit stops the server. So the fix only needs the runner to **throw →
  exit non-zero** on the divergent-history cases above.
- `migrate.ts` bottom: `migrate(dir).catch(err => { console.error(err); process.exit(1); })`.

## Required security model (target)

Validate history in BOTH directions, and in this order, **before computing or
running any pending migration**:
1. discover repo migrations; reject repo duplicates (exists).
2. load DB history.
3. Direction A: repo migration recorded under a different name → FAIL (exists).
4. Direction B: an applied DB migration absent from repo → FAIL (**new**).
5. Contiguity: applied history must be an exact PREFIX of the repo's ordered
   versions — every repo migration at or below the highest applied version must
   itself be applied; a gap → FAIL (**new**).
6. only then compute pending and execute.

The allowed state: **applied DB history == an exact known prefix of the
repository history**, where the repository may hold additional *pending*
migrations (normal upgrade).

## Migration model note (contiguity)

Migrations are authored and applied in strict numeric order, each building on the
prior schema; there is no evidence or policy that non-contiguous application is
intentional. A recorded gap therefore indicates broken history and must fail
closed (per §22/§23), not be silently "filled in".

## Residual (checksum) — out of scope, documented

`schema_migrations` stores `version, name, applied_at` but **no checksum**, so an
edit to an already-applied migration file (same version+name) is not detected.
This cycle does not add a checksum column (would touch every environment's
history table). Recorded as **P3 residual risk**; recommended future model:
`version, name, checksum, applied_at`, verified fail-closed on mismatch.
