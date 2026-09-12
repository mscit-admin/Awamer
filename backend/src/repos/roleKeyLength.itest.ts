/**
 * AWM-MIG-002 — migration 025 shortens over-length custom-role keys so they
 * satisfy the REST API's max(48) role-key ceiling, deterministically and
 * collision-resistantly, without disturbing short keys, permissions, tenants,
 * or user assignments. MIG-KEY-001..010.
 *
 * Runs against a DEDICATED fresh, fully-migrated database. To reproduce a
 * pre-025 environment we migrate up (001..025), drop the CHECK constraint 025
 * adds, generate authentic 024-style over-length clone keys, then replay 025's
 * repair exactly as production would apply it to an already-024'd database.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import Fastify, { type FastifyInstance } from "fastify";
import { loadConfig } from "../config/index.js";
import { createJwt, type JwtService } from "../jwt/index.js";
import { RoleRepository } from "./roleRepo.js";
import { RoleService } from "../domain/roleService.js";
import { UserRepository } from "./userRepo.js";
import { AuditRepository } from "./otherRepos.js";
import { CompanyRepository, OrgUnitRepository } from "./orgRepos.js";
import { makeOrganizationRoutes } from "../routes/organization.js";
import { dbSkip, DATABASE_URL, recreateDatabase, dropDatabaseQuiet } from "../test/db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migPath = (n: string) => path.resolve(__dirname, "..", "..", "migrations", n);
const MIG024 = fs.readFileSync(migPath("024_fix_cross_tenant_roles.up.sql"), "utf8");
const MIG025 = fs.readFileSync(migPath("025_shorten_role_keys.up.sql"), "utf8");
const MIGDB = "awamer_keytest";

let admin: Pool;
let pool: Pool;
let migUrl = "";
let app: FastifyInstance;
const sessions = { register() {}, unregister() {}, revokeUser() { return 0; }, revalidateUser: async () => {}, count() { return 0; }, countForUser() { return 0; }, startPeriodic() {}, stop() {} } as never;
let jwt: JwtService;
const ids: Record<string, string> = {};
// role keys captured at various points
const k: Record<string, string> = {};

const shortRoles: Array<{ key: string; len: number }> = [
  { key: "a", len: 1 },
  { key: "k" + "a".repeat(12), len: 13 },
  { key: "k" + "a".repeat(13), len: 14 },
  { key: "k" + "a".repeat(46), len: 47 },
  { key: "k" + "a".repeat(47), len: 48 },
];

const roleKeyOfUser = async (id: string) =>
  (await pool.query<{ role: string }>(`SELECT role FROM users WHERE id=$1`, [id])).rows[0]!.role;
const roleRow = async (key: string) =>
  (await pool.query<{ name: string; company_id: string; permissions: string[] }>(
    `SELECT name, company_id, permissions FROM roles WHERE key=$1`, [key])).rows[0]!;
const expectedShort = async (src: string) =>
  (await pool.query<{ e: string }>(
    `SELECT left($1,34) || '__' || substr(md5($1),1,12) AS e`, [src])).rows[0]!.e;
const mkUser = async (role: string, companyId: string | null) =>
  (await pool.query<{ id: string }>(
    `INSERT INTO users (id,username,email,password_hash,role,company_id)
     VALUES (gen_random_uuid(),'kl_'||substr(md5(random()::text),1,12),'kl_'||substr(md5(random()::text),1,12)||'@t.local','x',$1,$2)
     RETURNING id`, [role, companyId])).rows[0]!.id;

before(async () => {
  if (dbSkip) return;
  const base = new URL(DATABASE_URL);
  migUrl = `${base.protocol}//${base.username}:${base.password}@${base.host}/${MIGDB}`;
  const adminUrl = `${base.protocol}//${base.username}:${base.password}@${base.host}/postgres`;
  admin = new Pool({ connectionString: adminUrl });
  // Idle pooled clients can emit async errors when the server terminates a
  // connection (e.g. a sibling migration test's DROP DATABASE ... WITH (FORCE)
  // under the parallel runner). Swallow them so they don't surface as an
  // uncaughtException — they are teardown noise, not assertion failures.
  admin.on("error", () => {});
  await recreateDatabase(admin, MIGDB);
  execSync(`npx tsx src/migrate.ts up`, { env: { ...process.env, DATABASE_URL: migUrl }, stdio: "ignore" });
  pool = new Pool({ connectionString: migUrl });
  pool.on("error", () => {});

  // Reproduce a pre-025 environment: drop the ceiling constraint 025 added so we
  // can seed authentic over-length keys the way a real 024 run would leave them.
  await pool.query(`ALTER TABLE roles DROP CONSTRAINT IF EXISTS roles_key_len_chk`);

  ids.A = (await pool.query<{ id: string }>(`INSERT INTO companies (id,name) VALUES (gen_random_uuid(),'KL A') RETURNING id`)).rows[0]!.id;
  ids.B = (await pool.query<{ id: string }>(`INSERT INTO companies (id,name) VALUES (gen_random_uuid(),'KL B') RETURNING id`)).rows[0]!.id;
  ids.C = (await pool.query<{ id: string }>(`INSERT INTO companies (id,name) VALUES (gen_random_uuid(),'KL C') RETURNING id`)).rows[0]!.id;

  // Short-key custom roles (≤48) that must be left untouched by 025.
  for (const r of shortRoles) {
    await pool.query(`INSERT INTO roles (key,name,permissions,is_builtin,company_id) VALUES ($1,'short',ARRAY['audit:read'],FALSE,$2)`, [r.key, ids.A]);
  }

  // A 40-char source custom role owned by A, held cross-tenant by A, B, C — the
  // exact shape 024 was written to repair. Running 024 produces authentic
  // 75-char clone keys for B and C (both sharing the same left(_,40) prefix).
  k.src = "k_" + "x".repeat(38); // 40 chars
  await pool.query(`INSERT INTO roles (key,name,permissions,is_builtin,company_id) VALUES ($1,'KL Src',ARRAY['resources:write'],FALSE,$2)`, [k.src, ids.A]);
  ids.uA = await mkUser(k.src, ids.A);
  ids.uB = await mkUser(k.src, ids.B);
  ids.uC = await mkUser(k.src, ids.C);

  // Authentic 024 clone generation (over-length keys land in the DB).
  await pool.query(MIG024);
  k.preB = await roleKeyOfUser(ids.uB); // 75-char clone owned by B
  k.preC = await roleKeyOfUser(ids.uC); // 75-char clone owned by C

  // Sanity: the seeded state really is over-length before 025.
  assert.ok(k.preB.length > 48 && k.preC.length > 48, "precondition: 024 produced over-length keys");
  assert.equal(k.preB.slice(0, 34), k.preC.slice(0, 34), "both clones share the same 34-char prefix (collision pressure)");

  // Apply the fix under test.
  await pool.query(MIG025);

  k.postB = await roleKeyOfUser(ids.uB);
  k.postC = await roleKeyOfUser(ids.uC);

  // ---- API harness (organization routes) against the migrated DB ----------
  const cfg = loadConfig();
  jwt = createJwt(cfg);
  const roles = new RoleRepository(pool);
  const roleService = new RoleService(roles);
  const users = new UserRepository(pool);
  await roleService.reload(); // pick up the shortened keys
  ids.superU = await mkUser("super_admin", ids.B);
  ids.targetB = await mkUser("user", ids.B); // a plain user in B we will re-assign
  k.superTok = (await jwt.issuePair(ids.superU, "super_admin")).access.token;

  app = Fastify();
  await app.register(makeOrganizationRoutes({ sessions,
    companies: new CompanyRepository(pool), units: new OrgUnitRepository(pool),
    users, audit: new AuditRepository(pool), jwt, roleService,
  }), { prefix: "/api/v1/org" });
  await app.ready();
});

after(async () => {
  if (dbSkip) return;
  await app?.close();
  await pool?.end().catch(() => {});
  if (admin) await dropDatabaseQuiet(admin, MIGDB);
  await admin?.end().catch(() => {});
});

test("MIG-KEY-001..005: short custom-role keys (1/13/14/47/48) are left untouched", { skip: dbSkip }, async () => {
  for (const r of shortRoles) {
    const row = await pool.query<{ n: string }>(`SELECT COUNT(*)::text n FROM roles WHERE key=$1`, [r.key]);
    assert.equal(row.rows[0]!.n, "1", `role key of length ${r.len} still present unchanged`);
  }
});

test("MIG-KEY-006: an over-length clone key is rewritten to EXACTLY 48 chars, deterministically, and the user cascades", { skip: dbSkip }, async () => {
  assert.equal(k.postB!.length, 48, "shortened to exactly 48 chars");
  assert.equal(k.postB, await expectedShort(k.preB!), "matches deterministic left(key,34)||'__'||md5(key)[:12]");
  // users.role followed via ON UPDATE CASCADE — user B holds the new key.
  assert.equal(await roleKeyOfUser(ids.uB!), k.postB, "user reassigned via cascade, not orphaned");
});

test("MIG-KEY-007: two clones sharing a 34-char prefix shorten to DISTINCT ≤48 keys (collision resistance)", { skip: dbSkip }, async () => {
  assert.equal(k.postB!.length, 48);
  assert.equal(k.postC!.length, 48);
  assert.equal(k.postB!.slice(0, 34), k.postC!.slice(0, 34), "same readable prefix retained");
  assert.notEqual(k.postB, k.postC, "md5 tail keeps them distinct despite identical prefixes");
});

test("MIG-KEY-008: name, tenant (company_id) and permissions are preserved across the rename", { skip: dbSkip }, async () => {
  const b = await roleRow(k.postB!);
  const c = await roleRow(k.postC!);
  assert.equal(b.company_id, ids.B, "B's clone still owned by B");
  assert.equal(c.company_id, ids.C, "C's clone still owned by C");
  assert.equal(b.name, "KL Src", "display name preserved");
  assert.deepEqual(b.permissions.sort(), ["resources:write"], "permissions preserved");
  assert.deepEqual(c.permissions.sort(), ["resources:write"], "permissions preserved");
});

test("MIG-KEY-009: 025 adds the char_length<=48 CHECK, rejects a new over-length key, and is idempotent", { skip: dbSkip }, async () => {
  const con = await pool.query<{ n: string }>(`SELECT COUNT(*)::text n FROM pg_constraint WHERE conname='roles_key_len_chk'`);
  assert.equal(con.rows[0]!.n, "1", "ceiling CHECK present");
  await assert.rejects(
    () => pool.query(`INSERT INTO roles (key,name,permissions,is_builtin,company_id) VALUES ($1,'x',ARRAY[]::text[],FALSE,$2)`, ["z".repeat(49), ids.A!]),
    /roles_key_len_chk|check constraint/i,
    "DB now refuses a >48 key",
  );
  // Idempotent: re-running finds no key >48 and the guarded constraint add no-ops.
  await pool.query(MIG025);
  const over = await pool.query<{ n: string }>(`SELECT COUNT(*)::text n FROM roles WHERE is_builtin=FALSE AND char_length(key)>48`);
  assert.equal(over.rows[0]!.n, "0", "no over-length custom keys remain");
});

test("MIG-KEY-010: the generated key is API-compatible — org assignment accepts it (max 48) and cross-tenant invariant holds", { skip: dbSkip }, async () => {
  // Every custom-role key now fits the API's max(48) ceiling.
  const wide = await pool.query<{ n: string }>(`SELECT COUNT(*)::text n FROM roles WHERE char_length(key)>48`);
  assert.equal(wide.rows[0]!.n, "0", "no role key exceeds the API ceiling");

  // Real API path: assign a company-B user to B's shortened generated role.
  const res = await app.inject({
    method: "PUT",
    url: `/api/v1/org/users/${ids.targetB}/assignment`,
    headers: { authorization: `Bearer ${k.superTok}` },
    payload: { company_id: ids.B, role: k.postB },
  });
  assert.equal(res.statusCode, 200, `assignment should succeed, got ${res.statusCode}: ${res.body}`);
  assert.equal(await roleKeyOfUser(ids.targetB!), k.postB, "user now holds the shortened generated role via the API");

  // The whole repair keeps the tenant invariant at zero.
  const mismatch = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text n FROM users u JOIN roles r ON r.key=u.role
      WHERE r.is_builtin=FALSE AND u.company_id IS DISTINCT FROM r.company_id`);
  assert.equal(mismatch.rows[0]!.n, "0", "DATABASE INVARIANT: 0 cross-tenant custom-role assignments");
});
