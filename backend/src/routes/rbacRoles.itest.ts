/**
 * SEC-016 — custom-role privilege-escalation gate (integration, real PG).
 * Boots the real roles + admin routes via app.inject and exercises the
 * mandatory TEST-RBAC-001..008. Skips without DATABASE_URL.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../config/index.js";
import { createLogger } from "../logger/index.js";
import { createJwt, type JwtService } from "../jwt/index.js";
import { DomainError } from "../domain/index.js";
import { RoleRepository } from "../repos/roleRepo.js";
import { RoleService } from "../domain/roleService.js";
import { UserRepository } from "../repos/userRepo.js";
import { RefreshRepository, AuditRepository } from "../repos/otherRepos.js";
import { RegisterUseCase } from "../usecases/register.js";
import { ChangePasswordUseCase } from "../usecases/changePassword.js";
import { MFAUseCase } from "../usecases/mfa.js";
import { makeRoleRoutes } from "./roles.js";
import { makeAdminRoutes } from "./admin.js";
import { createArgon2 } from "../crypto/argon2.js";
import { getPool, closePool, dbSkip } from "../test/db.js";

let app: FastifyInstance;
let jwt: JwtService;
let roles: RoleRepository;
const ids = { compA: "", compB: "", superA: "", adminA: "", tadminUser: "", otherA: "", roleTadmin: "", roleEditA: "", roleB: "" };
const tok: Record<string, string> = {};

async function mkCompany(name: string): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(`INSERT INTO companies (id, name) VALUES (gen_random_uuid(), $1) RETURNING id`, [name]);
  return rows[0]!.id;
}
async function mkUser(role: string, companyId: string): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO users (id, username, email, password_hash, role, company_id)
     VALUES (gen_random_uuid(), 'rb_'||substr(md5(random()::text),1,12), 'rb_'||substr(md5(random()::text),1,12)||'@t.local','x',$1,$2) RETURNING id`,
    [role, companyId]);
  return rows[0]!.id;
}
const bearer = (t: string | undefined) => ({ authorization: `Bearer ${t ?? ""}` });

before(async () => {
  if (dbSkip) return;
  const cfg = loadConfig();
  const log = createLogger(cfg);
  const pool = getPool();
  jwt = createJwt(cfg);
  const argon2 = createArgon2(cfg);
  roles = new RoleRepository(pool);
  const roleService = new RoleService(roles);
  const users = new UserRepository(pool);
  const audit = new AuditRepository(pool);
  const refresh = new RefreshRepository(pool);
  await roleService.syncBuiltins();

  ids.compA = await mkCompany("RBAC A");
  ids.compB = await mkCompany("RBAC B");
  // Custom tenant-admin role in A: users:manage + resources:write, but NOT
  // credentials:reveal and NOT companies:manage.
  const rTadmin = await roles.create({ key: "rbac_tadmin_" + Date.now(), name: "RBAC TAdmin", permissions: ["users:manage", "resources:write"], companyId: ids.compA });
  ids.roleTadmin = rTadmin.id;
  const rEdit = await roles.create({ key: "rbac_edit_a_" + Date.now(), name: "RBAC EditA", permissions: ["resources:write"], companyId: ids.compA });
  ids.roleEditA = rEdit.id;
  const rB = await roles.create({ key: "rbac_b_" + Date.now(), name: "RBAC B role", permissions: ["resources:write"], companyId: ids.compB });
  ids.roleB = rB.id;
  await roleService.reload();

  ids.superA = await mkUser("super_admin", ids.compA);
  ids.adminA = await mkUser("admin", ids.compA);
  ids.tadminUser = await mkUser(rTadmin.key, ids.compA);
  ids.otherA = await mkUser("user", ids.compA);

  tok.super = (await jwt.issuePair(ids.superA, "super_admin")).access.token;
  tok.admin = (await jwt.issuePair(ids.adminA, "admin")).access.token;
  tok.tadmin = (await jwt.issuePair(ids.tadminUser, rTadmin.key)).access.token;

  app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof DomainError) return reply.code(400).send({ error: { code: err.code } });
    reply.code(500).send({ error: { code: "internal" } });
  });
  const changePassword = new ChangePasswordUseCase(users, refresh, audit, argon2);
  const register = new RegisterUseCase(users, audit, argon2);
  // Not exercised by the RBAC tests (only /disable-mfa uses it) — stub it.
  const mfa = {} as unknown as MFAUseCase;
  await app.register(makeRoleRoutes({ roles, roleService, audit, jwt, users }), { prefix: "/api/v1/roles" });
  await app.register(makeAdminRoutes({ users, register, changePassword, mfa, roleService, jwt, refresh }), { prefix: "/api/v1/admin" });
  await app.ready();
});

after(async () => {
  if (dbSkip) return;
  await app?.close();
  const pool = getPool();
  await pool.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[ids.superA, ids.adminA, ids.tadminUser, ids.otherA]]);
  await pool.query(`DELETE FROM roles WHERE id = ANY($1::uuid[])`, [[ids.roleTadmin, ids.roleEditA, ids.roleB]]);
  await pool.query(`DELETE FROM companies WHERE id = ANY($1::uuid[])`, [[ids.compA, ids.compB]]);
  await closePool();
});

test("TEST-RBAC-001: tenant admin cannot add companies:manage to a role", { skip: dbSkip }, async () => {
  const r = await app.inject({ method: "PATCH", url: `/api/v1/roles/${ids.roleEditA}`, headers: bearer(tok.tadmin), payload: { permissions: ["resources:write", "companies:manage"] } });
  assert.equal(r.statusCode, 403);
});

test("TEST-RBAC-002: tenant admin cannot add a permission they do not hold (credentials:reveal)", { skip: dbSkip }, async () => {
  const r = await app.inject({ method: "PATCH", url: `/api/v1/roles/${ids.roleEditA}`, headers: bearer(tok.tadmin), payload: { permissions: ["resources:write", "credentials:reveal"] } });
  assert.equal(r.statusCode, 403);
});

test("TEST-RBAC-003: tenant admin may set only permissions they hold", { skip: dbSkip }, async () => {
  const r = await app.inject({ method: "PATCH", url: `/api/v1/roles/${ids.roleEditA}`, headers: bearer(tok.tadmin), payload: { permissions: ["resources:write"] } });
  assert.equal(r.statusCode, 200);
});

test("TEST-RBAC-004: tenant admin A cannot edit company B's custom role", { skip: dbSkip }, async () => {
  const r = await app.inject({ method: "PATCH", url: `/api/v1/roles/${ids.roleB}`, headers: bearer(tok.tadmin), payload: { name: "hijacked" } });
  assert.equal(r.statusCode, 404, "non-disclosing 404 for another tenant's role");
});

test("TEST-RBAC-005: admin cannot assign super_admin to themselves", { skip: dbSkip }, async () => {
  const r = await app.inject({ method: "PATCH", url: `/api/v1/admin/users/${ids.adminA}`, headers: bearer(tok.admin), payload: { role: "super_admin" } });
  assert.equal(r.statusCode, 403);
});

test("TEST-RBAC-006: admin cannot assign super_admin to another user", { skip: dbSkip }, async () => {
  const r = await app.inject({ method: "PATCH", url: `/api/v1/admin/users/${ids.otherA}`, headers: bearer(tok.admin), payload: { role: "super_admin" } });
  assert.equal(r.statusCode, 403);
});

test("TEST-RBAC-007: a blocked escalation leaves the role without the extra permission (stale JWT cannot gain it)", { skip: dbSkip }, async () => {
  // The earlier 403s must NOT have persisted companies:manage on the role.
  const rec = await roles.getById(ids.roleEditA);
  assert.equal(rec.permissions.includes("companies:manage"), false);
  assert.equal(rec.permissions.includes("credentials:reveal"), false);
});

test("TEST-RBAC-008: super-admin may grant a global permission", { skip: dbSkip }, async () => {
  const r = await app.inject({ method: "PATCH", url: `/api/v1/roles/${ids.roleEditA}`, headers: bearer(tok.super), payload: { permissions: ["resources:write", "companies:manage"] } });
  assert.equal(r.statusCode, 200);
  // revert so cleanup/other assertions stay clean
  await app.inject({ method: "PATCH", url: `/api/v1/roles/${ids.roleEditA}`, headers: bearer(tok.super), payload: { permissions: ["resources:write"] } });
});
