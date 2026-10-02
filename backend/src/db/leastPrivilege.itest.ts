/**
 * DB-LEAST-PRIVILEGE (integration, real PostgreSQL) — drives the REAL
 * deploy/db/provision-roles.sh and migration runner.
 *
 *   DBLP-001 provisioning creates non-superuser roles; validates its inputs
 *   DBLP-002 FRESH install: migrations succeed as the NON-superuser migrator
 *   DBLP-003 awamer_app: DML works (incl. BIGSERIAL), DDL / schema_migrations denied
 *   DBLP-004 awamer_vpn_auth: only the 4 auth-verify columns; nothing else
 *   DBLP-005 runtime guard: app passes; migrator + superuser are refused in prod
 *   DBLP-006 UPGRADE path: superuser-owned schema is handed to the migrator,
 *            who can then roll a migration down/up; provisioning is idempotent
 *   DBLP-007 BACKUP/RESTORE: a --no-owner --no-acl dump (backup.sh) restored as
 *            admin is unusable by awamer_app until restore.sh re-provisions;
 *            afterwards the runtime role works and passes the guard
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { DATABASE_URL, dbSkip, getPool, closePool, recreateDatabase, dropDatabaseQuiet } from "../test/db.js";
import { inspectRuntimeRole, runtimeRoleViolations, assertLeastPrivilegeRuntime } from "./runtimeRole.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.resolve(HERE, "..", "..");
const SCRIPT = path.resolve(BACKEND, "..", "deploy", "db", "provision-roles.sh");
const PW = { migrator: randomBytes(18).toString("hex"), app: randomBytes(18).toString("hex"), vpn: randomBytes(18).toString("hex") };
const FRESH = "awamer_lp_fresh";
const UPGRADE = "awamer_lp_upgrade";
const RESTORED = "awamer_lp_restored";
const quiet = { error() {}, warn() {}, info() {} };

function urlFor(db: string, user?: string, pw?: string): string {
  const u = new URL(DATABASE_URL);
  u.pathname = `/${db}`;
  if (user) { u.username = user; u.password = pw ?? ""; }
  return u.toString();
}
function pgEnv(db: string): NodeJS.ProcessEnv {
  const u = new URL(DATABASE_URL);
  return {
    ...process.env, PGHOST: u.hostname, PGPORT: u.port || "5432", PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password), PGDATABASE: db,
    AWAMER_MIGRATOR_DB_PASSWORD: PW.migrator, AWAMER_APP_DB_PASSWORD: PW.app, AWAMER_VPN_AUTH_DB_PASSWORD: PW.vpn,
  };
}
const provision = (db: string, extra: NodeJS.ProcessEnv = {}) =>
  spawnSync("sh", [SCRIPT], { env: { ...pgEnv(db), ...extra }, encoding: "utf8" });
const migrate = (db: string, dir: "up" | "down", user?: string, pw?: string) =>
  spawnSync("npx", ["tsx", "src/migrate.ts", dir], {
    cwd: BACKEND, encoding: "utf8",
    env: { ...process.env, DATABASE_URL: urlFor(db, user, pw), LOG_LEVEL: "error", JWT_ACCESS_SECRET: "", JWT_REFRESH_SECRET: "" },
  });
const pools: Pool[] = [];
/** Track a pool for teardown; idle-client termination by the forced DROP DATABASE is expected. */
const track = (p: Pool) => { p.on("error", () => {}); pools.push(p); return p; };
const as = (db: string, user: string, pw: string) => track(new Pool({ connectionString: urlFor(db, user, pw), max: 2 }));

before(async () => {
  if (dbSkip) return;
  await recreateDatabase(getPool(), FRESH);
  await recreateDatabase(getPool(), UPGRADE);
  await recreateDatabase(getPool(), RESTORED);
});
after(async () => {
  if (dbSkip) return;
  for (const p of pools) await p.end().catch(() => {});
  await dropDatabaseQuiet(getPool(), FRESH);
  await dropDatabaseQuiet(getPool(), UPGRADE);
  await dropDatabaseQuiet(getPool(), RESTORED);
  await closePool();
});

test("DBLP-001: provisioning validates inputs and creates NON-superuser roles", { skip: dbSkip }, async () => {
  const weak = provision(FRESH, { AWAMER_APP_DB_PASSWORD: "short" });
  assert.notEqual(weak.status, 0);
  assert.match(weak.stderr, /AWAMER_APP_DB_PASSWORD/);
  assert.ok(!weak.stderr.includes(PW.migrator), "passwords are never echoed");
  const same = provision(FRESH, { AWAMER_APP_DB_PASSWORD: PW.migrator });
  assert.notEqual(same.status, 0);
  const placeholder = provision(FRESH, { AWAMER_APP_DB_PASSWORD: "CHANGE_ME_openssl_rand_hex_32_different" });
  assert.notEqual(placeholder.status, 0, "template placeholders are refused");
  assert.match(placeholder.stderr, /placeholder/);

  const r = provision(FRESH);
  assert.equal(r.status, 0, r.stderr);
  for (const pw of Object.values(PW)) assert.ok(!(r.stdout + r.stderr).includes(pw), "passwords are never echoed");
  const { rows } = await getPool().query(
    `SELECT rolname, rolsuper, rolcreaterole, rolcreatedb, rolbypassrls, rolreplication FROM pg_roles
      WHERE rolname IN ('awamer_migrator','awamer_app','awamer_vpn_auth') ORDER BY rolname`);
  assert.equal(rows.length, 3);
  for (const x of rows) {
    assert.deepEqual([x.rolsuper, x.rolcreaterole, x.rolcreatedb, x.rolbypassrls, x.rolreplication], [false, false, false, false, false], x.rolname);
  }
});

test("DBLP-002: fresh install — all migrations apply as the NON-superuser migrator", { skip: dbSkip }, async () => {
  const r = migrate(FRESH, "up", "awamer_migrator", PW.migrator);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const p = as(FRESH, "awamer_migrator", PW.migrator);
  const { rows } = await p.query(`SELECT max(version)::int AS v FROM schema_migrations`);
  assert.ok(rows[0].v >= 29);
  const own = await p.query(`SELECT DISTINCT pg_get_userbyid(c.relowner) AS o FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','S')`);
  assert.deepEqual(own.rows.map((x) => x.o), ["awamer_migrator"]);
});

test("DBLP-003: awamer_app has DML only — no DDL, no migration bookkeeping", { skip: dbSkip }, async () => {
  const app = as(FRESH, "awamer_app", PW.app);
  // DML incl. a BIGSERIAL default (sequence USAGE) and a UUID default (pgcrypto).
  const u = await app.query(
    `INSERT INTO users (id, username, email, password_hash, role) VALUES (gen_random_uuid(), 'lp_u', 'lp@t.local', 'x', 'user') RETURNING id`);
  await app.query(`UPDATE users SET full_name = 'LP' WHERE id = $1`, [u.rows[0].id]);
  const a = await app.query(`INSERT INTO audit_logs (user_id, action, success) VALUES ($1, 'lp_test', TRUE) RETURNING id`, [u.rows[0].id]);
  assert.ok(Number(a.rows[0].id) > 0);
  await app.query(`DELETE FROM audit_logs WHERE id = $1`, [a.rows[0].id]);
  await app.query(`DELETE FROM users WHERE id = $1`, [u.rows[0].id]);
  await app.query(`SELECT pg_advisory_xact_lock(42)`);

  for (const ddl of [
    `CREATE TABLE lp_evil (x int)`, `DROP TABLE audit_logs`, `ALTER TABLE users ADD COLUMN lp_evil int`,
    `TRUNCATE audit_logs`, `CREATE ROLE lp_evil`, `CREATE DATABASE lp_evil`,
    `SELECT * FROM schema_migrations`, `DELETE FROM schema_migrations`,
  ]) {
    await assert.rejects(() => app.query(ddl), /permission denied|must be owner|must have|denied/i, ddl);
  }
  // A non-owner GRANT is a no-op in PostgreSQL ("no privileges were granted"):
  // prove it really granted nothing.
  await app.query(`GRANT SELECT ON users TO PUBLIC`);
  const su = track(new Pool({ connectionString: urlFor(FRESH), max: 1 }));
  const { rows } = await su.query(`SELECT has_table_privilege('awamer_vpn_auth', 'public.users', 'SELECT') AS leaked`);
  assert.equal(rows[0].leaked, false);
});

test("DBLP-004: awamer_vpn_auth reads ONLY the four auth-verify columns", { skip: dbSkip }, async () => {
  const vpn = as(FRESH, "awamer_vpn_auth", PW.vpn);
  // The exact query vpn/authVerify.ts runs.
  await vpn.query(`SELECT password_hash FROM vpn_server_clients WHERE server_id = gen_random_uuid() AND username = 'x' AND NOT revoked`);
  for (const q of [
    `SELECT * FROM vpn_server_clients`, `SELECT password_hash FROM users`, `SELECT * FROM vpn_servers`,
    `SELECT * FROM credentials`, `UPDATE vpn_server_clients SET revoked = FALSE`, `INSERT INTO audit_logs (action, success) VALUES ('x', TRUE)`,
  ]) {
    await assert.rejects(() => vpn.query(q), /permission denied/i, q);
  }
});

test("DBLP-005: runtime guard — app passes; migrator and superuser refused in production", { skip: dbSkip }, async () => {
  const app = as(FRESH, "awamer_app", PW.app);
  assert.deepEqual(runtimeRoleViolations(await inspectRuntimeRole(app)), []);
  await assertLeastPrivilegeRuntime(app, { isProd: true, allowPrivileged: false }, quiet);

  const mig = as(FRESH, "awamer_migrator", PW.migrator);
  const mv = runtimeRoleViolations(await inspectRuntimeRole(mig));
  assert.ok(mv.some((v) => v.includes("migration owner")) && mv.some((v) => v.includes("CREATE")), mv.join());
  await assert.rejects(() => assertLeastPrivilegeRuntime(mig, { isProd: true, allowPrivileged: false }, quiet), /over-privileged/);

  const su = track(new Pool({ connectionString: urlFor(FRESH), max: 1 }));
  assert.ok(runtimeRoleViolations(await inspectRuntimeRole(su)).includes("SUPERUSER"));
  await assert.rejects(() => assertLeastPrivilegeRuntime(su, { isProd: true, allowPrivileged: false }, quiet), /SUPERUSER/);
  // Development only warns; the explicit override is honoured (and logged as an error).
  await assertLeastPrivilegeRuntime(su, { isProd: false, allowPrivileged: false }, quiet);
  await assertLeastPrivilegeRuntime(su, { isProd: true, allowPrivileged: true }, quiet);
});

test("DBLP-006: upgrade path — superuser-migrated schema is handed to the migrator", { skip: dbSkip }, async () => {
  // Legacy install: everything migrated (and owned) by the superuser.
  const legacy = migrate(UPGRADE, "up");
  assert.equal(legacy.status, 0, legacy.stderr);
  const r = provision(UPGRADE);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(provision(UPGRADE).status, 0, "provisioning is idempotent");

  const p = as(UPGRADE, "awamer_migrator", PW.migrator);
  const own = await p.query(`SELECT DISTINCT pg_get_userbyid(c.relowner) AS o FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','S')`);
  assert.deepEqual(own.rows.map((x) => x.o), ["awamer_migrator"]);
  // The migrator can now operate the schema without superuser.
  const down = migrate(UPGRADE, "down", "awamer_migrator", PW.migrator);
  assert.equal(down.status, 0, down.stderr);
  const up = migrate(UPGRADE, "up", "awamer_migrator", PW.migrator);
  assert.equal(up.status, 0, up.stderr);
  // The runtime role is compliant on the upgraded database too.
  const app = as(UPGRADE, "awamer_app", PW.app);
  assert.deepEqual(runtimeRoleViolations(await inspectRuntimeRole(app)), []);
  await app.query(`SELECT count(*) FROM users`);
});

test("DBLP-007: backup (--no-owner --no-acl) → restore → re-provision restores least-privilege access", { skip: dbSkip }, async () => {
  // Seed a recognisable row in the source (FRESH, already provisioned + migrated).
  const src = as(FRESH, "awamer_app", PW.app);
  await src.query(`INSERT INTO companies (id, name) VALUES (gen_random_uuid(), 'lp-restore-marker')`);
  // Same flags as deploy/scripts/backup.sh, restored as the cluster admin like restore.sh.
  const dump = spawnSync("pg_dump", ["--no-owner", "--no-acl"], { env: pgEnv(FRESH), encoding: "utf8", maxBuffer: 1 << 28 });
  assert.equal(dump.status, 0, dump.stderr);
  const restore = spawnSync("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1"], { env: pgEnv(RESTORED), input: dump.stdout, encoding: "utf8" });
  assert.equal(restore.status, 0, restore.stderr);

  // Before re-provisioning: the runtime role has NO access (fails closed).
  const before = as(RESTORED, "awamer_app", PW.app);
  await assert.rejects(() => before.query(`SELECT count(*) FROM companies`), /permission denied/i);

  // restore.sh step: re-provision (ownership → migrator, grants), then migrate.
  assert.equal(provision(RESTORED).status, 0);
  const up = migrate(RESTORED, "up", "awamer_migrator", PW.migrator);
  assert.equal(up.status, 0, up.stderr);

  const app = as(RESTORED, "awamer_app", PW.app);
  const { rows } = await app.query(`SELECT count(*)::int AS n FROM companies WHERE name = 'lp-restore-marker'`);
  assert.equal(rows[0].n, 1, "restored data is readable by the runtime role");
  assert.deepEqual(runtimeRoleViolations(await inspectRuntimeRole(app)), []);
  const vpn = as(RESTORED, "awamer_vpn_auth", PW.vpn);
  await vpn.query(`SELECT password_hash FROM vpn_server_clients WHERE NOT revoked LIMIT 1`);
});
