# Migration Runner Baseline — AWM-MIG-003 / AWM-MIG-004

**Branch:** `claude/nifty-johnson-u2dwye` · **Head at baseline:** `7f610b0`
**Purpose:** document the migration runner's *actual* behaviour before any change,
verifying the two confirmed findings.

## Files inspected

- `backend/src/migrate.ts` — the runner (discovery, collision guard, apply, record).
- `backend/migrations/NNN_*.{up,down}.sql` — migration files.
- `backend/src/server.ts` — does **not** run migrations; only serves `/readyz`.
- `backend/src/db/readiness.ts` — `/readyz` probe.
- `deploy/docker-compose.production.yml` — how migrations run in production.

## 1. Migration discovery (`loadMigrations`, migrate.ts:27-45)

- Reads `backend/migrations` (or `MIGRATIONS_DIR`).
- Filename parser: `/^(\d+)_(.+)\.(up|down)\.sql$/` → `version` (Number), `name`,
  `direction`. Non-matching files are ignored.
- Stores migrations in a `Map<number, Migration>` **keyed by version only**.
  For each file it does `map.get(version) ?? { version, name, up: "" }`, sets
  `up`/`down`, and `existing.name = name`.
- **Ordering:** `[...map.values()].sort((a,b) => a.version - b.version)` — strict
  numeric ascending. Deterministic, independent of filesystem read order.

### Defect surface (AWM-MIG-003, repo-vs-repo — §11)
Because the map is keyed by version alone and `existing.name = name` overwrites,
**two different files at the same version silently merge**: e.g. `025_a.up.sql`
and `025_b.up.sql` collapse into one entry whose `up`/`name` is whichever file
was read last. No error. Filesystem-order dependent.

## 2. `schema_migrations` (ensureTable, migrate.ts:47-55)

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    BIGINT PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)
```
- `version` is the PRIMARY KEY → the DB can hold **at most one** row per version,
  but that row's `name` may be **any** migration that happened to claim the number
  first (e.g. from another branch). There is **no checksum** column.

## 3. Applied set + collision guard (migrate.ts:57-88)

- `appliedMap()` → `Map<number, name>` of recorded rows.
- `applied = new Set(appliedNames.keys())` — **version numbers only**.
- Collision guard (the confirmed defect, AWM-MIG-003 db-vs-repo — §3-6):
  ```ts
  for (const m of migrations) {
    const recorded = appliedNames.get(m.version);
    if (recorded !== undefined && recorded !== m.name) {
      log.warn({ version, recordedName: recorded, fileName: m.name }, "…will NOT run…");
    }
  }
  ```
  It **detects** a version recorded under a different name but only `log.warn`s.

## 4. Apply / skip logic (migrate.ts:90-110)

```ts
const pending = migrations.filter((m) => !applied.has(m.version));
```
- A version already present in `schema_migrations` is treated as applied **even
  if the recorded name differs** from the repository file. → the repository
  migration at that version is **silently skipped**, and later migrations still
  run. **This is AWM-MIG-003.**
- Each pending migration runs in its own transaction:
  `BEGIN; <up sql>; INSERT INTO schema_migrations(version,name); COMMIT;`
  On error: `ROLLBACK` + `log.error` + `throw` → propagates.
- **Transactional & atomic:** the `INSERT` into `schema_migrations` is inside the
  same transaction as the migration SQL, so a migration is recorded **only after**
  its SQL commits. A failing migration rolls back both the schema change and the
  record. ✔ (relevant to MIG-RUNNER-008/009).

## 5. Process exit (migrate.ts:142-147)

```ts
migrate(direction).catch((err) => { console.error(err); process.exit(1); });
```
Any thrown error → **non-zero exit**. Today the collision path never throws, so
the runner exits **0** despite a skipped migration.

## 6. Startup / deployment architecture (§21)

- `server.ts` does **not** run migrations. `/readyz` (`readiness.ts`) only does a
  `SELECT 1` connectivity probe — it does **not** assert migration completeness.
- Production (`deploy/docker-compose.production.yml:162-168`) runs migrations as
  part of the **auth-service container command**, before the server:
  ```sh
  node /app/dist/migrate.js up || exit 1 ;
  echo 'Starting server...' &&
  exec node --enable-source-maps /app/dist/server.js
  ```
  `migrate.js up` exiting non-zero → `|| exit 1` aborts the container command →
  `server.js` is **never exec'd** → the container is unhealthy → rollout stops.
  **So the deployment gate is correct *provided* the runner exits non-zero on a
  collision.** Today it exits 0, so the server starts with a missing migration.

## 7. Migration-file audit (§34)

| Version | Name | Duplicate? | up/down |
| --- | --- | --- | --- |
| 001 | auth | no | both |
| 002 | sessions | no | both |
| … | … | no | both |
| 023 | tenant_scope_shared_fix | no | both |
| 024 | fix_cross_tenant_roles | no | both |
| 025 | shorten_role_keys | no | both |

001–025 contiguous, every version has exactly one name and a matched up/down
pair. No duplicate numeric versions, no gaps, no orphan up/down files. (Note: a
prior real incident had production record version **20** as `vpn_server_internet`
from another branch while this branch's `020_tenant_scope_shared` differed — the
exact db-vs-repo collision AWM-MIG-003 addresses; it was healed by idempotent
`023`.)

## 8. AWM-MIG-004 — constraint check scope (25_shorten_role_keys.up.sql)

The `025` guard is:
```sql
IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'roles_key_len_chk') THEN
  ALTER TABLE roles ADD CONSTRAINT roles_key_len_chk CHECK (char_length(key) <= 48);
END IF;
```
`conname` is **not unique across relations/schemas** — a constraint of the same
name on a *different* table would make the guard skip adding it to `roles`,
leaving `roles` without its intended ceiling constraint. The check must be scoped
with `conrelid = 'roles'::regclass` (schema-qualified as needed). Low severity
(P3): in a normal environment no other table carries that name, so `025` adds the
constraint to `roles` correctly — this is defence-in-depth. **`025` is a shipped
migration and is left untouched**; a new migration will ensure the correctly
*scoped* constraint on `roles`.

## Confirmed findings

- **AWM-MIG-003 (P1):** db-vs-repo version/name mismatch only warns; the
  repository migration is skipped and later migrations still run; runner exits 0;
  deployment proceeds with a missing migration. Repo-vs-repo duplicate versions
  silently merge. → must **fail closed** (throw, non-zero exit, before any
  migration runs) for both cases.
- **AWM-MIG-004 (P3):** `roles_key_len_chk` existence check is not scoped to the
  `roles` relation. → scope it via `conrelid`.

## Current schema (public)

Application uses the default `public` schema (no `search_path` override; tables
created unqualified). Constraint scoping will use `'roles'::regclass`, which
resolves through `search_path` to `public.roles` in this deployment.
