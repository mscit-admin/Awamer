/** SEC-WS-ORIGIN-001 — WS-ORIGIN-001..006. */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { WebSocket } from "ws";
import { isAllowedWsOrigin, registerWsOriginCheck } from "./wsOrigin.js";

const ALLOW = ["tauri://localhost", "https://tauri.localhost", "http://localhost:1420"];

test("WS-ORIGIN-001: same-origin, allowlisted and Origin-less clients are allowed", () => {
  assert.equal(isAllowedWsOrigin("https://awamer.example.com", "awamer.example.com", ALLOW), true);
  assert.equal(isAllowedWsOrigin("https://awamer.example.com:8443", "awamer.example.com", ALLOW), true); // nginx $host has no port
  assert.equal(isAllowedWsOrigin("https://AWAMER.example.com", "awamer.example.com", ALLOW), true);
  assert.equal(isAllowedWsOrigin("tauri://localhost", "awamer.example.com", ALLOW), true);
  assert.equal(isAllowedWsOrigin(undefined, "awamer.example.com", ALLOW), true);
});

test("WS-ORIGIN-002: cross-site, null and malformed origins are refused", () => {
  assert.equal(isAllowedWsOrigin("https://evil.example", "awamer.example.com", ALLOW), false);
  assert.equal(isAllowedWsOrigin("https://awamer.example.com.evil.example", "awamer.example.com", ALLOW), false);
  assert.equal(isAllowedWsOrigin("null", "awamer.example.com", ALLOW), false);
  assert.equal(isAllowedWsOrigin("file://", "awamer.example.com", ALLOW), false);
  assert.equal(isAllowedWsOrigin("not a url", "awamer.example.com", ALLOW), false);
  assert.equal(isAllowedWsOrigin("https://evil.example", undefined, ALLOW), false);
});

test("WS-ORIGIN-003: when Host carries a port, host:port must match exactly", () => {
  assert.equal(isAllowedWsOrigin("http://127.0.0.1:8081", "127.0.0.1:8081", ALLOW), true);
  assert.equal(isAllowedWsOrigin("http://127.0.0.1:9999", "127.0.0.1:8081", ALLOW), false);
  assert.equal(isAllowedWsOrigin("http://[::1]:8081", "[::1]:8081", ALLOW), true);
});

// --- real handshake through @fastify/websocket -------------------------------
const app = Fastify();
registerWsOriginCheck(app, ALLOW);
await app.register(websocket);
app.register(async (a) => {
  a.get("/connect", { websocket: true }, (socket) => { socket.send("hello"); });
}, { prefix: "/api/v1/ssh" });
app.get("/plain", async () => ({ ok: true }));
await app.listen({ port: 0, host: "127.0.0.1" });
const port = (app.server.address() as import("node:net").AddressInfo).port;
after(() => app.close());

function connect(origin?: string): Promise<{ opened: boolean; status?: number; msg?: string }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/ssh/connect`, origin ? { origin } : {});
    ws.on("message", (m) => { resolve({ opened: true, msg: String(m) }); ws.close(); });
    ws.on("unexpected-response", (_req, res) => { resolve({ opened: false, status: res.statusCode }); ws.terminate(); });
    ws.on("error", () => resolve({ opened: false }));
  });
}

test("WS-ORIGIN-004: a cross-site handshake is refused with 403 before the upgrade", async () => {
  const r = await connect("https://evil.example");
  assert.deepEqual(r, { opened: false, status: 403 });
});

test("WS-ORIGIN-005: same-origin, allowlisted and Origin-less handshakes open", async () => {
  assert.equal((await connect(`http://127.0.0.1:${port}`)).msg, "hello");
  assert.equal((await connect("tauri://localhost")).msg, "hello");
  assert.equal((await connect()).msg, "hello");
});

test("WS-ORIGIN-006: ordinary HTTP requests are not affected", async () => {
  const res = await app.inject({ method: "GET", url: "/plain", headers: { origin: "https://evil.example" } });
  assert.equal(res.statusCode, 200);
});
