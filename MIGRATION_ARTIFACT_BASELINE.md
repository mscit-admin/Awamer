# Migration Artifact Baseline — AWM-MIG-006

**Branch:** `claude/nifty-johnson-u2dwye` · **Head at baseline:** `cf40c57`
**Purpose:** document the migration loader's *actual* handling of `.up.sql` /
`.down.sql` presence before adding artifact validation, and confirm the finding.

## Files inspected: `backend/src/migrate.ts`

- **Filename parser** (loadMigrations): `/^(\d+)_(.+)\.(up|down)\.sql$/` →
  `version` (Number), `name`, `direction`. Non-matching files ignored.
- **Discovery / map construction** (the defect):
  ```ts
  const existing: Migration = map.get(version) ?? { version, name, up: "" };
  if (direction === "up") existing.up = sql;
  else existing.down = sql;
  ```
  A migration object is created from **whichever file is seen first** — `up` or
  `down`. `Migration.up` is typed `string` and **initialised to `""`**. So a
  version discovered from only a `.down.sql` file yields
  `{ version, name, up: "", down: "<sql>" }`. There is **no way to distinguish**
  "no `.up.sql` file" from "an `.up.sql` file that is empty" — both are `up === ""`.
- **Duplicate-version validation** (AWM-MIG-003): distinct names per version →
  throw `MigrationCollisionError`. ✔ present.
- **History validation** (AWM-MIG-003/005): Direction A (repo→DB name mismatch),
  Direction B (applied migration absent from repo), contiguity (prefix) — all
  throw before computing pending. ✔ present.
- **Pending calc:** `migrations.filter(m => !applied.has(m.version))`.
- **Up execution:**
  ```ts
  await c.query("BEGIN");
  await c.query(m.up);                       // <- m.up can be "" (empty query)
  await c.query(`INSERT INTO schema_migrations (version, name) VALUES ($1,$2)`, [m.version, m.name]);
  await c.query("COMMIT");
  ```
  PostgreSQL **accepts an empty query string without error**, so `c.query("")`
  succeeds and the `INSERT` records the migration as applied. Result: a
  **down-only migration is recorded as applied while its intended SQL never
  ran** — the AWM-MIG-006 defect.
- **schema_migrations insert timing:** inside the same transaction as the SQL,
  after it — so recording is atomic with the (empty) SQL. Correct in principle,
  but with an empty `up` the "SQL" is a no-op.
- **Down execution:** `if (!target.down) throw new Error("no down migration")`.
  A missing `.down.sql` (now `undefined`) already fails on `migrate down`; but
  because `up` was initialised to `""`, a missing `.up.sql` did **not** fail.
- **Startup / deployment:** `server.ts` does not run migrations; the production
  container runs `node dist/migrate.js up || exit 1 ; exec server.js`, so a
  non-zero migrate exit stops the server. `migrate.ts` bottom:
  `migrate(dir).catch(err => { console.error(err); process.exit(1); })`.

## Empty-query confirmation

`SELECT ''::text;`-style probing is unnecessary — pg's protocol treats an empty
query string as a valid no-op command (`emptyQuery`), returning no error. So the
`await c.query(m.up)` with `m.up === ""` succeeds and execution proceeds to the
`INSERT`. Confirmed by the driver's documented behaviour and reproduced during
implementation testing (MIG-RUNNER-020).

## §11 — Current repository artifact inventory (recomputed from the working tree)

```
.up.sql count:   26
.down.sql count: 26
orphan .up files:   none
orphan .down files: none
empty-content .up.sql files: none
```
All 26 migrations (001–026) ship a complete, non-empty `.up.sql` + `.down.sql`
pair. (Independent review's "26/26" is confirmed against the current tree.)

## Confirmed finding

- **AWM-MIG-006 (P1):** the loader represents a **missing `.up.sql`** as an empty
  `up` string, which pg executes as a no-op, so the runner records the migration
  as applied without running any SQL. It also cannot distinguish a missing file
  from an empty file. → must fail closed when a required `.up.sql` is absent or
  contains no executable SQL, **before** touching the database.

## Chosen policy (§14) — recommendation to implement

- **`.up.sql` is REQUIRED** for every migration; missing or empty-of-executable-SQL
  → fail closed (artifact error), before DB history validation and before any
  transaction.
- **`.down.sql` is OPTIONAL (Option A)** — the existing architecture already
  tolerates a missing down on `up` and fails explicitly on `down`
  (`throw "no down migration"`); this matches real irreversible-migration needs.
  `migrate down` must fail clearly (non-zero, named migration) when the target
  migration has no executable down SQL, and must **never execute an empty query**.
  Rationale: the `up` path never needs the down file; the security-critical case
  is the missing `up`. This keeps the patch minimal and matches current behaviour.
- **Data-model change:** make `up`/`down` optional (`undefined` = file absent),
  removing the empty-string ambiguity; validate presence + executable content
  explicitly.
