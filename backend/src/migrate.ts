/**
 * Lightweight Postgres migration runner.
 *
 * Looks at backend/migrations/*.up.sql files (numeric prefix order) and
 * applies any whose version isn't yet recorded in `schema_migrations`.
 * Down migrations follow the same naming with `.down.sql`.
 *
 * No external migrations library — keeps the dependency surface small.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "./config/index.js";
import { createPool } from "./db/index.js";
import { createLogger } from "./logger/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface Migration {
  version: number;
  name: string;
  // `undefined` = the corresponding file was NOT discovered on disk; a string
  // (even empty) = the file exists and was read. This distinction is required:
  // an empty string must never stand in for a missing .up.sql (AWM-MIG-006).
  up?: string;
  down?: string;
  // The raw, zero-padded version prefix as written in the filename (e.g. "026"),
  // used only to name files accurately in error messages.
  raw: string;
}

/**
 * Fail-closed migration error (AWM-MIG-003). Thrown when the database and the
 * repository disagree about migration history, or the repository itself carries
 * two different migrations at one version. It propagates to the top-level
 * handler, which exits non-zero — stopping deployment/startup rather than
 * silently skipping a migration. Carries no secrets (no DATABASE_URL/tokens).
 */
export class MigrationCollisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationCollisionError";
  }
}

/**
 * Fail-closed artifact error (AWM-MIG-006). Thrown when the migration files
 * themselves are incomplete for the requested operation — a required `.up.sql`
 * is missing or contains no executable SQL, or a `.down.sql` needed for a
 * rollback is missing/empty. The release artifact must be corrected; the runner
 * never synthesises SQL, records an empty migration, or continues. Exits
 * non-zero. Carries no secrets.
 */
export class MigrationArtifactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationArtifactError";
  }
}

/**
 * Conservative "does this SQL contain an executable statement?" check. Strips
 * block comments, line comments and whitespace; anything left counts as
 * executable content. This intentionally does NOT parse SQL — it only tells a
 * file that is purely whitespace/comments (no statement) apart from a real
 * migration, so legitimate SQL that merely BEGINS with comments stays valid.
 */
export function hasExecutableSql(sql: string): boolean {
  const stripped = sql
    .replace(/\/\*[\s\S]*?\*\//g, " ") // block comments
    .replace(/--[^\n]*/g, " ") // line comments
    .trim();
  return stripped.length > 0;
}

async function loadMigrations(dir: string): Promise<Migration[]> {
  const entries = await fs.readdir(dir);
  const map = new Map<number, Migration>();
  // Track the DISTINCT migration names seen at each numeric version, and the
  // files that produced them, so we can reject two different migrations that
  // share one number (the up/down pair of ONE migration shares its name, so
  // only distinct names collide). Detection must not depend on read order.
  const namesByVersion = new Map<number, Set<string>>();
  const filesByVersion = new Map<number, string[]>();

  for (const file of entries) {
    const m = /^(\d+)_(.+)\.(up|down)\.sql$/.exec(file);
    if (!m) continue;
    const [, vStr, name, direction] = m;
    if (!vStr || !name || !direction) continue;
    const version = Number(vStr);
    const sql = await fs.readFile(path.join(dir, file), "utf8");
    // Note: `up`/`down` start undefined and are only set when the actual file is
    // read, so a missing file stays undefined (never a stand-in empty string).
    const existing: Migration = map.get(version) ?? { version, name, raw: vStr };
    if (direction === "up") existing.up = sql;
    else existing.down = sql;
    existing.name = name;
    map.set(version, existing);

    let names = namesByVersion.get(version);
    if (!names) { names = new Set(); namesByVersion.set(version, names); }
    names.add(name);
    let files = filesByVersion.get(version);
    if (!files) { files = []; filesByVersion.set(version, files); }
    files.push(file);
  }

  // Repo-vs-repo collision (AWM-MIG-003, §11): a numeric version must map to
  // exactly one migration. Fail before executing anything.
  for (const [version, names] of namesByVersion) {
    if (names.size > 1) {
      const files = [...(filesByVersion.get(version) ?? [])].sort().join(", ");
      throw new MigrationCollisionError(
        `Duplicate migration version detected in the repository.\n\n` +
          `Version: ${version}\n` +
          `Conflicting migrations: ${[...names].sort().join(", ")}\n` +
          `Files: ${files}\n\n` +
          `A numeric migration version must identify exactly one migration. ` +
          `Renumber one of these migrations to a free version before retrying.`,
      );
    }
  }

  // Per-version artifact validation (AWM-MIG-006): every migration MUST ship a
  // real .up.sql file whose body contains executable SQL. A missing .up.sql
  // (e.g. only a .down.sql was shipped) or one that is only whitespace/comments
  // must NEVER be treated as an empty, already-satisfied migration and recorded
  // as applied without running any SQL. This runs during discovery — before DB
  // history validation and before any transaction opens — so an incomplete
  // release artifact fails closed with the schema and schema_migrations intact.
  // (.down.sql is optional — Option A; a missing/empty down is enforced only
  // when a rollback actually needs it, in the down path below.)
  for (const mig of map.values()) {
    if (mig.up === undefined) {
      throw new MigrationArtifactError(
        `Invalid migration artifact.\n\n` +
          `Version: ${mig.version}\n` +
          `Migration: ${mig.name}\n` +
          `Missing required file: ${mig.raw}_${mig.name}.up.sql\n\n` +
          `Migration execution has been stopped. Every migration must ship a ` +
          `real .up.sql file — the release artifact is incomplete. Restore the ` +
          `missing file before retrying (no automatic repair is performed).`,
      );
    }
    if (!hasExecutableSql(mig.up)) {
      throw new MigrationArtifactError(
        `Invalid migration artifact.\n\n` +
          `Version: ${mig.version}\n` +
          `Migration: ${mig.name}\n` +
          `File without executable SQL: ${mig.raw}_${mig.name}.up.sql\n\n` +
          `The .up.sql file contains only whitespace/comments. Migration ` +
          `execution has been stopped — an empty migration must not be recorded ` +
          `as applied. Add the intended SQL before retrying (no automatic repair).`,
      );
    }
  }

  return [...map.values()].sort((a, b) => a.version - b.version);
}

async function ensureTable(pool: import("pg").Pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version BIGINT PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function appliedMap(pool: import("pg").Pool): Promise<Map<number, string>> {
  const { rows } = await pool.query<{ version: string; name: string }>(
    `SELECT version::text AS version, name FROM schema_migrations`,
  );
  return new Map(rows.map((r) => [Number(r.version), r.name]));
}

/**
 * DB-LEAST-PRIVILEGE: the migration job needs ONLY its database connection —
 * deliberately not the full application config (JWT secrets, the credential
 * encryption key, the bootstrap password …). In production DATABASE_URL here is
 * the schema owner (awamer_migrator); the backend runtime uses a separate,
 * DML-only role and never runs migrations itself.
 */
function migrationConfig(): Config {
  const env = process.env;
  const url = (env.DATABASE_URL ?? "").trim();
  if (!url) throw new Error("Invalid configuration:\n  DATABASE_URL: Required (the migration owner's connection)");
  const appEnv = env.APP_ENV === "production" || env.APP_ENV === "staging" ? env.APP_ENV : "development";
  const levels = ["fatal", "error", "warn", "info", "debug", "trace"];
  const level = levels.includes(env.LOG_LEVEL ?? "") ? env.LOG_LEVEL! : "info";
  return {
    isProd: appEnv === "production",
    env: { DATABASE_URL: url, DATABASE_MAX_CONNS: 2, APP_ENV: appEnv, LOG_LEVEL: level },
  } as unknown as Config;
}

async function migrate(direction: "up" | "down") {
  const cfg = migrationConfig();
  const log = createLogger(cfg);
  const pool = await createPool(cfg, log);
  await ensureTable(pool);

  const dir = process.env.MIGRATIONS_DIR ?? path.resolve(__dirname, "..", "migrations");
  log.info({ dir, direction }, "running migrations");
  const migrations = await loadMigrations(dir);
  const appliedNames = await appliedMap(pool);
  const applied = new Set(appliedNames.keys());

  // Fail-closed collision guard (AWM-MIG-003): the runner tracks by version
  // NUMBER only, so a version recorded under a DIFFERENT name than the
  // repository's file at that number means the database and the code disagree
  // about migration history. Treating it as "already applied" would silently
  // SKIP the repository migration while still running later ones — the exact
  // defect this closes. Stop before executing ANYTHING (both up and down) and
  // require explicit human resolution; never auto-repair the recorded history.
  // This runs before the pending filter and the apply loop, so on a collision
  // schema_migrations and the schema are left untouched (no partial state).
  const repoByVersion = new Map(migrations.map((m) => [m.version, m.name]));

  // Direction A (AWM-MIG-003): a REPOSITORY migration recorded in the database
  // under a DIFFERENT name at its version. Treating it as applied would skip the
  // repository migration while still running later ones.
  for (const m of migrations) {
    const recorded = appliedNames.get(m.version);
    if (recorded !== undefined && recorded !== m.name) {
      log.error(
        { version: m.version, databaseName: recorded, repositoryName: m.name },
        "migration version collision — database and repository disagree; execution stopped",
      );
      throw new MigrationCollisionError(
        `Migration version collision detected.\n\n` +
          `Version: ${m.version}\n` +
          `Database migration: ${m.version}_${recorded}\n` +
          `Repository migration: ${m.version}_${m.name}\n\n` +
          `Migration execution has been stopped to prevent an inconsistent ` +
          `schema. The database records a different migration at this version ` +
          `than the repository provides. Resolve the migration-history ` +
          `conflict before retrying — no automatic repair is performed.`,
      );
    }
  }

  // Direction B (AWM-MIG-005): every APPLIED migration must exist in the
  // repository. A recorded migration this checkout does not contain means the
  // database is ahead of / divergent from the deployed code (rolled-back image,
  // wrong branch, stale artifact, removed or manually-applied migration). The
  // running code must never start against a schema it does not fully know.
  for (const [version, dbName] of appliedNames) {
    if (!repoByVersion.has(version)) {
      log.error(
        { version, databaseName: dbName },
        "applied migration absent from repository — database is ahead of/divergent from code; execution stopped",
      );
      throw new MigrationCollisionError(
        `Unknown applied migration detected.\n\n` +
          `Version: ${version}\n` +
          `Database migration: ${version}_${dbName}\n` +
          `Repository status: missing\n\n` +
          `The database records a migration this repository does not contain — the ` +
          `deployed code is older than, or divergent from, the database schema. ` +
          `Migration execution has been stopped. Restore the correct application ` +
          `version/repository or explicitly reconcile migration history before ` +
          `deploying — no automatic repair is performed.`,
      );
    }
  }

  // Contiguity (AWM-MIG-005): the applied history must be an exact PREFIX of the
  // repository's ordered migrations — every repository migration at or below the
  // highest applied version must itself be applied. A missing intermediate
  // migration while a later one is applied is a broken, non-contiguous history
  // that must NOT be "filled in" by running the missing migration out of order.
  if (appliedNames.size > 0) {
    const maxApplied = Math.max(...appliedNames.keys());
    for (const m of migrations) {
      if (m.version <= maxApplied && !applied.has(m.version)) {
        log.error(
          { missingVersion: m.version, highestApplied: maxApplied },
          "migration history gap — an earlier migration is unrecorded while a later one is applied; execution stopped",
        );
        throw new MigrationCollisionError(
          `Migration history gap detected.\n\n` +
            `Missing applied migration: ${m.version}_${m.name}\n` +
            `Highest applied version: ${maxApplied}\n\n` +
            `A later migration is recorded as applied while this earlier migration ` +
            `is not — the database migration history is non-contiguous and cannot ` +
            `be safely reconciled by running the missing migration out of order. ` +
            `Restore the correct application version/repository or reconcile the ` +
            `migration history before retrying — no automatic repair is performed.`,
        );
      }
    }
  }

  if (direction === "up") {
    const pending = migrations.filter((m) => !applied.has(m.version));
    if (pending.length === 0) {
      log.info("no pending migrations");
    }
    for (const m of pending) {
      // Guaranteed present + non-empty by loadMigrations' artifact validation;
      // this guard keeps the type honest and is a defensive second line so an
      // empty query can never be recorded as an applied migration.
      if (m.up === undefined || !hasExecutableSql(m.up)) {
        throw new MigrationArtifactError(
          `Invalid migration artifact.\n\nVersion: ${m.version}\nMigration: ${m.name}\n` +
            `Missing or empty required file: ${m.raw}_${m.name}.up.sql\n\n` +
            `Migration execution has been stopped before recording it as applied.`,
        );
      }
      log.info({ version: m.version, name: m.name }, "applying migration");
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        await c.query(m.up);
        await c.query(`INSERT INTO schema_migrations (version, name) VALUES ($1, $2)`, [m.version, m.name]);
        await c.query("COMMIT");
      } catch (e) {
        await c.query("ROLLBACK");
        log.error({ err: e, version: m.version }, "migration failed");
        throw e;
      } finally {
        c.release();
      }
    }
  } else {
    // down: roll back the highest applied
    const reversed = [...migrations].reverse();
    const target = reversed.find((m) => applied.has(m.version));
    if (!target) {
      log.info("nothing to roll back");
    } else {
      // Option A: .down.sql is optional. A rollback that needs a down file which
      // is missing or contains no executable SQL fails CLEARLY (never runs an
      // empty query and then deletes the history row, which would record a
      // rollback that did not revert anything).
      if (target.down === undefined || !hasExecutableSql(target.down)) {
        log.error({ version: target.version, name: target.name }, "no down migration available; rollback stopped");
        throw new MigrationArtifactError(
          `No down migration exists for ${target.raw}_${target.name}.\n\n` +
            `This migration ships no reversible .down.sql (or it contains no ` +
            `executable SQL), so it cannot be rolled back automatically. Roll back ` +
            `manually or restore from a backup — the runner will not execute an ` +
            `empty rollback or record a revert that did nothing.`,
        );
      }
      log.info({ version: target.version, name: target.name }, "reverting migration");
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        await c.query(target.down);
        await c.query(`DELETE FROM schema_migrations WHERE version = $1`, [target.version]);
        await c.query("COMMIT");
      } catch (e) {
        await c.query("ROLLBACK");
        throw e;
      } finally {
        c.release();
      }
    }
  }

  await pool.end();
  log.info("migrations complete");
}

const direction = (process.argv[2] ?? "up") as "up" | "down";
migrate(direction).catch((err) => {
  console.error(err);
  process.exit(1);
});
