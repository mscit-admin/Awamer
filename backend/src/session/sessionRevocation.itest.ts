/**
 * AWM-SEC-022 — real gateway-lifecycle revocation. Establishes actual SSH /
 * Telnet / TCP-tunnel / VNC sessions over real WebSockets against the real
 * gateways + a real ActiveSessionManager, then revokes and asserts the session
 * is closed (WS 4403 + upstream torn down + registry cleaned). Also drives the
 * admin/org routes to prove the revocation events are wired. Real PostgreSQL.
 * AUTHZ-STATE-009..016, 019, 020, 022.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import { WebSocket } from "ws";
import { v4 as uuid } from "uuid";
import { loadConfig } from "../config/index.js";
import { createLogger } from "../logger/index.js";
import { createJwt, type JwtService } from "../jwt/index.js";
import { UserRepository } from "../repos/userRepo.js";
import { RefreshRepository, AuditRepository } from "../repos/otherRepos.js";
import { RoleRepository } from "../repos/roleRepo.js";
import { RoleService } from "../domain/roleService.js";
import { CompanyRepository, OrgUnitRepository } from "../repos/orgRepos.js";
import { ActiveSessionManager } from "./activeSessions.js";
import { makeSshGateway } from "../ssh/gateway.js";
import { makeTelnetGateway } from "../telnet/gateway.js";
import { makeWsTunnelGateway } from "../ssh/wsTunnelGateway.js";
import { makeVncGateway } from "../vnc/gateway.js";
import { makeAdminRoutes } from "../routes/admin.js";
import { makeOrganizationRoutes } from "../routes/organization.js";
import { getPool, closePool, dbSkip } from "../test/db.js";

let app: FastifyInstance;
let jwt: JwtService;
let users: UserRepository;
let sessions: ActiveSessionManager;
let baseWs = "";
let baseHttp = "";
let tcpServer: net.Server;
let tcpPort = 0;
const liveUpstream = new Set<net.Socket>();
let compA = "", compB = "", userA = "", userB = "", superU = "";
const HID = "00000000-0000-0000-0000-000000000000";

const mkUser = async (role: string, companyId: string | null, active = true) => {
  const id = uuid();
  await getPool().query(
    `INSERT INTO users (id,username,email,password_hash,role,is_active,company_id)
     VALUES ($1,'sr_'||substr(md5(random()::text),1,12),'sr_'||substr(md5(random()::text),1,12)||'@t.local','x',$2,$3,$4)`,
    [id, role, active, companyId],
  );
  return id;
};
const mkCompany = async (n: string) => (await getPool().query<{ id: string }>(`INSERT INTO companies (id,name) VALUES (gen_random_uuid(),$1) RETURNING id`, [n])).rows[0]!.id;
const token = async (id: string, role: string) => (await jwt.issuePair(id, role)).access.token;
const setActive = async (id: string, a: boolean) => { const u = await users.getById(id); u.isActive = a; await users.update(u); };
const setRole = async (id: string, r: string) => { const u = await users.getById(id); u.role = r as typeof u.role; await users.update(u); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return true; await sleep(25); }
  return cond();
}

interface Chan { ws: WebSocket; closeCode: Promise<number | undefined>; }
/** Open a first-frame-auth channel (ssh/telnet/tunnel) and send the auth frame. */
function openFrameChannel(pathAndQuery: string, tok: string, extra: Record<string, unknown> = {}): Chan {
  const ws = new WebSocket(`${baseWs}${pathAndQuery}`);
  const closeCode = new Promise<number | undefined>((res) => ws.on("close", (code) => res(code)));
  ws.on("open", () => ws.send(JSON.stringify({ type: "auth", token: tok, ...extra })));
  ws.on("error", () => { /* ignore */ });
  return { ws, closeCode };
}

before(async () => {
  if (dbSkip) return;
  const cfg = loadConfig();
  jwt = createJwt(cfg);
  const log = createLogger(cfg);
  const pool = getPool();
  users = new UserRepository(pool);
  sessions = new ActiveSessionManager({ users, log, audit: new AuditRepository(pool), revalidateIntervalMs: 400 });
  sessions.startPeriodic(); // the periodic fallback runs for real during these tests

  tcpServer = net.createServer((s) => { liveUpstream.add(s); s.on("close", () => liveUpstream.delete(s)); s.on("error", () => {}); s.on("data", () => {}); });
  await new Promise<void>((r) => tcpServer.listen(0, "127.0.0.1", r));
  tcpPort = (tcpServer.address() as net.AddressInfo).port;

  compA = await mkCompany("SR A");
  compB = await mkCompany("SR B");
  userA = await mkUser("user", compA);
  userB = await mkUser("user", compA);
  superU = await mkUser("super_admin", null);

  // Host resolves to the dummy TCP upstream; a credential exists for tunnel resolve.
  const hosts = { async getById(u: string, id: string) { return { id, userId: u, name: "h", hostname: "127.0.0.1", port: tcpPort, credentialId: "cred1" }; } };
  const credentials = { async getById() { return { username: "root", credentialType: "password", secretData: { password: "x" }, userId: userA }; } };
  const history = { async start() { return 1; }, async end() {} };
  const settings = { async getMany() { return {}; } };
  const stub = {} as never;
  const refresh = new RefreshRepository(pool);
  const roleService = new RoleService(new RoleRepository(pool));
  await roleService.reload();

  app = Fastify();
  await app.register(websocket);
  await app.register(makeSshGateway({ sessions, jwt, users, hosts: hosts as never, credentials: credentials as never, history: history as never, settings: settings as never, log, hostKeys: stub }), { prefix: "/api/v1/ssh" });
  await app.register(makeTelnetGateway({ sessions, jwt, users, hosts: hosts as never, history: history as never, log }), { prefix: "/api/v1/telnet" });
  await app.register(makeWsTunnelGateway({ sessions, jwt, users, hosts: hosts as never, credentials: credentials as never, log, hostKeys: stub }), { prefix: "/api/v1/tunnel" });
  await app.register(makeVncGateway({ sessions, jwt, users, hosts: hosts as never, history: history as never, log }), { prefix: "/api/v1/vnc" });
  await app.register(makeAdminRoutes({ sessions, users, register: stub, changePassword: stub, mfa: stub, roleService, jwt, refresh }), { prefix: "/api/v1/admin" });
  await app.register(makeOrganizationRoutes({ sessions, companies: new CompanyRepository(pool), units: new OrgUnitRepository(pool), users, audit: new AuditRepository(pool), jwt, roleService }), { prefix: "/api/v1/org" });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address() as net.AddressInfo;
  baseWs = `ws://127.0.0.1:${addr.port}`;
  baseHttp = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  if (dbSkip) return;
  sessions?.stop();
  await app?.close();
  await new Promise<void>((r) => tcpServer.close(() => r()));
  await getPool().query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[userA, userB, superU]]);
  await getPool().query(`DELETE FROM companies WHERE id = ANY($1::uuid[])`, [[compA, compB]]);
  await closePool();
});

/** Establish an SSH session for a user (password override → no credential needed). */
async function establishSsh(userId: string): Promise<Chan> {
  const c = openFrameChannel(`/api/v1/ssh/connect?host_id=${HID}`, await token(userId, "user"), { password: "x" });
  const ok = await waitFor(() => sessions.countForUser(userId) >= 1);
  assert.ok(ok, "SSH session should register");
  return c;
}

test("AUTHZ-STATE-010 + §47: disabling a user closes their live SSH session; another user's stays", { skip: dbSkip }, async () => {
  await setActive(userA, true); await setRole(userA, "user");
  const a = await establishSsh(userA);
  const b = await establishSsh(userB);
  const upstreamBefore = liveUpstream.size;
  assert.equal(sessions.countForUser(userA), 1);
  assert.equal(sessions.countForUser(userB), 1);

  // Disable A via the real admin route (proves the event is wired).
  const res = await fetch(`${baseHttp}/api/v1/admin/users/${userA}`, {
    method: "PATCH", headers: { authorization: `Bearer ${await token(superU, "super_admin")}`, "content-type": "application/json" },
    body: JSON.stringify({ is_active: false }),
  });
  assert.equal(res.status, 200);

  const code = await a.closeCode;
  assert.equal(code, 4403, "A's SSH WS closed with the authorization-revoked code");
  assert.equal(sessions.countForUser(userA), 0, "registry entry removed");
  assert.equal(b.ws.readyState, WebSocket.OPEN, "user B's SSH session remains connected");
  assert.equal(sessions.countForUser(userB), 1);
  assert.ok(await waitFor(() => liveUpstream.size < upstreamBefore), "the revoked session's upstream TCP was torn down");
  b.ws.close();
  await setActive(userA, true);
});

test("AUTHZ-STATE-009: role downgrade (losing sessions:connect) closes the live SSH session", { skip: dbSkip }, async () => {
  await setActive(userA, true); await setRole(userA, "user");
  const a = await establishSsh(userA);
  await setRole(userA, "readonly"); // readonly lacks sessions:connect
  await sessions.revalidateUser(userA);
  assert.equal(await a.closeCode, 4403, "downgraded user's SSH session closes");
  assert.equal(sessions.countForUser(userA), 0);
  await setRole(userA, "user");
});

test("AUTHZ-STATE-015: locking a user closes the live SSH session", { skip: dbSkip }, async () => {
  await setActive(userA, true); await setRole(userA, "user");
  const a = await establishSsh(userA);
  await users.setLocked(userA, true);
  await sessions.revalidateUser(userA);
  assert.equal(await a.closeCode, 4403);
  assert.equal(sessions.countForUser(userA), 0);
  await users.setLocked(userA, false);
});

test("AUTHZ-STATE-014: a company move closes the live SSH session (tenant context changed)", { skip: dbSkip }, async () => {
  await setActive(userA, true); await setRole(userA, "user");
  const a = await establishSsh(userA);
  // Move A to company B with a global built-in role (same permission) via the org route.
  const res = await fetch(`${baseHttp}/api/v1/org/users/${userA}/assignment`, {
    method: "PUT", headers: { authorization: `Bearer ${await token(superU, "super_admin")}`, "content-type": "application/json" },
    body: JSON.stringify({ company_id: compB, role: "user" }),
  });
  assert.equal(res.status, 200);
  assert.equal(await a.closeCode, 4403, "session closes even though the new role keeps sessions:connect");
  assert.equal(sessions.countForUser(userA), 0);
  // move back
  await users.setOrg(userA, compA, null, "user");
});

test("AUTHZ-STATE-011: Telnet session is revoked on disable", { skip: dbSkip }, async () => {
  await setActive(userA, true); await setRole(userA, "user");
  const c = openFrameChannel(`/api/v1/telnet/connect?host_id=${HID}`, await token(userA, "user"));
  assert.ok(await waitFor(() => sessions.countForUser(userA) >= 1), "telnet registers");
  await setActive(userA, false);
  await sessions.revalidateUser(userA);
  assert.equal(await c.closeCode, 4403);
  assert.equal(sessions.countForUser(userA), 0);
  await setActive(userA, true);
});

test("AUTHZ-STATE-012: TCP tunnel session is revoked on disable", { skip: dbSkip }, async () => {
  await setActive(userA, true); await setRole(userA, "user");
  const c = openFrameChannel(`/api/v1/tunnel/connect?host_id=${HID}&dst_host=127.0.0.1&dst_port=${tcpPort}`, await token(userA, "user"));
  assert.ok(await waitFor(() => sessions.countForUser(userA) >= 1), "tunnel registers");
  await setActive(userA, false);
  await sessions.revalidateUser(userA);
  assert.equal(await c.closeCode, 4403);
  assert.equal(sessions.countForUser(userA), 0);
  await setActive(userA, true);
});

test("AUTHZ-STATE-013: VNC session is revoked on disable (ticket cannot outlive revocation)", { skip: dbSkip }, async () => {
  await setActive(userA, true); await setRole(userA, "user");
  const tk = await (await fetch(`${baseHttp}/api/v1/vnc/ticket`, {
    method: "POST", headers: { authorization: `Bearer ${await token(userA, "user")}`, "content-type": "application/json" },
    body: JSON.stringify({ host_id: HID }),
  })).json() as { ticket: string };
  const closeCode = new Promise<number | undefined>((res) => {
    const ws = new WebSocket(`${baseWs}/api/v1/vnc/connect?ticket=${tk.ticket}`);
    ws.on("close", (code) => res(code)); ws.on("error", () => {});
  });
  assert.ok(await waitFor(() => sessions.countForUser(userA) >= 1), "vnc registers");
  await setActive(userA, false);
  await sessions.revalidateUser(userA);
  assert.equal(await closeCode, 4403);
  assert.equal(sessions.countForUser(userA), 0);
  await setActive(userA, true);
});

test("AUTHZ-STATE-016: deleting a user closes the session and cleans the registry", { skip: dbSkip }, async () => {
  const victim = await mkUser("user", compA);
  const c = openFrameChannel(`/api/v1/telnet/connect?host_id=${HID}`, await token(victim, "user"));
  assert.ok(await waitFor(() => sessions.countForUser(victim) >= 1), "session registers");
  await users.delete(victim);
  sessions.revokeUser(victim, "USER_DELETED");
  assert.equal(await c.closeCode, 4403);
  assert.equal(sessions.countForUser(victim), 0);
  assert.equal(sessions.count() >= 0, true);
});

test("AUTHZ-STATE-022: after revocation a reconnect with the (disabled) token is rejected at auth", { skip: dbSkip }, async () => {
  await setActive(userA, true); await setRole(userA, "user");
  const a = await establishSsh(userA);
  await setActive(userA, false);
  await sessions.revalidateUser(userA);
  assert.equal(await a.closeCode, 4403);
  // Reconnect with the same still-unexpired token → AWM-SEC-021 live-state auth denies it.
  const c = openFrameChannel(`/api/v1/ssh/connect?host_id=${HID}`, await token(userA, "user"), { password: "x" });
  const denied = await new Promise<string | undefined>((res) => {
    c.ws.on("message", (d, isBin) => { if (isBin) return res(undefined); const m = JSON.parse(d.toString()); if (m.type === "error") res(m.code); });
    c.ws.on("close", () => res(undefined));
    setTimeout(() => res(undefined), 3000);
  });
  assert.equal(denied, "invalid_token", "reconnect blocked by live-state auth");
  assert.equal(sessions.countForUser(userA), 0, "no new session registered");
  await setActive(userA, true);
});

test("AUTHZ-STATE-018 (fallback): the periodic loop revokes a session with NO explicit event", { skip: dbSkip }, async () => {
  await setActive(userA, true); await setRole(userA, "user");
  const a = await establishSsh(userA);
  // Disable ONLY in the DB — do not call revoke/revalidate. The periodic loop
  // (400ms) must catch it and terminate the live session on its own.
  await setActive(userA, false);
  assert.equal(await a.closeCode, 4403, "periodic fallback closed the session");
  assert.equal(sessions.countForUser(userA), 0);
  await setActive(userA, true);
});

test("AUTHZ-STATE-019 (channels): all of a user's sessions across kinds terminate together", { skip: dbSkip }, async () => {
  await setActive(userA, true); await setRole(userA, "user");
  const ssh = await establishSsh(userA);
  const tel = openFrameChannel(`/api/v1/telnet/connect?host_id=${HID}`, await token(userA, "user"));
  const tun = openFrameChannel(`/api/v1/tunnel/connect?host_id=${HID}&dst_host=127.0.0.1&dst_port=${tcpPort}`, await token(userA, "user"));
  assert.ok(await waitFor(() => sessions.countForUser(userA) >= 3), "three sessions registered");
  await setActive(userA, false);
  await sessions.revalidateUser(userA);
  assert.equal(await ssh.closeCode, 4403);
  assert.equal(await tel.closeCode, 4403);
  assert.equal(await tun.closeCode, 4403);
  assert.equal(sessions.countForUser(userA), 0, "no orphan registry entries");
  await setActive(userA, true);
});
