/**
 * Network CIDR hardening (integration) — the diagnostics routes enforce the
 * explicit allow-list policy: private targets are denied unless allow-listed,
 * sensitive/infra destinations are always denied, hostnames are resolved once
 * and validated (DNS-rebinding safe), and the audit records both the requested
 * host and the validated destination IP. Real PostgreSQL + real routes.
 *
 * NET-CIDR-001..015.
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
import { parseCidrList, type NetworkDiagnosticPolicy } from "../usecases/networkPolicy.js";
import { getPool, closePool, dbSkip } from "../test/db.js";

let app: FastifyInstance, jwt: JwtService, users: UserRepository;
// An allow list scoped to the lower half of one LAN (a /25); the Docker/DB infra
// subnet is NOT listed. A /25 lets us exercise a genuine partial-overlap request
// (a /24 that spills past the allowed /25) which still clears the scan size gate.
const POLICY: NetworkDiagnosticPolicy = { allowed: parseCidrList("192.168.10.0/25"), deny: [] };
// A controllable resolver so hostname cases are deterministic (no real DNS).
const dnsMap: Record<string, string[]> = {};

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
async function mkUser(role: string): Promise<string> {
  const id = uuid();
  await getPool().query(
    `INSERT INTO users (id,username,email,password_hash,role,is_active)
     VALUES ($1,'nc_'||substr(md5(random()::text),1,12),'nc_'||substr(md5(random()::text),1,12)||'@t.local','x',$2,TRUE)`, [id, role]);
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
  await app.register(makeNetworkRoutes({
    users, jwt, audit: new AuditRepository(pool), policy: POLICY,
    resolveHost: async (h: string) => {
      if (h in dnsMap) return dnsMap[h]!;
      throw new Error("nxdomain");
    },
  }), { prefix: "/api/v1/network" });
  await app.ready();
});
after(async () => {
  if (dbSkip) return;
  await app.close();
  await getPool().query(`DELETE FROM audit_logs WHERE action='network_diagnose' AND user_id IN (SELECT id FROM users WHERE username LIKE 'nc\\_%')`);
  await getPool().query(`DELETE FROM users WHERE username LIKE 'nc\\_%'`);
  await closePool();
});

async function adminTok(): Promise<string> { const id = await mkUser("admin"); return tok(id, "admin"); }

test("NET-CIDR-001: with the target not in the allow list, a private address is denied", { skip: dbSkip }, async () => {
  const t = await adminTok();
  // 10.0.0.5 is private and NOT inside 192.168.10.0/24 → denied.
  assert.equal((await post("/api/v1/network/ping", t, { host: "10.0.0.5" })).statusCode, 403);
});

test("NET-CIDR-002: an explicitly allowed /24 target is permitted", { skip: dbSkip }, async () => {
  const t = await adminTok();
  const res = await post("/api/v1/network/port-check", t, { host: "192.168.10.20", port: 65000 });
  assert.equal(res.statusCode, 200, res.body); // allowed (connection result itself may be closed)
});

test("NET-CIDR-003: a subnet inside an allowed CIDR can be scanned", { skip: dbSkip }, async () => {
  const t = await adminTok();
  const res = await post("/api/v1/network/scan", t, { cidr: "192.168.10.0/28" });
  assert.equal(res.statusCode, 200, res.body);
});

test("NET-CIDR-004: a CIDR outside the allow list is rejected", { skip: dbSkip }, async () => {
  const t = await adminTok();
  assert.equal((await post("/api/v1/network/scan", t, { cidr: "192.168.20.0/24" })).statusCode, 403);
});

test("NET-CIDR-005: a partially-overlapping CIDR is rejected", { skip: dbSkip }, async () => {
  const t = await adminTok();
  // A /24 request overlaps the allowed /25 for its first half but spills into
  // .128-.255 which is NOT allowed → not fully contained → denied (403), and it
  // still passes the /24 scan size gate so this is a policy rejection, not a 400.
  assert.equal((await post("/api/v1/network/scan", t, { cidr: "192.168.10.0/24" })).statusCode, 403);
});

test("NET-CIDR-006: loopback is rejected", { skip: dbSkip }, async () => {
  const t = await adminTok();
  assert.equal((await post("/api/v1/network/ping", t, { host: "127.0.0.1" })).statusCode, 403);
});

test("NET-CIDR-007: link-local is rejected", { skip: dbSkip }, async () => {
  const t = await adminTok();
  assert.equal((await post("/api/v1/network/ping", t, { host: "169.254.1.1" })).statusCode, 403);
});

test("NET-CIDR-008: the cloud metadata IP is rejected", { skip: dbSkip }, async () => {
  const t = await adminTok();
  assert.equal((await post("/api/v1/network/ping", t, { host: "169.254.169.254" })).statusCode, 403);
});

test("NET-CIDR-009: a Docker/internal subnet not in the allow list is rejected", { skip: dbSkip }, async () => {
  const t = await adminTok();
  // The Docker bridge (172.17.0.0/16) is private and not allow-listed → denied,
  // proving RFC1918 membership alone does not grant access.
  assert.equal((await post("/api/v1/network/ping", t, { host: "172.17.0.1" })).statusCode, 403);
  assert.equal((await post("/api/v1/network/scan", t, { cidr: "172.17.0.0/28" })).statusCode, 403);
});

test("NET-CIDR-010: a hostname resolving outside the allow list is rejected", { skip: dbSkip }, async () => {
  const t = await adminTok();
  dnsMap["evil.example"] = ["10.9.9.9"]; // private, not allow-listed
  assert.equal((await post("/api/v1/network/ping", t, { host: "evil.example" })).statusCode, 403);
});

test("NET-CIDR-011: a DNS-rebinding hostname (one allowed + one sensitive) is rejected", { skip: dbSkip }, async () => {
  const t = await adminTok();
  // The resolver returns an allowed IP AND a sensitive one; we must reject the
  // whole request rather than cherry-pick the allowed address.
  dnsMap["rebind.example"] = ["192.168.10.10", "169.254.169.254"];
  assert.equal((await post("/api/v1/network/ping", t, { host: "rebind.example" })).statusCode, 403);
});

test("NET-CIDR-012: an authorized hostname resolving to an allowed IP works", { skip: dbSkip }, async () => {
  const t = await adminTok();
  dnsMap["lan-host.example"] = ["192.168.10.77"];
  const res = await post("/api/v1/network/port-check", t, { host: "lan-host.example", port: 65001 });
  assert.equal(res.statusCode, 200, res.body);
});

test("NET-CIDR-013: a standard user still lacks network:diagnose", { skip: dbSkip }, async () => {
  const id = await mkUser("user"); const t = await tok(id, "user");
  assert.equal((await post("/api/v1/network/ping", t, { host: "192.168.10.20" })).statusCode, 403);
});

test("NET-CIDR-014: an authorized admin with an allowed target succeeds", { skip: dbSkip }, async () => {
  const t = await adminTok();
  const res = await post("/api/v1/network/port-check", t, { host: "192.168.10.30", port: 65002 });
  assert.equal(res.statusCode, 200, res.body);
});

test("NET-CIDR-015: the audit records the requested host and the validated IP", { skip: dbSkip }, async () => {
  const id = await mkUser("admin"); const t = await tok(id, "admin");
  dnsMap["audit-host.example"] = ["192.168.10.99"];
  await post("/api/v1/network/port-check", t, { host: "audit-host.example", port: 65003 });
  const { rows } = await getPool().query<{ details: any }>(
    `SELECT details FROM audit_logs WHERE user_id=$1 AND action='network_diagnose' ORDER BY "timestamp" DESC LIMIT 1`, [id]);
  const d = rows[0]!.details;
  assert.match(String(d.target), /audit-host\.example/, "requested host audited");
  assert.equal(d.resolvedIp, "192.168.10.99", "validated destination IP audited");
});
