/**
 * RDP gateway (WebSocket ↔ guacd) against a fake guacd over real TCP and a real
 * WebSocket, with real users in PostgreSQL for the auth-state checks.
 * RDP-GW-001..007.
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
import { AuditRepository } from "../repos/otherRepos.js";
import { RoleRepository } from "../repos/roleRepo.js";
import { RoleService } from "../domain/roleService.js";
import { ActiveSessionManager } from "../session/activeSessions.js";
import { getPool, closePool, dbSkip } from "../test/db.js";
import { configureRemoteDestinationPolicy } from "../usecases/remoteDestination.js";
import { makeRdpGateway } from "./gateway.js";
import { encodeInstruction, parseInstruction } from "./guacamole.js";

let app: FastifyInstance;
let jwt: JwtService;
let users: UserRepository;
let sessions: ActiveSessionManager;
let baseWs = "", baseHttp = "";
let guacd: net.Server;
let guacdPort = 0;
let userId = "", readonlyId = "", companyId = "";

/** Everything the fake guacd received, per connection, as parsed instructions. */
const guacdLog: string[][][] = [];
let argsDelayMs = 0;

const HOSTS: Record<string, Record<string, unknown>> = {
  rdp1: { id: "rdp1", name: "win", hostname: "127.0.0.1", port: 3389, protocol: "rdp", credentialId: "c1",
    options: { rdp: { security: "nla", "gateway-hostname": "10.9.9.9", "drive-path": "/etc", "color-depth": 16 } } },
  meta: { id: "meta", name: "md", hostname: "169.254.169.254", port: 3389, protocol: "rdp", credentialId: "c1", options: {} },
  ssh1: { id: "ssh1", name: "lin", hostname: "127.0.0.1", port: 22, protocol: "ssh", credentialId: "c1", options: {} },
};

const mkUser = async (role: string) => {
  const id = uuid();
  await getPool().query(
    `INSERT INTO users (id,username,email,password_hash,role,is_active,company_id)
     VALUES ($1,'rdp_'||substr(md5(random()::text),1,12),'rdp_'||substr(md5(random()::text),1,12)||'@t.local','x',$2,true,$3)`,
    [id, role, companyId],
  );
  return id;
};
const token = async (id: string, role: string) => (await jwt.issuePair(id, role)).access.token;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function ticket(uid: string, role: string, hostId: string): Promise<{ status: number; ticket?: string }> {
  const r = await fetch(`${baseHttp}/api/v1/rdp/ticket`, {
    method: "POST", headers: { authorization: `Bearer ${await token(uid, role)}`, "content-type": "application/json" },
    body: JSON.stringify({ host_id: hostId }),
  });
  const j = await r.json().catch(() => ({})) as { ticket?: string };
  return { status: r.status, ticket: j.ticket };
}

interface Client { ws: WebSocket; messages: string[]; closed: Promise<number> }
function open(t: string, onOpen?: (ws: WebSocket) => void): Client {
  const ws = new WebSocket(`${baseWs}/api/v1/rdp/connect?ticket=${t}&width=1280&height=720&dpi=96`, "guacamole");
  const messages: string[] = [];
  ws.on("message", (d) => messages.push(d.toString()));
  ws.on("open", () => onOpen?.(ws));
  ws.on("error", () => {});
  const closed = new Promise<number>((res) => ws.on("close", (code) => res(code)));
  return { ws, messages, closed };
}
async function waitFor(cond: () => boolean, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return true; await sleep(20); }
  return cond();
}

before(async () => {
  configureRemoteDestinationPolicy({ allowLoopback: true });
  if (dbSkip) return;
  const cfg = loadConfig();
  jwt = createJwt(cfg);
  const log = createLogger(cfg);
  const pool = getPool();
  users = new UserRepository(pool);
  await new RoleService(new RoleRepository(pool)).reload();
  sessions = new ActiveSessionManager({ users, log, audit: new AuditRepository(pool), revalidateIntervalMs: 60_000 });
  companyId = (await pool.query<{ id: string }>(`INSERT INTO companies (id,name) VALUES (gen_random_uuid(),'RDP GW') RETURNING id`)).rows[0]!.id;
  userId = await mkUser("user");
  readonlyId = await mkUser("readonly");

  // Fake guacd: answers `select` with `args`, records everything, says `ready` after `connect`.
  guacd = net.createServer((s) => {
    const conn: string[][] = [];
    guacdLog.push(conn);
    let buf = "";
    s.on("error", () => {});
    s.on("data", (d) => {
      buf += d.toString("utf8");
      for (;;) {
        const inst = parseInstruction(buf);
        if (!inst) break;
        buf = buf.slice(inst.consumed);
        conn.push(inst.elements);
        if (inst.elements[0] === "select") {
          setTimeout(() => s.write(encodeInstruction("args", "VERSION_1_5_0", "hostname", "port", "username", "password",
            "domain", "security", "ignore-cert", "gateway-hostname", "drive-path", "color-depth", "width")), argsDelayMs);
        } else if (inst.elements[0] === "connect") {
          s.write(encodeInstruction("ready", "$test-conn"));
        }
      }
    });
  });
  await new Promise<void>((r) => guacd.listen(0, "127.0.0.1", r));
  guacdPort = (guacd.address() as net.AddressInfo).port;

  const hosts = { async getById(_u: string, id: string) {
    const h = HOSTS[id]; if (!h) throw new Error("not found"); return { ...h, userId };
  } };
  const credentials = { async getById() {
    return { username: "alice", credentialType: "password", secretData: { password: "Pa55-rdp", domain: "CORP" }, fields: [] };
  } };
  const history = { async start() { return 1; }, async end() {} };

  app = Fastify();
  await app.register(websocket);
  await app.register(makeRdpGateway({
    sessions, jwt, users, hosts: hosts as never, credentials: credentials as never, history: history as never,
    guacd: { host: "127.0.0.1", port: guacdPort }, log,
  }), { prefix: "/api/v1/rdp" });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address() as net.AddressInfo;
  baseWs = `ws://127.0.0.1:${addr.port}`;
  baseHttp = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  if (dbSkip) return;
  sessions?.stop();
  await app?.close();
  await new Promise<void>((r) => guacd.close(() => r()));
  await getPool().query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[userId, readonlyId]]);
  await getPool().query(`DELETE FROM companies WHERE id = $1`, [companyId]);
  await closePool();
});

test("RDP-GW-001: handshake runs server-side with the host credential and the resolved address", { skip: dbSkip }, async () => {
  const before = guacdLog.length;
  const t = await ticket(userId, "user", "rdp1");
  assert.equal(t.status, 200);
  const c = open(t.ticket!);
  assert.ok(await waitFor(() => c.messages.join("").includes("ready")), "client receives guacd's ready");
  const first = parseInstruction(c.messages[0]!)!;
  assert.equal(first.elements[0], "", "first frame is the tunnel's internal UUID instruction");
  const conn = guacdLog[before]!;
  assert.deepEqual(conn.map((i) => i[0]), ["select", "size", "audio", "video", "image", "connect"]);
  assert.deepEqual(conn[1], ["size", "1280", "720", "96"]);
  const connect = conn[5]!;
  // args order: VERSION, hostname, port, username, password, domain, security, ignore-cert, gateway-hostname, drive-path, color-depth, width
  assert.deepEqual(connect, ["connect", "VERSION_1_5_0", "127.0.0.1", "3389", "alice", "Pa55-rdp", "CORP", "nla", "true", "", "", "16", "1280"]);
  assert.ok(!c.messages.join("").includes("Pa55-rdp"), "the password never reaches the client");
  c.ws.close();
  await c.closed;
});

test("RDP-GW-002: client data sent before the handshake completes is not forwarded to guacd", { skip: dbSkip }, async () => {
  argsDelayMs = 300;
  const before = guacdLog.length;
  const t = await ticket(userId, "user", "rdp1");
  const injected = encodeInstruction("connect", "VERSION_1_5_0", "10.6.6.6", "3389", "x", "y");
  const c = open(t.ticket!, (ws) => ws.send(injected));
  assert.ok(await waitFor(() => c.messages.join("").includes("ready")));
  const conn = guacdLog[before]!;
  assert.equal(conn.filter((i) => i[0] === "connect").length, 1, "only the gateway's own connect");
  assert.equal(conn.find((i) => i[0] === "connect")![2], "127.0.0.1");
  // After the handshake, client instructions are relayed.
  c.ws.send(encodeInstruction("mouse", "10", "20", "1"));
  assert.ok(await waitFor(() => conn.some((i) => i[0] === "mouse")), "relay phase forwards client input");
  argsDelayMs = 0;
  c.ws.close();
  await c.closed;
});

test("RDP-GW-003: a ticket works once; a missing or reused ticket is refused", { skip: dbSkip }, async () => {
  const t = await ticket(userId, "user", "rdp1");
  const c1 = open(t.ticket!);
  assert.ok(await waitFor(() => c1.messages.join("").includes("ready")));
  const c2 = open(t.ticket!);
  assert.equal(await c2.closed, 4401);
  const c3 = open("deadbeef");
  assert.equal(await c3.closed, 4401);
  c1.ws.close();
  await c1.closed;
});

test("RDP-GW-004: a metadata/link-local destination is refused before guacd is contacted", { skip: dbSkip }, async () => {
  const before = guacdLog.length;
  const t = await ticket(userId, "user", "meta");
  const c = open(t.ticket!);
  assert.equal(await c.closed, 4403);
  await sleep(100);
  assert.equal(guacdLog.length, before, "guacd never contacted");
});

test("RDP-GW-005: ticket requires sessions:connect, an RDP host, and host access", { skip: dbSkip }, async () => {
  assert.equal((await ticket(readonlyId, "readonly", "rdp1")).status, 403);
  assert.equal((await ticket(userId, "user", "ssh1")).status, 400);
  assert.equal((await ticket(userId, "user", "nope")).status, 404);
  const anon = await fetch(`${baseHttp}/api/v1/rdp/ticket`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(anon.status, 401);
});

test("RDP-GW-006: the session is registered and revoked when the user is disabled", { skip: dbSkip }, async () => {
  const t = await ticket(userId, "user", "rdp1");
  const c = open(t.ticket!);
  assert.ok(await waitFor(() => sessions.countForUser(userId) >= 1), "rdp session registers");
  const u = await users.getById(userId); u.isActive = false; await users.update(u);
  await sessions.revalidateUser(userId);
  assert.equal(await c.closed, 4403);
  assert.equal(sessions.countForUser(userId), 0);
  u.isActive = true; await users.update(u);
});

test("RDP-GW-007: a ticket redeemed after the account was disabled is refused", { skip: dbSkip }, async () => {
  const t = await ticket(userId, "user", "rdp1");
  const u = await users.getById(userId); u.isActive = false; await users.update(u);
  const c = open(t.ticket!);
  assert.equal(await c.closed, 4401);
  u.isActive = true; await users.update(u);
});

test("RDP-GW-008: keep-alive pings are answered by the gateway and never reach guacd", { skip: dbSkip }, async () => {
  const before = guacdLog.length;
  const t = await ticket(userId, "user", "rdp1");
  const c = open(t.ticket!);
  assert.ok(await waitFor(() => c.messages.join("").includes("ready")));
  const ping = encodeInstruction("", "ping", "1700000000000");
  c.ws.send(ping);
  assert.ok(await waitFor(() => c.messages.includes(ping)), "the identical ping comes back");
  c.ws.send(encodeInstruction("mouse", "1", "1", "0"));
  const conn = guacdLog[before]!;
  assert.ok(await waitFor(() => conn.some((i) => i[0] === "mouse")));
  assert.ok(!conn.some((i) => i[0] === ""), "no internal instruction was forwarded to guacd");
  c.ws.close();
  await c.closed;
});
