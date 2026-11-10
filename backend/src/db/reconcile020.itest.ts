/**
 * MIG-RECONCILE-020 — upgrade of a database whose history records version 20 as
 * `vpn_server_internet` (the RDP / VPN-internet code line) instead of this code
 * line's `tenant_scope_shared`. Rebuilds that exact history, proves the runner
 * refuses it, applies deploy/db/reconcile-migration-020.sql, then runs the real
 * runner (subprocess) and checks schema, history and data. Real PostgreSQL.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { dbSkip, DATABASE_URL, recreateDatabase, dropDatabaseQuiet } from "../test/db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.resolve(__dirname, "..", "..");
const MIGRATIONS = path.join(BACKEND, "migrations");
const RECONCILE = path.resolve(BACKEND, "..", "deploy", "db", "reconcile-migration-020.sql");
const DB = "awamer_reconcile020";

/** The old code line's 020 migration, verbatim. */
const OLD_020 = `
ALTER TABLE vpn_servers ADD COLUMN internet_access BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE vpn_server_clients ADD COLUMN internet_access BOOLEAN NOT NULL DEFAULT FALSE;`;

let admin: Pool;
let url = "";

async function q<T extends import("pg").QueryResultRow = import("pg").QueryResultRow>(sql: string, params: unknown[] = []) {
  const p = new Pool({ connectionString: url });
  p.on("error", () => {});
  try { return await p.query<T>(sql, params); } finally { await p.end().catch(() => {}); }
}
async function applyRecorded(sql: string, version: number, name: string): Promise<void> {
  const p = new Pool({ connectionString: url });
  p.on("error", () => {});
  const c = await p.connect();
  try {
    await c.query("BEGIN");
    await c.query(sql);
    await c.query(`INSERT INTO schema_migrations (version, name) VALUES ($1, $2)`, [version, name]);
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
    await p.end().catch(() => {});
  }
}
/** The reconcile script without psql meta-commands (\set …). */
const reconcileSql = () => fs.readFileSync(RECONCILE, "utf8").split("\n").filter((l) => !l.startsWith("\\")).join("\n");
function migrate(): { status: number | null; out: string } {
  const r = spawnSync("npx", ["tsx", "src/migrate.ts", "up"], {
    cwd: BACKEND, env: { ...process.env, DATABASE_URL: url, LOG_LEVEL: "error" }, encoding: "utf8",
  });
  return { status: r.status, out: `${r.stdout ?? ""}\n${r.stderr ?? ""}` };
}
const repoMigrations = () => fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith(".up.sql")).sort()
  .map((f) => ({ file: f, version: Number(f.slice(0, 3)), name: f.slice(4, -".up.sql".length) }));

before(async () => {
  if (dbSkip) return;
  admin = new Pool({ connectionString: DATABASE_URL });
  admin.on("error", () => {});
  await recreateDatabase(admin, DB);
  const u = new URL(DATABASE_URL); u.pathname = `/${DB}`; url = u.toString();
  await q(`CREATE TABLE schema_migrations (version BIGINT PRIMARY KEY, name TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  for (const m of repoMigrations().filter((m) => m.version <= 19)) {
    await applyRecorded(fs.readFileSync(path.join(MIGRATIONS, m.file), "utf8"), m.version, m.name);
  }
  await applyRecorded(OLD_020, 20, "vpn_server_internet");
  for (const m of repoMigrations().filter((m) => m.version === 21 || m.version === 22)) {
    await applyRecorded(fs.readFileSync(path.join(MIGRATIONS, m.file), "utf8"), m.version, m.name);
  }
  const userId = (await q<{ id: string }>(
    `INSERT INTO users (id,username,email,password_hash,role,is_active,company_id)
     VALUES (gen_random_uuid(),'rc','rc@t.local','x','user',true,(SELECT id FROM companies LIMIT 1)) RETURNING id`)).rows[0]!.id;
  await q(`INSERT INTO hosts (user_id,name,hostname,port,protocol) VALUES ($1,'win','10.0.0.5',3389,'rdp')`, [userId]);
  const sid = (await q<{ id: string }>(
    `INSERT INTO vpn_servers (user_id,name,public_host,port,proto,subnet,ca_cert,ca_key_enc,server_cert,server_key_enc,tls_crypt_enc,internet_access)
     VALUES ($1,'hub','vpn.example.com',1194,'udp','10.8.0.0/24','c','{}','s','{}','{}',true) RETURNING id`, [userId])).rows[0]!.id;
  await q(`INSERT INTO vpn_server_clients (server_id,name,username,password_hash,password_enc,cert,key_enc,internet_access)
           VALUES ($1,'a','alice','h','{}','c','{}',true)`, [sid]);
});

after(async () => {
  if (dbSkip) return;
  await dropDatabaseQuiet(admin, DB);
  await admin.end().catch(() => {});
});

test("MIG-RECONCILE-001: the runner refuses the old history and changes nothing", { skip: dbSkip }, async () => {
  const r = migrate();
  assert.notEqual(r.status, 0);
  assert.match(r.out, /Migration version collision detected/);
  assert.equal((await q(`SELECT 1 FROM schema_migrations WHERE version > 22`)).rowCount, 0);
});

test("MIG-RECONCILE-002: an unexpected v20 name is refused by the reconcile script", { skip: dbSkip }, async () => {
  await q(`UPDATE schema_migrations SET name = 'other' WHERE version = 20`);
  await assert.rejects(() => q(reconcileSql()), /recorded as "other"/);
  assert.equal((await q<{ name: string }>(`SELECT name FROM schema_migrations WHERE version = 20`)).rows[0]!.name, "other");
  await q(`UPDATE schema_migrations SET name = 'vpn_server_internet' WHERE version = 20`);
});

test("MIG-RECONCILE-003: reconcile + migrate brings the database exactly to this code line, keeping data", { skip: dbSkip }, async () => {
  await q(reconcileSql());
  await q(reconcileSql()); // idempotent
  const r = migrate();
  assert.equal(r.status, 0, r.out);
  const rows = (await q<{ version: string; name: string }>(`SELECT version, name FROM schema_migrations ORDER BY version`)).rows;
  assert.deepEqual(rows.map((x) => `${x.version}_${x.name}`), repoMigrations().map((m) => `${m.version}_${m.name}`));
  assert.equal((await q(`SELECT 1 FROM hosts WHERE company_id IS NULL`)).rowCount, 0, "tenant column created and backfilled (023)");
  assert.equal((await q<{ internet_access: boolean }>(`SELECT internet_access FROM vpn_servers`)).rows[0]!.internet_access, true);
  assert.equal((await q<{ internet_access: boolean }>(`SELECT internet_access FROM vpn_server_clients`)).rows[0]!.internet_access, true);
  assert.equal(migrate().status, 0, "a second run has nothing to do");
});
