/**
 * AWM-SEC-021 — a stale access token must lose its authorization the moment the
 * account's security state changes (role, company, disabled, locked, deleted).
 * Exercises the real auth middleware (`makeAuthMiddleware`) against a real
 * PostgreSQL via app.inject. AUTHZ-STATE-001..005, 008. (006/007 cover the WS
 * channels in authStateWs.itest.ts.)
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";
import { v4 as uuid } from "uuid";
import { loadConfig } from "../config/index.js";
import { createJwt, type JwtService } from "../jwt/index.js";
import { UserRepository } from "../repos/userRepo.js";
import { makeAuthMiddleware, requirePermission } from "./auth.js";
import { getPool, closePool, dbSkip } from "../test/db.js";

let app: FastifyInstance;
let jwt: JwtService;
let users: UserRepository;
const ids = { compA: "", compB: "", u: "", d: "", normal: "" };
const tok: Record<string, string> = {};
const bearer = (t: string | undefined) => ({ authorization: `Bearer ${t ?? ""}` });

async function mkCompany(n: string) {
  const { rows } = await getPool().query<{ id: string }>(`INSERT INTO companies (id,name) VALUES (gen_random_uuid(),$1) RETURNING id`, [n]);
  return rows[0]!.id;
}
async function mkUser(role: string, companyId: string | null) {
  const id = uuid();
  await getPool().query(
    `INSERT INTO users (id,username,email,password_hash,role,is_active,company_id)
     VALUES ($1,'as_'||substr(md5(random()::text),1,12),'as_'||substr(md5(random()::text),1,12)||'@t.local','x',$2,TRUE,$3)`,
    [id, role, companyId],
  );
  return id;
}
const token = async (id: string, role: string) => (await jwt.issuePair(id, role)).access.token;
/** Force a user's role in the DB (mirrors what an admin role change persists). */
async function setRole(id: string, role: string) {
  const u = await users.getById(id); u.role = role as typeof u.role; await users.update(u);
}
async function setActive(id: string, active: boolean) {
  const u = await users.getById(id); u.isActive = active; await users.update(u);
}

before(async () => {
  if (dbSkip) return;
  const cfg = loadConfig();
  jwt = createJwt(cfg);
  users = new UserRepository(getPool());
  ids.compA = await mkCompany("AS A");
  ids.compB = await mkCompany("AS B");
  ids.u = await mkUser("admin", ids.compA);
  ids.d = await mkUser("admin", ids.compA);
  ids.normal = await mkUser("admin", ids.compA);

  app = Fastify();
  await app.register(async (a) => {
    a.addHook("preHandler", makeAuthMiddleware(jwt, users));
    a.get("/priv", { preHandler: [requirePermission("users:manage")] }, async () => ({ ok: true }));
    a.get("/me", async (req) => ({ role: req.auth!.role }));
  }, { prefix: "/api/v1/t" });
  await app.ready();
});

after(async () => {
  if (dbSkip) return;
  await app?.close();
  const pool = getPool();
  await pool.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[ids.u, ids.d, ids.normal]]);
  await pool.query(`DELETE FROM companies WHERE id = ANY($1::uuid[])`, [[ids.compA, ids.compB]]);
  await closePool();
});

const priv = (t: string | undefined) => app.inject({ method: "GET", url: "/api/v1/t/priv", headers: bearer(t) });
const me = (t: string | undefined) => app.inject({ method: "GET", url: "/api/v1/t/me", headers: bearer(t) });

test("AUTHZ-STATE-001: role downgrade denies the OLD privileged token immediately", { skip: dbSkip }, async () => {
  await setRole(ids.u, "admin");
  const t = await token(ids.u, "admin");
  assert.equal((await priv(t)).statusCode, 200, "admin token can use the privileged route");
  await setRole(ids.u, "readonly"); // downgrade
  assert.equal((await priv(t)).statusCode, 403, "same token is now denied — live role is readonly");
  // The session itself is still valid (identity unchanged) but authorization uses the LIVE role.
  const meRes = await me(t);
  assert.equal(meRes.statusCode, 200);
  assert.equal(meRes.json().role, "readonly", "middleware surfaces the live DB role, not the token role");
});

test("AUTHZ-STATE-002: company move + downgrade denies the old token (no 15-min window)", { skip: dbSkip }, async () => {
  await setRole(ids.u, "admin");
  const t = await token(ids.u, "admin");
  assert.equal((await priv(t)).statusCode, 200);
  // Move to company B and downgrade to a global built-in role in the same commit.
  await users.setOrg(ids.u, ids.compB, null, "readonly");
  assert.equal((await priv(t)).statusCode, 403, "old admin token cannot act after the move+downgrade");
});

test("AUTHZ-STATE-003: disabling the account rejects the old token immediately", { skip: dbSkip }, async () => {
  await setRole(ids.u, "admin"); await setActive(ids.u, true);
  const t = await token(ids.u, "admin");
  assert.equal((await priv(t)).statusCode, 200);
  await setActive(ids.u, false); // disable
  const r = await priv(t);
  assert.equal(r.statusCode, 401, "disabled account's token is rejected");
  assert.equal(r.json().error.code, "session_invalidated");
  await setActive(ids.u, true); // restore for later tests
});

test("AUTHZ-STATE-004: locking the account rejects the old token immediately", { skip: dbSkip }, async () => {
  await setRole(ids.u, "admin");
  const t = await token(ids.u, "admin");
  assert.equal((await priv(t)).statusCode, 200);
  await users.setLocked(ids.u, true);
  assert.equal((await priv(t)).statusCode, 401, "locked account's token is rejected");
  await users.setLocked(ids.u, false);
  // A temporary auto-lock (locked_until in the future) is also rejected.
  await users.setLockedUntil(ids.u, new Date(Date.now() + 60_000));
  assert.equal((await priv(t)).statusCode, 401, "temp-locked account's token is rejected");
  await users.setLockedUntil(ids.u, null);
});

test("AUTHZ-STATE-005: deleting the account rejects the old token immediately", { skip: dbSkip }, async () => {
  const t = await token(ids.d, "admin");
  assert.equal((await priv(t)).statusCode, 200);
  await users.delete(ids.d);
  const r = await priv(t);
  assert.equal(r.statusCode, 401, "deleted account's token is rejected");
  assert.equal(r.json().error.code, "session_invalidated");
});

test("AUTHZ-STATE-008: an unchanged active user with a valid token keeps working", { skip: dbSkip }, async () => {
  const t = await token(ids.normal, "admin");
  assert.equal((await priv(t)).statusCode, 200, "no false invalidation for a normal user");
  assert.equal((await me(t)).statusCode, 200);
});
