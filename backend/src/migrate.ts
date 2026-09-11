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
import { loadConfig } from "./config/index.js";
import { createPool } from "./db/index.js";
import { createLogger } from "./logger/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface Migration {
  version: number;
  name: string;
  up: string;
  down?: string;
}

async function loadMigrations(dir: string): Promise<Migration[]> {
  const entries = await fs.readdir(dir);
  const map = new Map<number, Migration>();

  for (const file of entries) {
    const m = /^(\d+)_(.+)\.(up|down)\.sql$/.exec(file);
    if (!m) continue;
    const [, vStr, name, direction] = m;
    if (!vStr || !name || !direction) continue;
    const version = Number(vStr);
    const sql = await fs.readFile(path.join(dir, file), "utf8");
    const existing: Migration = map.get(version) ?? { version, name, up: "" };
    if (direction === "up") existing.up = sql;
    else existing.down = sql;
    existing.name = name;
    map.set(version, existing);
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

async function migrate(direction: "up" | "down") {
  const cfg = loadConfig();
  const log = createLogger(cfg);
  const pool = await createPool(cfg, log);
  await ensureTable(pool);

  const dir = process.env.MIGRATIONS_DIR ?? path.resolve(__dirname, "..", "migrations");
  log.info({ dir, direction }, "running migrations");
  const migrations = await loadMigrations(dir);
  const appliedNames = await appliedMap(pool);
  const applied = new Set(appliedNames.keys());

  // Collision guard: the runner tracks by version NUMBER only, so if a version
  // was already recorded by a DIFFERENT migration (e.g. two branches both used
  // number 020), this branch's file at that number is silently skipped — which
  // previously left a schema change unapplied. Surface it loudly instead.
  for (const m of migrations) {
    const recorded = appliedNames.get(m.version);
    if (recorded !== undefined && recorded !== m.name) {
      log.warn(
        { version: m.version, recordedName: recorded, fileName: m.name },
        "migration version already applied under a DIFFERENT name — this file will NOT run (number collision); renumber the new migration to a free version",
      );
    }
  }

  if (direction === "up") {
    const pending = migrations.filter((m) => !applied.has(m.version));
    if (pending.length === 0) {
      log.info("no pending migrations");
    }
    for (const m of pending) {
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
      if (!target.down) {
        log.error({ version: target.version }, "no down migration available");
        throw new Error("no down migration");
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
