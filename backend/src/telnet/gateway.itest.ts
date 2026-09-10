/**
 * SEC-018 — WebSocket channel-auth for the telnet gateway (integration).
 * Boots the real gateway over a real WS and asserts:
 *   - no token in the URL is needed to open (TEST-WS-001)
 *   - an invalid JWT auth frame is denied (TEST-WS-003)
 *   - a valid JWT auth frame proceeds past auth (TEST-WS-005)
 * The no-auth-frame timeout (TEST-WS-002) + pre-auth message rejection
 * (TEST-WS-006) are covered by ssh/gateway.test.ts (awaitAuthFrame).
 * Needs a JWT secret (config); DB is not required for this test.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import { WebSocket } from "ws";
import { loadConfig } from "../config/index.js";
import { createLogger } from "../logger/index.js";
import { createJwt, type JwtService } from "../jwt/index.js";
import { makeTelnetGateway } from "./gateway.js";

const noJwt = process.env.JWT_ACCESS_SECRET ? undefined : "set JWT_ACCESS_SECRET to run";

let app: FastifyInstance;
let jwt: JwtService;
let base = "";
let tcpServer: net.Server;
let tcpPort = 0;

before(async () => {
  if (noJwt) return;
  const cfg = loadConfig();
  jwt = createJwt(cfg);
  // A dummy TCP server standing in for a telnet host, so a valid auth frame
  // leads to a real onward connection rather than a connect error.
  tcpServer = net.createServer((s) => s.on("data", () => {}));
  await new Promise<void>((r) => tcpServer.listen(0, "127.0.0.1", r));
  tcpPort = (tcpServer.address() as net.AddressInfo).port;

  const hosts = { async getById(_u: string, id: string) { return { id, name: "t", hostname: "127.0.0.1", port: tcpPort }; } };
  const history = { async start() { return 1; }, async end() {} };
  const log = createLogger(cfg);
  app = Fastify();
  await app.register(websocket);
  await app.register(makeTelnetGateway({ jwt, hosts: hosts as never, history: history as never, log }), { prefix: "/api/v1/telnet" });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address() as net.AddressInfo;
  base = `ws://127.0.0.1:${addr.port}/api/v1/telnet/connect`;
});

after(async () => {
  if (noJwt) return;
  await app?.close();
  await new Promise<void>((r) => tcpServer.close(() => r()));
});

/** Open a socket (no token in URL), optionally send an auth frame, collect the
 *  first JSON message, and report whether it closed. */
function trial(authFrame: unknown | null): Promise<{ firstMsg: any; closed: boolean }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(base + "?host_id=00000000-0000-0000-0000-000000000000");
    let firstMsg: any = null;
    let settled = false;
    const done = (closed: boolean) => { if (settled) return; settled = true; try { ws.close(); } catch { /* ignore */ } resolve({ firstMsg, closed }); };
    ws.on("open", () => { if (authFrame !== null) ws.send(JSON.stringify(authFrame)); });
    ws.on("message", (d, isBinary) => {
      if (isBinary) { done(false); return; } // got past auth → binary relay
      const m = JSON.parse(d.toString());
      if (m.type === "status" && m.status === "authenticating") return; // pre-auth banner
      if (m.type === "status" && m.status === "connecting") { firstMsg = m; done(false); return; } // proceeded past auth
      firstMsg = m; // an error frame
      done(false);
    });
    ws.on("close", () => done(true));
    ws.on("error", () => done(true));
    setTimeout(() => done(false), 3000);
  });
}

test("TEST-WS-001/003: URL carries no token; an invalid JWT frame is denied", { skip: noJwt }, async () => {
  const { firstMsg } = await trial({ type: "auth", token: "not-a-jwt" });
  assert.equal(firstMsg?.type, "error");
  assert.equal(firstMsg?.code, "invalid_token");
});

test("TEST-WS-005: a valid JWT frame proceeds past authentication", { skip: noJwt }, async () => {
  const token = (await jwt.issuePair("00000000-0000-0000-0000-000000000000", "user")).access.token;
  const { firstMsg } = await trial({ type: "auth", token });
  // Past auth the gateway announces "connecting" (or begins the binary relay);
  // it must NOT be an auth error.
  assert.notEqual(firstMsg?.code, "invalid_token");
  assert.notEqual(firstMsg?.code, "forbidden");
});
