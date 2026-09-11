/**
 * AWM-SEC-020 — user company-move must keep custom-role tenant ownership
 * consistent (integration, real PG). MOVE-RBAC-001..008 via app.inject.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";
import { loadConfig } from "../config/index.js";
import { createJwt, type JwtService } from "../jwt/index.js";
import { RoleRepository } from "../repos/roleRepo.js";
import { RoleService } from "../domain/roleService.js";
import { UserRepository } from "../repos/userRepo.js";
import { AuditRepository } from "../repos/otherRepos.js";
import { CompanyRepository, OrgUnitRepository } from "../repos/orgRepos.js";
import { makeOrganizationRoutes } from "./organization.js";
import { getPool, closePool, dbSkip } from "../test/db.js";

let app: FastifyInstance;
let jwt: JwtService;
let users: UserRepository;
let roleService: RoleService;
const ids = { compA: "", compB: "", roleA: "", roleB: "", userA: "", unitA: "", unitB: "", superU: "", adminA: "" };
const tok: Record<string, string> = {};
const bearer = (t: string | undefined) => ({ authorization: `Bearer ${t ?? ""}` });

async function mkCompany(n: string) { const { rows } = await getPool().query<{ id: string }>(`INSERT INTO companies (id,name) VALUES (gen_random_uuid(),$1) RETURNING id`, [n]); return rows[0]!.id; }
async function mkUser(role: string, companyId: string) { const { rows } = await getPool().query<{ id: string }>(`INSERT INTO users (id,username,email,password_hash,role,company_id) VALUES (gen_random_uuid(),'mv_'||substr(md5(random()::text),1,12),'mv_'||substr(md5(random()::text),1,12)||'@t.local','x',$1,$2) RETURNING id`, [role, companyId]); return rows[0]!.id; }
async function mkUnit(companyId: string) { const { rows } = await getPool().query<{ id: string }>(`INSERT INTO org_units (id,company_id,name,kind) VALUES (gen_random_uuid(),$1,'u','unit') RETURNING id`, [companyId]); return rows[0]!.id; }
const userRow = async (id: string) => (await getPool().query<{ company_id: string; role: string; org_unit_id: string | null }>(`SELECT company_id, role, org_unit_id FROM users WHERE id=$1`, [id])).rows[0]!;

before(async () => {
  if (dbSkip) return;
  const cfg = loadConfig();
  const pool = getPool();
  jwt = createJwt(cfg);
  const roles = new RoleRepository(pool);
  roleService = new RoleService(roles);
  users = new UserRepository(pool);
  await roleService.syncBuiltins();

  ids.compA = await mkCompany("MV A"); ids.compB = await mkCompany("MV B");
  ids.unitA = await mkUnit(ids.compA); ids.unitB = await mkUnit(ids.compB);
  ids.roleA = (await roles.create({ key: "mv_role_a_" + Date.now(), name: "MV RoleA", permissions: ["resources:write"], companyId: ids.compA })).id;
  const roleAKey = (await roles.getById(ids.roleA)).key;
  ids.roleB = (await roles.create({ key: "mv_role_b_" + Date.now(), name: "MV RoleB", permissions: ["resources:write"], companyId: ids.compB })).id;
  const roleBKey = (await roles.getById(ids.roleB)).key;
  await roleService.reload();
  (ids as Record<string, string>).roleAKey = roleAKey;
  (ids as Record<string, string>).roleBKey = roleBKey;

  ids.userA = await mkUser(roleAKey, ids.compA);
  ids.superU = await mkUser("super_admin", ids.compA);
  ids.adminA = await mkUser("admin", ids.compA);
  tok.super = (await jwt.issuePair(ids.superU, "super_admin")).access.token;
  tok.admin = (await jwt.issuePair(ids.adminA, "admin")).access.token;

  app = Fastify();
  await app.register(makeOrganizationRoutes({
    companies: new CompanyRepository(pool), units: new OrgUnitRepository(pool),
    users, audit: new AuditRepository(pool), jwt, roleService,
  }), { prefix: "/api/v1/org" });
  await app.ready();
});

after(async () => {
  if (dbSkip) return;
  await app?.close();
  const pool = getPool();
  await pool.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[ids.userA, ids.superU, ids.adminA]]);
  await pool.query(`DELETE FROM org_units WHERE id = ANY($1::uuid[])`, [[ids.unitA, ids.unitB]]);
  await pool.query(`DELETE FROM roles WHERE id = ANY($1::uuid[])`, [[ids.roleA, ids.roleB]]);
  await pool.query(`DELETE FROM companies WHERE id = ANY($1::uuid[])`, [[ids.compA, ids.compB]]);
  await closePool();
});

const assign = (tokn: string | undefined, body: Record<string, unknown>) =>
  app.inject({ method: "PUT", url: `/api/v1/org/users/${ids.userA}/assignment`, headers: bearer(tokn), payload: body });

test("MOVE-RBAC-001: move to company B without a role is DENIED, DB unchanged", { skip: dbSkip }, async () => {
  const before = await userRow(ids.userA);
  const r = await assign(tok.super, { company_id: ids.compB });
  assert.equal(r.statusCode, 400);
  const after = await userRow(ids.userA);
  assert.deepEqual(after, before, "no partial mutation");
});

test("MOVE-RBAC-002: move to company B WITH a valid destination role passes", { skip: dbSkip }, async () => {
  const roleBKey = (ids as Record<string, string>).roleBKey;
  const r = await assign(tok.super, { company_id: ids.compB, org_unit_id: ids.unitB, role: roleBKey });
  assert.equal(r.statusCode, 200);
  const after = await userRow(ids.userA);
  assert.equal(after.company_id, ids.compB);
  assert.equal(after.role, roleBKey);
});

test("MOVE-RBAC-004: after the move the user no longer holds company A's role", { skip: dbSkip }, async () => {
  const roleAKey = (ids as Record<string, string>).roleAKey;
  const after = await userRow(ids.userA);
  assert.notEqual(after.role, roleAKey, "editing role A can no longer affect this user");
  // move back to A with a built-in role for the remaining tests
  await assign(tok.super, { company_id: ids.compA, org_unit_id: ids.unitA, role: "user" });
});

test("MOVE-RBAC-003: move with an allowed built-in role passes", { skip: dbSkip }, async () => {
  const r = await assign(tok.super, { company_id: ids.compB, role: "user" });
  assert.equal(r.statusCode, 200);
  assert.equal((await userRow(ids.userA)).company_id, ids.compB);
  await assign(tok.super, { company_id: ids.compA, role: "user" }); // reset
});

test("MOVE-RBAC-005: destination company B + org unit from company A is DENIED, no partial", { skip: dbSkip }, async () => {
  const before = await userRow(ids.userA);
  const r = await assign(tok.super, { company_id: ids.compB, org_unit_id: ids.unitA, role: "user" });
  assert.equal(r.statusCode, 400);
  assert.deepEqual(await userRow(ids.userA), before);
});

test("MOVE-RBAC-006: destination company B + role owned by company A is DENIED", { skip: dbSkip }, async () => {
  const roleAKey = (ids as Record<string, string>).roleAKey;
  const before = await userRow(ids.userA);
  const r = await assign(tok.super, { company_id: ids.compB, role: roleAKey });
  assert.equal(r.statusCode, 400);
  assert.deepEqual(await userRow(ids.userA), before);
});

test("MOVE-RBAC-007: a failing role in the same txn rolls back the whole move (atomicity)", { skip: dbSkip }, async () => {
  const before = await userRow(ids.userA);
  // setOrg with a non-existent role -> FK violation -> ROLLBACK; company/org must be unchanged.
  await assert.rejects(() => users.setOrg(ids.userA, ids.compB, ids.unitB, "does_not_exist_role"));
  assert.deepEqual(await userRow(ids.userA), before, "company/org/role all unchanged after rollback");
});

test("MOVE-RBAC-008: a tenant admin cannot move a user to another company", { skip: dbSkip }, async () => {
  const before = await userRow(ids.userA);
  const r = await assign(tok.admin, { company_id: ids.compB, role: "user" });
  assert.equal(r.statusCode, 403);
  assert.deepEqual(await userRow(ids.userA), before);
});
