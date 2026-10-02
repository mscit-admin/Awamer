# Database Privilege Matrix

## Identities before this phase (as found)

| Component | Identity | Privilege |
|---|---|---|
| Migrations (run inside the backend container at start) | `POSTGRES_USER` | **SUPERUSER** (official image) |
| Backend runtime | `POSTGRES_USER` | **SUPERUSER** |
| vpn-helper (auth-verify; the URL is also written into the helper's `verify.sh`) | `POSTGRES_USER` | **SUPERUSER** |
| Backups (`backup.sh`, `pg_dump`) | `POSTGRES_USER` | SUPERUSER (appropriate for a full dump) |
| Tests / CI | dedicated test DB user | superuser (test only) |

## Identities after this phase

| DB Identity | Purpose | SELECT | INSERT | UPDATE | DELETE | DDL | Superuser |
|---|---|---:|---:|---:|---:|---:|---:|
| `POSTGRES_USER` (cluster admin) | `db-provision` job + backups/restore only; given to **no long-running service** | all | all | all | all | YES | YES (image bootstrap role) |
| `awamer_migrator` | Schema owner; the one-shot `migrate` job only | owns all 28 tables | ✓ | ✓ | ✓ | **YES** (owner, `CREATE` on schema `public`) | **NO** |
| `awamer_app` | Backend runtime | 27 tables (all except `schema_migrations`) | 27 | 27 | 27 | **NO** | **NO** |
| `awamer_vpn_auth` | vpn-helper auth-verify | **4 columns** of `vpn_server_clients` only | NO | NO | NO | **NO** | **NO** |

All three `awamer_*` roles are `NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`. `awamer_app` and `awamer_vpn_auth` are additionally `NOINHERIT` with connection limits of 100 and 20.

## Exact grants (from `deploy/db/provision-roles.sh` + migration `029`)

```sql
REVOKE ALL ON DATABASE <db> FROM PUBLIC;
GRANT CONNECT ON DATABASE <db> TO awamer_migrator, awamer_app, awamer_vpn_auth;
GRANT TEMPORARY ON DATABASE <db> TO awamer_migrator;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO awamer_migrator;
GRANT USAGE ON SCHEMA public TO awamer_app, awamer_vpn_auth;
-- ownership of every existing table/sequence/view in public → awamer_migrator (upgrade path)
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO awamer_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO awamer_app;        -- BIGSERIAL defaults
ALTER DEFAULT PRIVILEGES FOR ROLE awamer_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO awamer_app;            -- future migrations
ALTER DEFAULT PRIVILEGES FOR ROLE awamer_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO awamer_app;
REVOKE ALL ON public.schema_migrations FROM awamer_app;                    -- also in migration 029
GRANT SELECT (server_id, username, password_hash, revoked)
  ON public.vpn_server_clients TO awamer_vpn_auth;                         -- also in migration 029
CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- installed by the admin so the non-superuser migrator never needs it
```

The app needs no `TRUNCATE`, `REFERENCES` or `TRIGGER`. Foreign-key checks run as the table owner, and `pg_advisory_xact_lock` needs no grant.

## Catalog evidence

Queried live from the production-mode smoke database, `awamer_smoke`, after provisioning and migration:

```
rolname        |super|createrole|createdb|bypassrls|replication|inherit|connlimit
awamer_app     | f   | f        | f      | f       | f         | f     | 100
awamer_migrator| f   | f        | f      | f       | f         | t     | -1
awamer_vpn_auth| f   | f        | f      | f       | f         | f     | 20

awamer_app      DELETE/INSERT/SELECT/UPDATE on 27 tables;  USAGE on 6 sequences
awamer_vpn_auth vpn_server_clients: password_hash:SELECT, revoked:SELECT, server_id:SELECT, username:SELECT
public tables: 28, owned by awamer_migrator: 28
app reads schema_migrations: f | app CREATE on schema: f | migrator CREATE on schema: t | PUBLIC CONNECT: f
```

## Deployment sequence and migration safety

The compose services start in this order:

```
postgres (healthy) → db-provision (one-shot, cluster admin) → migrate (one-shot, awamer_migrator) → auth-service (awamer_app)
```

Each step depends on the previous one via `service_completed_successfully`.

- **No silent fallback.**
  - The backend's `DATABASE_URL` is the `awamer_app` URL; `MIGRATION_DATABASE_URL` does not exist.
  - The migrate job receives only the migrator URL, not the full app config. `migrate.ts` no longer requires the JWT secrets, encryption key or bootstrap password.
  - At startup the backend inspects its role (`backend/src/db/runtimeRole.ts`). In production it **refuses to start** if the role is SUPERUSER, CREATEROLE, CREATEDB, BYPASSRLS or REPLICATION, owns schema objects (the migration owner), or can CREATE in the schema.
  - `DB_ALLOW_PRIVILEGED_RUNTIME=true` is an explicit emergency override, logged as an error on every start and never set by the installer. It is absent from `.env.production` and the compose contract test forbids it.
- **Missing credentials fail clearly.** Compose `${AWAMER_*_DB_PASSWORD:?…}` fails before start. The provisioning script refuses passwords that are missing, shorter than 24 characters, identical to each other, or `CHANGE_ME` placeholders.
- **Upgrade path.** On existing installs, objects created by the superuser are handed to `awamer_migrator`. The installer appends any missing role password to `.env.production`; the value is generated and never printed.
- **Backup / restore.** Dumps are `--no-owner --no-acl`, so `restore.sh` re-runs `db-provision` and `migrate` before starting the backend, then checks `/readyz`.

## Tests executed (real PostgreSQL 16) — `backend/src/db/leastPrivilege.itest.ts`

| ID | Verifies | Result |
|---|---|---|
| DBLP-001 | Provisioning rejects short, identical and placeholder passwords; never echoes passwords; creates non-superuser roles | PASS |
| DBLP-002 | Fresh install: all migrations apply as the **non-superuser** migrator; it owns every object | PASS |
| DBLP-003 | `awamer_app`: DML, BIGSERIAL and `gen_random_uuid()` work. `CREATE TABLE`, `DROP`, `ALTER`, `TRUNCATE`, `CREATE ROLE/DATABASE` and `schema_migrations` access are denied; a non-owner `GRANT` grants nothing | PASS |
| DBLP-004 | `awamer_vpn_auth`: runs the exact auth-verify query; `SELECT *`, other tables, `UPDATE` and `INSERT` are denied | PASS |
| DBLP-005 | Runtime guard: app passes; migrator and superuser are refused in production; dev only warns; the override is honoured | PASS |
| DBLP-006 | Upgrade: a superuser-migrated schema is transferred; the migrator can roll a migration down and up; provisioning is idempotent | PASS |
| DBLP-007 | Backup (`--no-owner --no-acl`) → restore: the app is **denied** until re-provisioned, then reads the restored data and passes the guard | PASS |

**Production-mode startup checks** (built `dist/server.js`, `APP_ENV=production`):

| `DATABASE_URL` | Result |
|---|---|
| superuser | exit 1, "Refusing to start: … over-privileged" |
| `awamer_migrator` | exit 1, same message |
| `awamer_app` | started; logged `database runtime role is least-privilege` |

Compose contract tests COMPOSE-DB-001…003 cover the static configuration.
