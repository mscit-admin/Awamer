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
/** Drive `migrate down` as a subprocess (rollback of the highest applied). */
function runMigrateDown(migrationsDir: string): { status: number | null; out: string } {
  const r = spawnSync("npx", ["tsx", "src/migrate.ts", "down"], {
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
// MIG-RUNNER-011..019 — bidirectional migration-history validation (AWM-MIG-005)
// ---------------------------------------------------------------------------

// Reusable synthetic migrations that create/track their own marker tables.
const mig = (marker: string) => ({
  up: `CREATE TABLE ${marker} (id int);`, down: `DROP TABLE IF EXISTS ${marker};`,
});
const one = mig("mr_one"), two = mig("mr_two"), three = mig("mr_three"), four = mig("mr_four");

test("MIG-RUNNER-011: DB contains a migration ABSENT from the repository → FAIL (unknown)", { skip: dbSkip }, async () => {
  await recreateDatabase(admin, RUNNERDB);
  const full = mkMigDir({
    "001_first.up.sql": one.up, "001_first.down.sql": one.down,
    "002_second.up.sql": two.up, "002_second.down.sql": two.down,
    "003_unknown_branch_change.up.sql": three.up, "003_unknown_branch_change.down.sql": three.down,
  });
  assert.equal(runMigrate(full).status, 0);
  const before = await migRows();
  const repo = mkMigDir({
    "001_first.up.sql": one.up, "001_first.down.sql": one.down,
    "002_second.up.sql": two.up, "002_second.down.sql": two.down,
  });
  const r = runMigrate(repo);
  assert.notEqual(r.status, 0, "must exit non-zero");
  assert.match(r.out, /[Uu]nknown applied migration/);
  assert.match(r.out, /3_unknown_branch_change/);
  assert.deepEqual(await migRows(), before, "schema_migrations unchanged");
});

test("MIG-RUNNER-012: a removed historical migration is detected even when later ones match → FAIL", { skip: dbSkip }, async () => {
  await recreateDatabase(admin, RUNNERDB);
  const full = mkMigDir({
    "001_first.up.sql": one.up, "001_first.down.sql": one.down,
    "002_old_security_fix.up.sql": two.up, "002_old_security_fix.down.sql": two.down,
    "003_third.up.sql": three.up, "003_third.down.sql": three.down,
  });
  assert.equal(runMigrate(full).status, 0);
  const repo = mkMigDir({
    "001_first.up.sql": one.up, "001_first.down.sql": one.down,
    "003_third.up.sql": three.up, "003_third.down.sql": three.down,
  });
  const r = runMigrate(repo);
  assert.notEqual(r.status, 0, "must fail — the removed migration 002 is still recorded");
  assert.match(r.out, /[Uu]nknown applied migration/);
  assert.match(r.out, /2_old_security_fix/);
});

test("MIG-RUNNER-013: exact history match → PASS, no re-execution, no false collision", { skip: dbSkip }, async () => {
  await recreateDatabase(admin, RUNNERDB);
  const dir = mkMigDir({
    "001_first.up.sql": one.up, "001_first.down.sql": one.down,
    "002_second.up.sql": two.up, "002_second.down.sql": two.down,
    "003_third.up.sql": three.up, "003_third.down.sql": three.down,
  });
  assert.equal(runMigrate(dir).status, 0);
  const before = await migRows();
  const r = runMigrate(dir);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(await migRows(), before, "no re-execution, no false collision");
});

test("MIG-RUNNER-014: database ahead of repository → FAIL", { skip: dbSkip }, async () => {
  await recreateDatabase(admin, RUNNERDB);
  const full = mkMigDir({
    "001_first.up.sql": one.up, "001_first.down.sql": one.down,
    "002_second.up.sql": two.up, "002_second.down.sql": two.down,
    "003_third.up.sql": three.up, "003_third.down.sql": three.down,
    "004_fourth.up.sql": four.up, "004_fourth.down.sql": four.down,
  });
  assert.equal(runMigrate(full).status, 0);
  const repo = mkMigDir({
    "001_first.up.sql": one.up, "001_first.down.sql": one.down,
    "002_second.up.sql": two.up, "002_second.down.sql": two.down,
    "003_third.up.sql": three.up, "003_third.down.sql": three.down,
  });
  const r = runMigrate(repo);
  assert.notEqual(r.status, 0, "code behind DB must fail");
  assert.match(r.out, /[Uu]nknown applied migration/);
  assert.match(r.out, /4_fourth/);
});

test("MIG-RUNNER-015: repository ahead of database (normal upgrade) → PASS", { skip: dbSkip }, async () => {
  await recreateDatabase(admin, RUNNERDB);
  const base = mkMigDir({
    "001_first.up.sql": one.up, "001_first.down.sql": one.down,
    "002_second.up.sql": two.up, "002_second.down.sql": two.down,
  });
  assert.equal(runMigrate(base).status, 0);
  const repo = mkMigDir({
    "001_first.up.sql": one.up, "001_first.down.sql": one.down,
    "002_second.up.sql": two.up, "002_second.down.sql": two.down,
    "003_third.up.sql": three.up, "003_third.down.sql": three.down,
    "004_fourth.up.sql": four.up, "004_fourth.down.sql": four.down,
  });
  const r = runMigrate(repo);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual((await migRows()).map((m) => m.version), ["1", "2", "3", "4"]);
  assert.equal(await tableExists("mr_three"), true);
  assert.equal(await tableExists("mr_four"), true);
});

test("MIG-RUNNER-016: an unknown DB migration blocks a pending repo migration (validate before executing)", { skip: dbSkip }, async () => {
  await recreateDatabase(admin, RUNNERDB);
  const base = mkMigDir({
    "001_first.up.sql": one.up, "001_first.down.sql": one.down,
    "002_second.up.sql": two.up, "002_second.down.sql": two.down,
  });
  assert.equal(runMigrate(base).status, 0);
  await q(`INSERT INTO schema_migrations (version, name) VALUES (99, 'manual_change')`);
  const repo = mkMigDir({
    "001_first.up.sql": one.up, "001_first.down.sql": one.down,
    "002_second.up.sql": two.up, "002_second.down.sql": two.down,
    "003_third.up.sql": three.up, "003_third.down.sql": three.down,
  });
  const r = runMigrate(repo);
  assert.notEqual(r.status, 0, "must fail on the unknown v99");
  assert.match(r.out, /[Uu]nknown applied migration/);
  assert.match(r.out, /99/);
  assert.equal(await tableExists("mr_three"), false, "pending migration 003 MUST NOT execute");
  assert.deepEqual((await migRows()).map((m) => m.version), ["1", "2", "99"], "schema_migrations unchanged");
});

test("MIG-RUNNER-017: same version / different name still fails (Direction A preserved)", { skip: dbSkip }, async () => {
  await recreateDatabase(admin, RUNNERDB);
  const applied = mkMigDir({
    "001_first.up.sql": one.up, "001_first.down.sql": one.down,
    "002_old_name.up.sql": two.up, "002_old_name.down.sql": two.down,
  });
  assert.equal(runMigrate(applied).status, 0);
  const repo = mkMigDir({
    "001_first.up.sql": one.up, "001_first.down.sql": one.down,
    "002_new_name.up.sql": two.up, "002_new_name.down.sql": two.down,
  });
  const r = runMigrate(repo);
  assert.notEqual(r.status, 0);
  assert.match(r.out, /collision/i);
  assert.match(r.out, /old_name/);
  assert.match(r.out, /new_name/);
});

test("MIG-RUNNER-018: duplicate source migration version still fails before executing (preserved)", { skip: dbSkip }, async () => {
  await recreateDatabase(admin, RUNNERDB);
  const dir = mkMigDir({
    "001_first.up.sql": one.up, "001_first.down.sql": one.down,
    "002_a.up.sql": "CREATE TABLE mr_dup_a (id int);",
    "002_b.up.sql": "CREATE TABLE mr_dup_b (id int);",
  });
  const r = runMigrate(dir);
  assert.notEqual(r.status, 0);
  assert.match(r.out, /[Dd]uplicate migration version/);
  assert.deepEqual(await migRows(), [], "nothing applied");
});

test("MIG-RUNNER-019: a history gap (earlier migration unrecorded, later applied) → FAIL", { skip: dbSkip }, async () => {
  await recreateDatabase(admin, RUNNERDB);
  // Apply 001 only, then plant a later applied row (003) with 002 unrecorded.
  const only1 = mkMigDir({ "001_first.up.sql": one.up, "001_first.down.sql": one.down });
  assert.equal(runMigrate(only1).status, 0);
  await q(`INSERT INTO schema_migrations (version, name) VALUES (3, 'third')`);
  const repo = mkMigDir({
    "001_first.up.sql": one.up, "001_first.down.sql": one.down,
    "002_second.up.sql": two.up, "002_second.down.sql": two.down,
    "003_third.up.sql": three.up, "003_third.down.sql": three.down,
  });
  const r = runMigrate(repo);
  assert.notEqual(r.status, 0, "non-contiguous history must fail");
  assert.match(r.out, /[Gg]ap/);
  assert.match(r.out, /2_second/);
  assert.equal(await tableExists("mr_two"), false, "the missing intermediate must NOT be run out of order");
  assert.deepEqual((await migRows()).map((m) => m.version), ["1", "3"], "schema_migrations unchanged");
});

// ---------------------------------------------------------------------------
// MIG-RUNNER-020..028 — migration artifact integrity (AWM-MIG-006)
// Policy (Option A): every migration MUST ship a real, non-empty .up.sql;
// .down.sql is optional and `migrate down` fails clearly when it is absent.
// ---------------------------------------------------------------------------

test("MIG-RUNNER-020: a down-only migration (missing .up.sql) → FAIL, nothing applied", { skip: dbSkip }, async () => {
  await recreateDatabase(admin, RUNNERDB);
  const dir = mkMigDir({
    "001_first.up.sql": one.up, "001_first.down.sql": one.down,
    // 002 ships ONLY a down file — no 002_security_fix.up.sql.
    "002_security_fix.down.sql": "DROP TABLE IF EXISTS mr_sec2;",
  });
  const r = runMigrate(dir);
  assert.notEqual(r.status, 0, "missing .up.sql must fail closed");
  assert.match(r.out, /Invalid migration artifact/);
  assert.match(r.out, /2_security_fix\.up\.sql/);
  // Discovery fails before ANY migration runs — not even 001 is applied.
  assert.equal(await tableExists("mr_one"), false, "no migration SQL executed");
  assert.deepEqual(await migRows(), [], "schema_migrations unchanged (002 not recorded)");
});

test("MIG-RUNNER-021: normal complete up/down pairs behave normally (no regression)", { skip: dbSkip }, async () => {
  await recreateDatabase(admin, RUNNERDB);
  const dir = mkMigDir({
    "001_first.up.sql": one.up, "001_first.down.sql": one.down,
    "002_second.up.sql": two.up, "002_second.down.sql": two.down,
  });
  const r = runMigrate(dir);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual((await migRows()).map((m) => m.version), ["1", "2"]);
  assert.equal(await tableExists("mr_one"), true);
  assert.equal(await tableExists("mr_two"), true);
});

test("MIG-RUNNER-022: up-only migration is allowed for `migrate up` (Option A: down optional)", { skip: dbSkip }, async () => {
  await recreateDatabase(admin, RUNNERDB);
  const dir = mkMigDir({ "001_only_up.up.sql": one.up }); // no .down.sql
  const r = runMigrate(dir);
  assert.equal(r.status, 0, `up-only should apply cleanly: ${r.out}`);
  assert.equal(await tableExists("mr_one"), true);
  assert.deepEqual((await migRows()).map((m) => m.name), ["only_up"]);
});

test("MIG-RUNNER-023: rolling back an up-only migration fails clearly (never runs an empty down)", { skip: dbSkip }, async () => {
  await recreateDatabase(admin, RUNNERDB);
  const dir = mkMigDir({ "001_irreversible.up.sql": one.up }); // no .down.sql
  assert.equal(runMigrate(dir).status, 0);
  const r = runMigrateDown(dir);
  assert.notEqual(r.status, 0, "rollback without a down file must fail");
  assert.match(r.out, /No down migration exists for \d*1_irreversible/);
  // History untouched — the migration is still recorded (no phantom revert).
  assert.deepEqual((await migRows()).map((m) => m.name), ["irreversible"], "not deleted by a no-op rollback");
});

test("MIG-RUNNER-024: an .up.sql with no executable SQL → FAIL; comments+SQL stays valid", { skip: dbSkip }, async () => {
  await recreateDatabase(admin, RUNNERDB);
  // Only whitespace + comments → invalid.
  const empty = mkMigDir({
    "001_empty.up.sql": "-- just a comment\n/*  block\n   comment */\n   \n",
    "001_empty.down.sql": "SELECT 1;",
  });
  const r = runMigrate(empty);
  assert.notEqual(r.status, 0, "an empty/comment-only .up.sql must fail");
  assert.match(r.out, /Invalid migration artifact/);
  assert.match(r.out, /1_empty\.up\.sql/);
  assert.deepEqual(await migRows(), [], "empty migration not recorded");

  // §17: a real migration that merely BEGINS with comments must remain valid.
  await recreateDatabase(admin, RUNNERDB);
  const commented = mkMigDir({
    "001_commented.up.sql": "-- Add a marker table\n\nCREATE TABLE mr_commented (id int);",
    "001_commented.down.sql": "DROP TABLE IF EXISTS mr_commented;",
  });
  const r2 = runMigrate(commented);
  assert.equal(r2.status, 0, `comment-prefixed SQL must be accepted: ${r2.out}`);
  assert.equal(await tableExists("mr_commented"), true);
});

test("MIG-RUNNER-025: DB has the migration applied but repo ships only its .down.sql → FAIL (incomplete artifact)", { skip: dbSkip }, async () => {
  await recreateDatabase(admin, RUNNERDB);
  const base = mkMigDir({ "001_first.up.sql": one.up, "001_first.down.sql": one.down });
  assert.equal(runMigrate(base).status, 0);
  // The DB says 002_security_fix is applied…
  await q(`INSERT INTO schema_migrations (version, name) VALUES (2, 'security_fix')`);
  // …but the repository ships only its .down.sql (the .up.sql is gone).
  const repo = mkMigDir({
    "001_first.up.sql": one.up, "001_first.down.sql": one.down,
    "002_security_fix.down.sql": "DROP TABLE IF EXISTS mr_sec2;",
  });
  const r = runMigrate(repo);
  assert.notEqual(r.status, 0, "must reject the incomplete artifact, not report 'already applied'");
  assert.match(r.out, /Invalid migration artifact/);
  assert.match(r.out, /2_security_fix\.up\.sql/);
  assert.deepEqual((await migRows()).map((m) => m.version), ["1", "2"], "schema_migrations unchanged");
});

test("MIG-RUNNER-026: an invalid artifact blocks later valid pending migrations", { skip: dbSkip }, async () => {
  await recreateDatabase(admin, RUNNERDB);
  const base = mkMigDir({ "001_first.up.sql": one.up, "001_first.down.sql": one.down });
  assert.equal(runMigrate(base).status, 0);
  const repo = mkMigDir({
    "001_first.up.sql": one.up, "001_first.down.sql": one.down,
    "002_bad.down.sql": "SELECT 1;", // no 002_bad.up.sql
    "003_good.up.sql": three.up, "003_good.down.sql": three.down,
  });
  const r = runMigrate(repo);
  assert.notEqual(r.status, 0, "invalid 002 artifact must fail");
  assert.match(r.out, /Invalid migration artifact/);
  assert.equal(await tableExists("mr_three"), false, "later migration 003 MUST NOT execute");
  assert.deepEqual((await migRows()).map((m) => m.version), ["1"], "schema_migrations unchanged");
});

test("MIG-RUNNER-027: an invalid artifact mutates neither schema_migrations nor the schema", { skip: dbSkip }, async () => {
  await recreateDatabase(admin, RUNNERDB);
  const base = mkMigDir({ "001_first.up.sql": one.up, "001_first.down.sql": one.down });
  assert.equal(runMigrate(base).status, 0);
  const before = await migRows();
  const repo = mkMigDir({
    "001_first.up.sql": one.up, "001_first.down.sql": one.down,
    "002_missing_up.down.sql": "SELECT 1;",
    "003_would_run.up.sql": three.up, "003_would_run.down.sql": three.down,
  });
  const r = runMigrate(repo);
  assert.notEqual(r.status, 0);
  assert.deepEqual(await migRows(), before, "schema_migrations unchanged");
  assert.equal(await tableExists("mr_three"), false, "no schema change from pending migrations");
});

test("MIG-RUNNER-028: the deployment gate stops the server on an invalid artifact", { skip: dbSkip }, async () => {
  await recreateDatabase(admin, RUNNERDB);
  const repo = mkMigDir({
    "001_first.up.sql": one.up, "001_first.down.sql": one.down,
    "002_missing_up.down.sql": "SELECT 1;",
  });
  const r = runDeployGate(repo);
  assert.notEqual(r.status, 0, "deploy command must fail on an invalid artifact");
  assert.doesNotMatch(r.out, /SERVER_WOULD_START/, "the server start step must NOT run");
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
