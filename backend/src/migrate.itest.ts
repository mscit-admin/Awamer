/**
 * AWM-MIG-003 / AWM-MIG-004 — migration-runner fail-closed behaviour and the
 * roles-scoped ceiling constraint. Runs against a real PostgreSQL, driving the
 * ACTUAL runner as a subprocess (`tsx src/migrate.ts up`) so exit codes and
 * deployment gating are exercised for real. MIG-RUNNER-001..010,
 * MIG-CONSTRAINT-001..002.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { dbSkip, DATABASE_URL, recreateDatabase, dropDatabaseQuiet } from "./test/db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.resolve(__dirname, ".."); // .../backend
const REAL_MIGRATIONS = path.join(BACKEND, "migrations");
const MIG026 = fs.readFileSync(path.join(REAL_MIGRATIONS, "026_scope_role_key_constraint.up.sql"), "utf8");
const RUNNERDB = "awamer_runnertest";

let admin: Pool;
let runnerUrl = "";
let tmpRoot = "";

function migrateEnv(migrationsDir: string): NodeJS.ProcessEnv {
  return { ...process.env, DATABASE_URL: runnerUrl, MIGRATIONS_DIR: migrationsDir, LOG_LEVEL: "error" };
}
/** Drive the real runner as a subprocess; returns exit status + captured output. */
function runMigrate(migrationsDir: string): { status: number | null; out: string } {
  const r = spawnSync("npx", ["tsx", "src/migrate.ts", "up"], {
    cwd: BACKEND, env: migrateEnv(migrationsDir), encoding: "utf8",
  });
  return { status: r.status, out: `${r.stdout ?? ""}\n${r.stderr ?? ""}` };
}
/** The production deployment gate: migrate, and only start the server if it succeeded. */
function runDeployGate(migrationsDir: string): { status: number | null; out: string } {
  const r = spawnSync("sh", ["-c", "npx tsx src/migrate.ts up || exit 1 ; echo SERVER_WOULD_START"], {
    cwd: BACKEND, env: migrateEnv(migrationsDir), encoding: "utf8",
  });
  return { status: r.status, out: `${r.stdout ?? ""}\n${r.stderr ?? ""}` };
}

async function q<T extends import("pg").QueryResultRow = import("pg").QueryResultRow>(sql: string, params: unknown[] = []) {
  const p = new Pool({ connectionString: runnerUrl });
  p.on("error", () => {});
  try { return await p.query<T>(sql, params); } finally { await p.end().catch(() => {}); }
}
const migRows = async () =>
  (await q<{ version: string; name: string }>(`SELECT version::text version, name FROM schema_migrations ORDER BY version`)).rows;
const tableExists = async (name: string) =>
  (await q<{ e: boolean }>(`SELECT to_regclass($1) IS NOT NULL AS e`, [`public.${name}`])).rows[0]!.e;
const constraintOn = async (conname: string) =>
  (await q<{ rel: string }>(`SELECT conrelid::regclass::text rel FROM pg_constraint WHERE conname=$1`, [conname])).rows.map((r) => r.rel);

/** Build a throwaway migrations directory with the given {filename: sql} files. */
function mkMigDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(tmpRoot, "mig-"));
  for (const [name, sql] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), sql);
  return dir;
}

// Synthetic migrations — the runner logic is generic, so tiny marker migrations
// exercise it faithfully and fast, matching the task's 025/026/027 scenarios.
const M = {
  first_up: "CREATE TABLE mr_first (id int);",
  first_down: "DROP TABLE IF EXISTS mr_first;",
  second_up: "CREATE TABLE mr_second (id int);",
  second_down: "DROP TABLE IF EXISTS mr_second;",
};

before(async () => {
  if (dbSkip) return;
  const base = new URL(DATABASE_URL);
  runnerUrl = `${base.protocol}//${base.username}:${base.password}@${base.host}/${RUNNERDB}`;
  const adminUrl = `${base.protocol}//${base.username}:${base.password}@${base.host}/postgres`;
  admin = new Pool({ connectionString: adminUrl });
  admin.on("error", () => {});
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "awamer-migtests-"));
});

after(async () => {
  if (dbSkip) return;
  if (admin) await dropDatabaseQuiet(admin, RUNNERDB);
  await admin?.end().catch(() => {});
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// MIG-RUNNER — the runner driven for real
// ---------------------------------------------------------------------------

test("MIG-RUNNER-003: a normal pending migration executes exactly once", { skip: dbSkip }, async () => {
  await recreateDatabase(admin, RUNNERDB);
  const dir = mkMigDir({
    "001_first.up.sql": M.first_up, "001_first.down.sql": M.first_down,
    "002_second.up.sql": M.second_up, "002_second.down.sql": M.second_down,
  });
  const r1 = runMigrate(dir);
  assert.equal(r1.status, 0, r1.out);
  assert.deepEqual(await migRows(), [{ version: "1", name: "first" }, { version: "2", name: "second" }]);
  assert.equal(await tableExists("mr_first"), true);
  assert.equal(await tableExists("mr_second"), true);

  // Second run: nothing pending, no re-execution, no error.
  const r2 = runMigrate(dir);
  assert.equal(r2.status, 0, r2.out);
  assert.deepEqual(await migRows(), [{ version: "1", name: "first" }, { version: "2", name: "second" }]);
});

test("MIG-RUNNER-002: a matching already-applied migration is a clean no-op", { skip: dbSkip }, async () => {
  await recreateDatabase(admin, RUNNERDB);
  const dir = mkMigDir({ "001_first.up.sql": M.first_up, "001_first.down.sql": M.first_down });
  assert.equal(runMigrate(dir).status, 0);
  const before = await migRows();
  const r = runMigrate(dir);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(await migRows(), before, "no re-execution, no change");
});

test("MIG-RUNNER-001: DB records a DIFFERENT name at a version → FAIL, migration not executed", { skip: dbSkip }, async () => {
  await recreateDatabase(admin, RUNNERDB);
  // Apply only 001, then plant a foreign migration record at version 2.
  const only1 = mkMigDir({ "001_first.up.sql": M.first_up, "001_first.down.sql": M.first_down });
  assert.equal(runMigrate(only1).status, 0);
  await q(`INSERT INTO schema_migrations (version, name) VALUES (2, 'another_branch_change')`);

  const full = mkMigDir({
    "001_first.up.sql": M.first_up, "001_first.down.sql": M.first_down,
    "002_second.up.sql": M.second_up, "002_second.down.sql": M.second_down,
  });
  const r = runMigrate(full);
  assert.notEqual(r.status, 0, "runner must exit non-zero");
  assert.match(r.out, /collision/i);
  assert.match(r.out, /another_branch_change/);
  assert.match(r.out, /second/);
  // 002_second NOT executed; schema_migrations unchanged (foreign row intact).
  assert.equal(await tableExists("mr_second"), false, "the repository migration was NOT executed");
  assert.deepEqual(await migRows(), [{ version: "1", name: "first" }, { version: "2", name: "another_branch_change" }]);
});

test("MIG-RUNNER-004/005: a collision blocks ALL later migrations and leaves no partial state", { skip: dbSkip }, async () => {
  await recreateDatabase(admin, RUNNERDB);
  const only1 = mkMigDir({ "001_first.up.sql": M.first_up, "001_first.down.sql": M.first_down });
  assert.equal(runMigrate(only1).status, 0);
  await q(`INSERT INTO schema_migrations (version, name) VALUES (2, 'other_migration')`);

  const dir = mkMigDir({
    "001_first.up.sql": M.first_up, "001_first.down.sql": M.first_down,
    "002_security_fix.up.sql": "CREATE TABLE mr_sec (id int);", "002_security_fix.down.sql": "DROP TABLE IF EXISTS mr_sec;",
    "003_feature.up.sql": "CREATE TABLE mr_f3 (id int);", "003_feature.down.sql": "DROP TABLE IF EXISTS mr_f3;",
    "004_feature.up.sql": "CREATE TABLE mr_f4 (id int);", "004_feature.down.sql": "DROP TABLE IF EXISTS mr_f4;",
  });
  const r = runMigrate(dir);
  assert.notEqual(r.status, 0, "collision must fail");
  // Later migrations 003/004 must NOT run; 002 (colliding) must NOT run.
  assert.equal(await tableExists("mr_sec"), false);
  assert.equal(await tableExists("mr_f3"), false);
  assert.equal(await tableExists("mr_f4"), false);
  // No partial state: schema_migrations unchanged.
  assert.deepEqual(await migRows(), [{ version: "1", name: "first" }, { version: "2", name: "other_migration" }]);
});

test("MIG-RUNNER-006: duplicate numeric version in the repository → FAIL before executing either", { skip: dbSkip }, async () => {
  await recreateDatabase(admin, RUNNERDB);
  const dir = mkMigDir({
    "001_first.up.sql": M.first_up, "001_first.down.sql": M.first_down,
    "002_security_fix.up.sql": "CREATE TABLE mr_dup_a (id int);",
    "002_other_fix.up.sql": "CREATE TABLE mr_dup_b (id int);",
  });
  const r = runMigrate(dir);
  assert.notEqual(r.status, 0, "duplicate source version must fail");
  assert.match(r.out, /[Dd]uplicate migration version/);
  assert.match(r.out, /security_fix/);
  assert.match(r.out, /other_fix/);
  // Neither migration (not even 001) executed — we fail during discovery.
  assert.equal(await tableExists("mr_first"), false);
  assert.equal(await tableExists("mr_dup_a"), false);
  assert.equal(await tableExists("mr_dup_b"), false);
  assert.deepEqual(await migRows(), [], "schema_migrations has no rows");
});

test("MIG-RUNNER-007: migrations execute in deterministic numeric order", { skip: dbSkip }, async () => {
  await recreateDatabase(admin, RUNNERDB);
  // 002 depends on the table 001 creates; wrong order would fail outright.
  const dir = mkMigDir({
    "001_first.up.sql": "CREATE TABLE mr_ord (n int);", "001_first.down.sql": "DROP TABLE IF EXISTS mr_ord;",
    "002_second.up.sql": "INSERT INTO mr_ord (n) VALUES (2);", "002_second.down.sql": "SELECT 1;",
    "003_third.up.sql": "INSERT INTO mr_ord (n) VALUES (3);", "003_third.down.sql": "SELECT 1;",
  });
  const r = runMigrate(dir);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual((await migRows()).map((m) => m.version), ["1", "2", "3"], "recorded in numeric order");
  const ns = (await q<{ n: number }>(`SELECT n FROM mr_ord ORDER BY n`)).rows.map((x) => x.n);
  assert.deepEqual(ns, [2, 3]);
});

test("MIG-RUNNER-008/009: a failing SQL migration rolls back, is not recorded, and blocks later ones", { skip: dbSkip }, async () => {
  await recreateDatabase(admin, RUNNERDB);
  const dir = mkMigDir({
    "001_first.up.sql": M.first_up, "001_first.down.sql": M.first_down,
    // Creates a table THEN errors — proves the whole tx rolls back.
    "002_bad.up.sql": "CREATE TABLE mr_bad (id int); SELECT 1/0;", "002_bad.down.sql": "SELECT 1;",
    "003_after.up.sql": "CREATE TABLE mr_after (id int);", "003_after.down.sql": "DROP TABLE IF EXISTS mr_after;",
  });
  const r = runMigrate(dir);
  assert.notEqual(r.status, 0, "failed SQL must exit non-zero");
  assert.equal(await tableExists("mr_first"), true, "the successful earlier migration stays applied");
  assert.equal(await tableExists("mr_bad"), false, "failed migration's partial change rolled back");
  assert.equal(await tableExists("mr_after"), false, "later migration NOT executed");
  // Recorded only after success: 002 is absent; 001 present.
  assert.deepEqual(await migRows(), [{ version: "1", name: "first" }], "failed migration NOT recorded");
});

test("MIG-RUNNER-010: the deployment gate stops the server on collision", { skip: dbSkip }, async () => {
  await recreateDatabase(admin, RUNNERDB);
  const only1 = mkMigDir({ "001_first.up.sql": M.first_up, "001_first.down.sql": M.first_down });
  assert.equal(runMigrate(only1).status, 0);
  await q(`INSERT INTO schema_migrations (version, name) VALUES (2, 'other_migration')`);
  const dir = mkMigDir({
    "001_first.up.sql": M.first_up, "001_first.down.sql": M.first_down,
    "002_second.up.sql": M.second_up, "002_second.down.sql": M.second_down,
  });
  const r = runDeployGate(dir);
  assert.notEqual(r.status, 0, "deploy command must fail on collision");
  assert.doesNotMatch(r.out, /SERVER_WOULD_START/, "the server start step must NOT run after a failed migration");
});

// ---------------------------------------------------------------------------
// MIG-CONSTRAINT — AWM-MIG-004, roles-scoped ceiling constraint (migration 026)
// ---------------------------------------------------------------------------

/** Migrate the real chain fully onto a fresh RUNNERDB. */
function realMigrate(): void {
  const r = runMigrate(REAL_MIGRATIONS);
  assert.equal(r.status, 0, `real migration chain must apply: ${r.out}`);
}

test("MIG-CONSTRAINT-001: a same-named constraint on ANOTHER table does not hide a missing roles constraint", { skip: dbSkip }, async () => {
  await recreateDatabase(admin, RUNNERDB);
  realMigrate();
  // Simulate the pathological pre-026 state: roles LACKS the ceiling constraint,
  // but a DIFFERENT table carries a constraint of the same name.
  await q(`ALTER TABLE roles DROP CONSTRAINT roles_key_len_chk`);
  await q(`CREATE TABLE mr_decoy (k text, CONSTRAINT roles_key_len_chk CHECK (char_length(k) <= 10))`);
  assert.deepEqual((await constraintOn("roles_key_len_chk")).sort(), ["mr_decoy"], "only the decoy carries the name");

  // The scoped migration must recognise roles is missing it and add it to roles.
  await q(MIG026);
  assert.deepEqual((await constraintOn("roles_key_len_chk")).sort(), ["mr_decoy", "roles"], "roles now carries its own constraint");
  // And it actually enforces the ceiling on roles.
  await assert.rejects(
    () => q(`INSERT INTO roles (key,name,permissions,is_builtin) VALUES ($1,'x',ARRAY[]::text[],FALSE)`, ["z".repeat(49)]),
    /roles_key_len_chk|check constraint/i,
  );
});

test("MIG-CONSTRAINT-002: when roles already has the constraint, the migration adds no duplicate", { skip: dbSkip }, async () => {
  await recreateDatabase(admin, RUNNERDB);
  realMigrate();
  // After the real chain, roles already carries roles_key_len_chk (25/26).
  const rels = await q<{ n: string }>(`SELECT COUNT(*)::text n FROM pg_constraint WHERE conname='roles_key_len_chk' AND conrelid='roles'::regclass`);
  assert.equal(rels.rows[0]!.n, "1");
  await q(MIG026); // run the scoped ensure again
  const after = await q<{ n: string }>(`SELECT COUNT(*)::text n FROM pg_constraint WHERE conname='roles_key_len_chk' AND conrelid='roles'::regclass`);
  assert.equal(after.rows[0]!.n, "1", "no duplicate constraint on roles");
});
