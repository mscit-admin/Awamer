/**
 * SEC-NET-001 (integration) — network diagnostics require the dedicated
 * network:diagnose permission, block infra-sensitive targets, cap scans, rate
 * limit, and audit. Real PostgreSQL + real routes. NET-SCOPE-001..010.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";
import { v4 as uuid } from "uuid";
import { createJwt, type JwtService } from "../jwt/index.js";
import { loadConfig } from "../config/index.js";
import { UserRepository } from "../repos/userRepo.js";
import { AuditRepository } from "../repos/otherRepos.js";
import { makeNetworkRoutes } from "./network.js";
import { getPool, closePool, dbSkip } from "../test/db.js";

let app: FastifyInstance, jwt: JwtService, users: UserRepository;
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
async function mkUser(role: string): Promise<string> {
  const id = uuid();
  await getPool().query(
    `INSERT INTO users (id,username,email,password_hash,role,is_active)
     VALUES ($1,'ns_'||substr(md5(random()::text),1,12),'ns_'||substr(md5(random()::text),1,12)||'@t.local','x',$2,TRUE)`, [id, role]);
  return id;
}
const tok = async (id: string, role: string) => (await jwt.issuePair(id, role, 1)).access.token;
const post = (url: string, t: string, body: Record<string, unknown>) =>
  app.inject({ method: "POST", url, headers: bearer(t), payload: body });

before(async () => {
  if (dbSkip) return;
  const cfg = loadConfig();
  jwt = createJwt(cfg);
  const pool = getPool();
  users = new UserRepository(pool);
  app = Fastify();
  await app.register(makeNetworkRoutes({ users, jwt, audit: new AuditRepository(pool) }), { prefix: "/api/v1/network" });
  await app.ready();
});
after(async () => {
  if (dbSkip) return;
  await app.close();
  await getPool().query(`DELETE FROM audit_logs WHERE action='network_diagnose' AND user_id IN (SELECT id FROM users WHERE username LIKE 'ns\\_%')`);
  await getPool().query(`DELETE FROM users WHERE username LIKE 'ns\\_%'`);
  await closePool();
});

test("NET-SCOPE-001: standard user cannot run diagnostics", { skip: dbSkip }, async () => {
  const id = await mkUser("user"); const t = await tok(id, "user");
  const res = await post("/api/v1/network/scan", t, { cidr: "192.168.1.0/30" });
  assert.equal(res.statusCode, 403);
});

test("NET-SCOPE-002/009: authorized admin can diagnose an approved target", { skip: dbSkip }, async () => {
  const id = await mkUser("admin"); const t = await tok(id, "admin");
  const res = await post("/api/v1/network/port-check", t, { host: "8.8.8.8", port: 53 });
  assert.equal(res.statusCode, 200); // authorized (result ok/failed both fine)
});

test("NET-SCOPE-003: app infra ('restricted assets') cannot be probed even by admin", { skip: dbSkip }, async () => {
  const id = await mkUser("admin"); const t = await tok(id, "admin");
  // the backend + DB live on loopback/metadata-reachable infra
  const r1 = await post("/api/v1/network/port-check", t, { host: "127.0.0.1", port: 5432 });
  assert.equal(r1.statusCode, 403);
});

test("NET-SCOPE-004: loopback rejected", { skip: dbSkip }, async () => {
  const id = await mkUser("admin"); const t = await tok(id, "admin");
  assert.equal((await post("/api/v1/network/ping", t, { host: "127.0.0.1" })).statusCode, 403);
});

test("NET-SCOPE-005: cloud metadata rejected", { skip: dbSkip }, async () => {
  const id = await mkUser("admin"); const t = await tok(id, "admin");
  assert.equal((await post("/api/v1/network/ping", t, { host: "169.254.169.254" })).statusCode, 403);
});

test("NET-SCOPE-006: oversized CIDR rejected", { skip: dbSkip }, async () => {
  const id = await mkUser("admin"); const t = await tok(id, "admin");
  const res = await post("/api/v1/network/scan", t, { cidr: "10.0.0.0/16" });
  assert.equal(res.statusCode, 400);
});

test("NET-SCOPE-007: too many ports rejected", { skip: dbSkip }, async () => {
  const id = await mkUser("admin"); const t = await tok(id, "admin");
  const res = await post("/api/v1/network/scan", t, { cidr: "192.168.9.0/30", ports: Array.from({ length: 13 }, (_, i) => 1000 + i) });
  assert.equal(res.statusCode, 400);
});

test("NET-SCOPE-008: rate limit enforced", { skip: dbSkip }, async () => {
  const id = await mkUser("admin"); const t = await tok(id, "admin");
  let got429 = false;
  for (let i = 0; i < 45; i++) {
    // invalid body → fast 400 (after the rate-limit preHandler has counted it)
    const res = await post("/api/v1/network/ping", t, { host: "" });
    if (res.statusCode === 429) { got429 = true; break; }
  }
  assert.ok(got429, "expected a 429 after exceeding the per-user limit");
});

test("NET-SCOPE-010: a diagnostic action is audited", { skip: dbSkip }, async () => {
  const id = await mkUser("admin"); const t = await tok(id, "admin");
  await post("/api/v1/network/port-check", t, { host: "8.8.8.8", port: 53 });
  const { rows } = await getPool().query<{ n: string }>(
    `SELECT COUNT(*)::text n FROM audit_logs WHERE user_id=$1 AND action='network_diagnose'`, [id]);
  assert.ok(Number(rows[0]!.n) >= 1, "network_diagnose audit event recorded");
});
