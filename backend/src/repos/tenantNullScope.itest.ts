/**
 * SEC-TENANT-001 (integration) — a non-super account with company_id=NULL must
 * NOT become global. Runs against a real migrated PostgreSQL; skips without
 * DATABASE_URL. TENANT-NULL-001..010 (+ residual null-company share).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { getPool, closePool, dbSkip } from "../test/db.js";
import { UserRepository } from "./userRepo.js";
import { AuditRepository } from "./otherRepos.js";
import { RoleRepository } from "./roleRepo.js";
import { HostRepository } from "./sessionRepos.js";
import { tenantScopeForActor } from "../domain/tenantScope.js";

const pool = () => getPool();
const NONE = tenantScopeForActor({ isSuper: false, companyId: null });
const GLOBAL = tenantScopeForActor({ isSuper: true, companyId: null });

async function makeCompany(name: string): Promise<string> {
  const { rows } = await pool().query<{ id: string }>(
    `INSERT INTO companies (id, name) VALUES (gen_random_uuid(), $1) RETURNING id`, [name]);
  return rows[0]!.id;
}
async function makeUser(companyId: string | null, role = "user"): Promise<string> {
  const { rows } = await pool().query<{ id: string }>(
    `INSERT INTO users (id, username, email, password_hash, role, company_id)
     VALUES (gen_random_uuid(), 'tn_' || substr(md5(random()::text),1,12),
             'tn_' || substr(md5(random()::text),1,12) || '@t.local', 'x', $2, $1)
     RETURNING id`, [companyId, role]);
  return rows[0]!.id;
}
async function auditFor(userId: string, action = "login_success") {
  await pool().query(
    `INSERT INTO audit_logs (timestamp, user_id, action, success) VALUES (NOW(), $1, $2, TRUE)`,
    [userId, action]);
}

let compA = "", compB = "", uA = "", uB = "", uNull1 = "", uNull2 = "", customRoleId = "";

before(async () => {
  if (dbSkip) return;
  compA = await makeCompany("TN Company A");
  compB = await makeCompany("TN Company B");
  uA = await makeUser(compA);
  uB = await makeUser(compB);
  uNull1 = await makeUser(null, "admin");   // null-company "admin"
  uNull2 = await makeUser(null, "auditor"); // null-company "auditor"
  await auditFor(uA); await auditFor(uB); await auditFor(uNull1);
  // a company-A custom role (should never be visible to a null-company actor)
  const { rows } = await pool().query<{ id: string }>(
    `INSERT INTO roles (key, name, description, permissions, is_builtin, company_id)
     VALUES ('tn_custom_' || substr(md5(random()::text),1,6), 'TN Custom', null, ARRAY['resources:write'], FALSE, $1)
     RETURNING id`, [compA]);
  customRoleId = rows[0]!.id;
});

after(async () => {
  if (dbSkip) return;
  await pool().query(`DELETE FROM audit_logs WHERE user_id = ANY($1::uuid[])`, [[uA, uB, uNull1, uNull2]]);
  await pool().query(`DELETE FROM roles WHERE id = $1`, [customRoleId]);
  await pool().query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[uA, uB, uNull1, uNull2]]);
  await pool().query(`DELETE FROM companies WHERE id = ANY($1::uuid[])`, [[compA, compB]]);
  await closePool();
});

test("TENANT-NULL-001: null-company user cannot list global users", { skip: dbSkip }, async () => {
  const users = new UserRepository(pool());
  const { users: rows, total } = await users.list(500, 0, NONE);
  assert.equal(total, 0);
  assert.equal(rows.length, 0);
});

test("TENANT-NULL-002: null-company auditor cannot read global audit", { skip: dbSkip }, async () => {
  const audit = new AuditRepository(pool());
  const { entries, total } = await audit.list({ scope: NONE });
  assert.equal(total, 0);
  assert.equal(entries.length, 0);
});

test("TENANT-NULL-003: null-company admin does not inherit global access", { skip: dbSkip }, async () => {
  // role='admin' but companyId=null and not super → scope none → empty
  const scope = tenantScopeForActor({ isSuper: false, companyId: null });
  assert.equal(scope.kind, "none");
  const users = new UserRepository(pool());
  assert.equal((await users.list(500, 0, scope)).total, 0);
});

test("TENANT-NULL-004: null-company custom-role view is scoped to built-ins only", { skip: dbSkip }, async () => {
  const roles = new RoleRepository(pool());
  const list = await roles.listForScope(NONE);
  assert.ok(list.length > 0, "built-ins are visible");
  assert.ok(list.every((r) => r.isBuiltin), "no custom roles leak to a null-company actor");
  assert.ok(!list.some((r) => r.id === customRoleId), "company-A custom role not visible");
});

test("TENANT-NULL-005: super-admin still has global access", { skip: dbSkip }, async () => {
  const users = new UserRepository(pool());
  const audit = new AuditRepository(pool());
  const roles = new RoleRepository(pool());
  assert.ok((await users.list(500, 0, GLOBAL)).total >= 4, "super sees all users");
  assert.ok((await audit.list({ scope: GLOBAL })).total >= 3, "super sees all audit");
  assert.ok((await roles.listForScope(GLOBAL)).some((r) => r.id === customRoleId), "super sees custom roles");
});

test("TENANT-NULL-006/007: company user sees own company only", { skip: dbSkip }, async () => {
  const users = new UserRepository(pool());
  const scopeA = tenantScopeForActor({ isSuper: false, companyId: compA });
  const { users: rows } = await users.list(500, 0, scopeA);
  assert.ok(rows.some((u) => u.id === uA), "sees own-company user");
  assert.ok(!rows.some((u) => u.id === uB), "does NOT see company B user");
  assert.ok(!rows.some((u) => u.id === uNull1), "does NOT see null-company user");
});

test("TENANT-NULL-008: company A cannot see company B audit", { skip: dbSkip }, async () => {
  const audit = new AuditRepository(pool());
  const scopeA = tenantScopeForActor({ isSuper: false, companyId: compA });
  const { entries } = await audit.list({ scope: scopeA, limit: 200 });
  assert.ok(entries.some((e) => e.userId === uA), "sees own-company event");
  assert.ok(!entries.some((e) => e.userId === uB), "does NOT see company B event");
});

test("TENANT-NULL-009: null/undefined never yields global scope", { skip: dbSkip }, () => {
  assert.equal(tenantScopeForActor({ isSuper: false, companyId: null }).kind, "none");
  assert.equal(tenantScopeForActor({ isSuper: false, companyId: undefined }).kind, "none");
  assert.equal(tenantScopeForActor({ isSuper: false, companyId: "" }).kind, "none");
  assert.equal(tenantScopeForActor({ isSuper: true, companyId: null }).kind, "global");
});

test("TENANT-NULL-010: repository scope API fails closed on 'none'", { skip: dbSkip }, async () => {
  const users = new UserRepository(pool());
  const audit = new AuditRepository(pool());
  const roles = new RoleRepository(pool());
  assert.equal((await users.list(10, 0, NONE)).total, 0);
  assert.equal((await audit.list({ scope: NONE })).total, 0);
  assert.ok((await roles.listForScope(NONE)).every((r) => r.isBuiltin));
});

test("TENANT-NULL-011: null-company user cannot share a host with another null-company user", { skip: dbSkip }, async () => {
  const hosts = new HostRepository(pool());
  const h = await hosts.create({
    userId: uNull1, name: "null-share-" + Date.now(), hostname: "10.0.0.9", port: 22,
    protocol: "ssh", isShared: true,
  });
  // sharing from a null-company owner must be rejected entirely
  await assert.rejects(() => hosts.setShares(uNull1, h.id, [uNull2]), /cross|company/i);
  await pool().query(`DELETE FROM hosts WHERE id = $1`, [h.id]);
});
