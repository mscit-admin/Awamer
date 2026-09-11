/**
 * AWM-MIG-001 — corrective migration 024 splits cross-tenant custom roles.
 * Runs against a DEDICATED fresh, fully-migrated database for isolation, then
 * simulates the post-022 bad state and applies 024. MIG-RBAC-001..006.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { dbSkip, DATABASE_URL, recreateDatabase, dropDatabaseQuiet } from "../test/db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIG024 = fs.readFileSync(path.resolve(__dirname, "..", "..", "migrations", "024_fix_cross_tenant_roles.up.sql"), "utf8");
const MIGDB = "awamer_migtest";

let admin: Pool;
let pool: Pool;
let migUrl = "";
const c: Record<string, string> = {};

const mismatchCount = async () =>
  Number((await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text n FROM users u JOIN roles r ON r.key=u.role
      WHERE r.is_builtin=FALSE AND u.company_id IS DISTINCT FROM r.company_id`)).rows[0]!.n);
const roleOfUser = async (id: string) => (await pool.query<{ role: string; company_id: string }>(
  `SELECT u.role, r.company_id FROM users u JOIN roles r ON r.key=u.role WHERE u.id=$1`, [id])).rows[0]!;
const mkCompany = async (n: string) => (await pool.query<{ id: string }>(`INSERT INTO companies (id,name) VALUES (gen_random_uuid(),$1) RETURNING id`, [n])).rows[0]!.id;
const mkRole = async (key: string, companyId: string, perms: string[]) => { await pool.query(`INSERT INTO roles (key,name,permissions,is_builtin,company_id) VALUES ($1,$1,$2,FALSE,$3)`, [key, perms, companyId]); return key; };
const mkUser = async (role: string, companyId: string | null) => (await pool.query<{ id: string }>(`INSERT INTO users (id,username,email,password_hash,role,company_id) VALUES (gen_random_uuid(),'mg_'||substr(md5(random()::text),1,12),'mg_'||substr(md5(random()::text),1,12)||'@t.local','x',$1,$2) RETURNING id`, [role, companyId])).rows[0]!.id;

before(async () => {
  if (dbSkip) return;
  const base = new URL(DATABASE_URL);
  migUrl = `${base.protocol}//${base.username}:${base.password}@${base.host}/${MIGDB}`;
  const adminUrl = `${base.protocol}//${base.username}:${base.password}@${base.host}/postgres`;
  admin = new Pool({ connectionString: adminUrl });
  // Swallow async idle-client errors from server-side connection termination
  // (parallel sibling tests' DROP DATABASE ... WITH (FORCE)); teardown noise,
  // not assertion failures.
  admin.on("error", () => {});
  await recreateDatabase(admin, MIGDB);
  // MIG-RBAC-006: migrate the fresh DB up realistically (001..latest).
  execSync(`npx tsx src/migrate.ts up`, { env: { ...process.env, DATABASE_URL: migUrl }, stdio: "ignore" });
  pool = new Pool({ connectionString: migUrl });
  pool.on("error", () => {});

  c.A = await mkCompany("MG A"); c.B = await mkCompany("MG B"); c.C = await mkCompany("MG C");
  // MIG-RBAC-001: single-company role (users only in A).
  c.single = await mkRole("mg_single", c.A, ["resources:write"]);
  c.uSingle = await mkUser(c.single, c.A);
  // MIG-RBAC-002: role owned by A but used by A & B (022 LIMIT-1 mistake).
  c.two = await mkRole("mg_two", c.A, ["resources:write", "sessions:connect"]);
  c.uTwoA = await mkUser(c.two, c.A); c.uTwoB = await mkUser(c.two, c.B);
  // MIG-RBAC-003: role owned by A but used by A, B, C.
  c.three = await mkRole("mg_three", c.A, ["audit:read"]);
  c.uThreeA = await mkUser(c.three, c.A); c.uThreeB = await mkUser(c.three, c.B); c.uThreeC = await mkUser(c.three, c.C);
  // MIG-RBAC-004: unused custom role (no users) owned by B.
  c.unused = await mkRole("mg_unused", c.B, ["backup:manage"]);
});

after(async () => {
  if (dbSkip) return;
  await pool?.end().catch(() => {});
  if (admin) await dropDatabaseQuiet(admin, MIGDB);
  await admin?.end().catch(() => {});
});

test("MIG-RBAC-001..004 + invariant: 024 repairs cross-tenant roles", { skip: dbSkip }, async () => {
  assert.ok((await mismatchCount()) > 0, "precondition: violations exist before 024");
  await pool.query(MIG024);

  // 001: single-company role unchanged, owned by A.
  assert.equal((await roleOfUser(c.uSingle!)).company_id, c.A);
  assert.equal((await roleOfUser(c.uSingle!)).role, c.single);

  // 002: A keeps original role, B moved to a B-owned clone.
  assert.equal((await roleOfUser(c.uTwoA!)).company_id, c.A);
  const twoB = await roleOfUser(c.uTwoB!);
  assert.equal(twoB.company_id, c.B);
  assert.notEqual(twoB.role, c.two, "B user reassigned to a clone");

  // 003: three companies -> each user on a role owned by their own company;
  // permissions preserved.
  for (const [uid, comp] of [[c.uThreeA!, c.A], [c.uThreeB!, c.B], [c.uThreeC!, c.C]] as const) {
    const r = await roleOfUser(uid);
    assert.equal(r.company_id, comp, "user on their own company's role");
    const perms = (await pool.query<{ permissions: string[] }>(`SELECT permissions FROM roles WHERE key=$1`, [r.role])).rows[0]!.permissions;
    assert.deepEqual(perms.sort(), ["audit:read"], "permissions preserved on the clone");
  }

  // 004: unused role keeps its existing owner (B), untouched.
  assert.equal((await pool.query<{ company_id: string }>(`SELECT company_id FROM roles WHERE key=$1`, [c.unused])).rows[0]!.company_id, c.B);

  // Absolute invariant (§23): zero cross-tenant custom-role assignments.
  assert.equal(await mismatchCount(), 0, "DATABASE INVARIANT: 0 mismatch rows");
});

test("MIG-RBAC-005: 024 is idempotent (no duplicate roles, stable assignments)", { skip: dbSkip }, async () => {
  const rolesBefore = Number((await pool.query<{ n: string }>(`SELECT COUNT(*)::text n FROM roles`)).rows[0]!.n);
  const assignBefore = await roleOfUser(c.uThreeB!);
  await pool.query(MIG024); // run again
  const rolesAfter = Number((await pool.query<{ n: string }>(`SELECT COUNT(*)::text n FROM roles`)).rows[0]!.n);
  assert.equal(rolesAfter, rolesBefore, "no new roles created on re-run");
  assert.deepEqual(await roleOfUser(c.uThreeB!), assignBefore, "assignment stable");
  assert.equal(await mismatchCount(), 0);
});

test("org-unit invariant query returns 0 rows on the migrated DB", { skip: dbSkip }, async () => {
  const n = Number((await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text n FROM users u JOIN org_units ou ON ou.id=u.org_unit_id
      WHERE u.company_id IS DISTINCT FROM ou.company_id`)).rows[0]!.n);
  assert.equal(n, 0);
});
