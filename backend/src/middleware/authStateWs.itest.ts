/**
 * AWM-SEC-021 (WS channels) — a stale token whose account state is no longer
 * valid must be rejected by every long-lived channel, not just HTTP.
 * AUTHZ-STATE-006 (SSH) and 007 (Telnet, TCP tunnel, VNC). Real PostgreSQL.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import { WebSocket } from "ws";
import { v4 as uuid } from "uuid";
import { loadConfig } from "../config/index.js";
import { createJwt, type JwtService } from "../jwt/index.js";
import { createLogger } from "../logger/index.js";
import { UserRepository } from "../repos/userRepo.js";
import { makeSshGateway } from "../ssh/gateway.js";
import { makeTelnetGateway } from "../telnet/gateway.js";
import { makeWsTunnelGateway } from "../ssh/wsTunnelGateway.js";
import { makeVncGateway } from "../vnc/gateway.js";
import { getPool, closePool, dbSkip } from "../test/db.js";

let app: FastifyInstance;
let jwt: JwtService;
let users: UserRepository;
let baseWs = "";
let baseHttp = "";
const sessions = { register() {}, unregister() {}, revokeUser() { return 0; }, revalidateUser: async () => {}, count() { return 0; }, countForUser() { return 0; }, startPeriodic() {}, stop() {} } as never;
let tcpPort = 0;
let tcpServer: net.Server;
const ids = { active: "", disabled: "" };

async function mkUser(active: boolean) {
  const id = uuid();
  await getPool().query(
    `INSERT INTO users (id,username,email,password_hash,role,is_active)
     VALUES ($1,'aw_'||substr(md5(random()::text),1,12),'aw_'||substr(md5(random()::text),1,12)||'@t.local','x','user',$2)`,
    [id, active],
  );
  return id;
}
const token = async (id: string) => (await jwt.issuePair(id, "user")).access.token;

/** Open a WS, send an auth frame, and report the first meaningful outcome. */
function wsTrial(path: string, query: string, tokenStr: string): Promise<{ code?: string; passedAuth: boolean }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${baseWs}${path}?${query}`);
    let settled = false;
    const done = (r: { code?: string; passedAuth: boolean }) => { if (settled) return; settled = true; try { ws.close(); } catch { /* ignore */ } resolve(r); };
    ws.on("open", () => ws.send(JSON.stringify({ type: "auth", token: tokenStr })));
    ws.on("message", (d, isBinary) => {
      if (isBinary) return done({ passedAuth: true });
      const m = JSON.parse(d.toString());
      if (m.type === "status" && (m.status === "authenticating")) return; // pre-auth banner
      if (m.type === "status") return done({ passedAuth: true }); // connecting/etc → past auth
      done({ code: m.code, passedAuth: false }); // error frame
    });
    ws.on("close", () => done({ passedAuth: false }));
    ws.on("error", () => done({ passedAuth: false }));
    setTimeout(() => done({ passedAuth: false }), 3000);
  });
}

before(async () => {
  if (dbSkip) return;
  const cfg = loadConfig();
  jwt = createJwt(cfg);
  users = new UserRepository(getPool());
  const log = createLogger(cfg);
  ids.active = await mkUser(true);
  ids.disabled = await mkUser(false);

  tcpServer = net.createServer((s) => s.on("data", () => {}));
  await new Promise<void>((r) => tcpServer.listen(0, "127.0.0.1", r));
  tcpPort = (tcpServer.address() as net.AddressInfo).port;

  const hosts = { async getById(_u: string, id: string) { return { id, name: "h", hostname: "127.0.0.1", port: tcpPort }; } };
  const history = { async start() { return 1; }, async end() {} };
  const stub = {} as never;

  app = Fastify();
  await app.register(websocket);
  await app.register(makeSshGateway({ sessions, jwt, users, hosts: hosts as never, credentials: stub, history: history as never, settings: stub, log, hostKeys: stub }), { prefix: "/api/v1/ssh" });
  await app.register(makeTelnetGateway({ sessions, jwt, users, hosts: hosts as never, history: history as never, log }), { prefix: "/api/v1/telnet" });
  await app.register(makeWsTunnelGateway({ sessions, jwt, users, hosts: hosts as never, credentials: stub, log, hostKeys: stub }), { prefix: "/api/v1/tunnel" });
  await app.register(makeVncGateway({ sessions, jwt, users, hosts: hosts as never, history: history as never, log }), { prefix: "/api/v1/vnc" });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address() as net.AddressInfo;
  baseWs = `ws://127.0.0.1:${addr.port}`;
  baseHttp = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  if (dbSkip) return;
  await app?.close();
  await new Promise<void>((r) => tcpServer.close(() => r()));
  await getPool().query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[ids.active, ids.disabled]]);
  await closePool();
});

const HID = "00000000-0000-0000-0000-000000000000";

test("AUTHZ-STATE-006: SSH WS rejects a token whose account is disabled", { skip: dbSkip }, async () => {
  // The active user gets PAST auth (any later error is the dummy target not being
  // a real SSH server — never an auth rejection).
  const good = await wsTrial("/api/v1/ssh/connect", `host_id=${HID}`, await token(ids.active));
  assert.notEqual(good.code, "invalid_token", "active user is not rejected at auth");
  assert.notEqual(good.code, "forbidden");
  const bad = await wsTrial("/api/v1/ssh/connect", `host_id=${HID}`, await token(ids.disabled));
  assert.equal(bad.passedAuth, false, "disabled user's SSH auth is rejected");
  assert.equal(bad.code, "invalid_token");
});

test("AUTHZ-STATE-007a: Telnet WS rejects a disabled account's token", { skip: dbSkip }, async () => {
  const good = await wsTrial("/api/v1/telnet/connect", `host_id=${HID}`, await token(ids.active));
  assert.equal(good.passedAuth, true, "active user proceeds past Telnet auth");
  const bad = await wsTrial("/api/v1/telnet/connect", `host_id=${HID}`, await token(ids.disabled));
  assert.equal(bad.passedAuth, false, "disabled user's Telnet auth is rejected");
});

test("AUTHZ-STATE-007b: TCP tunnel WS rejects a disabled account's token", { skip: dbSkip }, async () => {
  const q = `host_id=${HID}&dst_host=127.0.0.1&dst_port=${tcpPort}`;
  const bad = await wsTrial("/api/v1/tunnel/connect", q, await token(ids.disabled));
  assert.equal(bad.passedAuth, false, "disabled user's tunnel auth is rejected");
});

test("AUTHZ-STATE-007c: VNC ticket issuance is denied for a disabled account", { skip: dbSkip }, async () => {
  // A disabled user cannot even mint a VNC ticket (the /connect redemption also
  // re-validates, so an outstanding ticket cannot bypass invalid state).
  const res = await fetch(`${baseHttp}/api/v1/vnc/ticket`, {
    method: "POST",
    headers: { authorization: `Bearer ${await token(ids.disabled)}`, "content-type": "application/json" },
    body: JSON.stringify({ host_id: HID }),
  });
  assert.equal(res.status, 401, "disabled user is rejected before a ticket is issued");
});
