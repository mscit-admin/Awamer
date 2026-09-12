/**
 * SEC-INFRA-001 — VPN helper IPC integration tests over a REAL Unix socket
 * (no Docker/root needed; a fake spawn stands in for OpenVPN).
 *
 * INFRA-VPN-010 (backend can drive the helper), 025..032 (IPC security), and the
 * helper-down FAIL-CLOSED behaviour (§38).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HelperCore, type SpawnFn } from "./helperCore.js";
import { createHelperServer, listenHelper } from "./helperServer.js";
import { VpnHelperClient, VpnHelperUnavailable } from "../vpn/helperClient.js";
import { signRequest, PROTOCOL_VERSION } from "../vpn/helperProtocol.js";

const SECRET = "s".repeat(48);
let dir = "", socketPath = "", server: net.Server, client: VpnHelperClient;

const fakeSpawn: SpawnFn = () => {
  const stdout = new EventEmitter(), stderr = new EventEmitter(), ee = new EventEmitter() as any;
  ee.stdout = stdout; ee.stderr = stderr; ee.pid = 1; ee.kill = () => true;
  setImmediate(() => stdout.emit("data", Buffer.from("Initialization Sequence Completed\n")));
  return ee;
};

/** Send one raw line to the socket and resolve with the response line (or "CLOSED"). */
function sendRaw(line: string): Promise<string> {
  return new Promise((resolve) => {
    const sock = net.createConnection(socketPath);
    let buf = "";
    let done = false;
    const fin = (v: string) => { if (done) return; done = true; try { sock.destroy(); } catch { /* */ } resolve(v); };
    sock.setEncoding("utf8");
    sock.on("connect", () => sock.write(line.endsWith("\n") ? line : line + "\n"));
    sock.on("data", (c: string) => { buf += c; const nl = buf.indexOf("\n"); if (nl !== -1) fin(buf.slice(0, nl)); });
    sock.on("close", () => fin("CLOSED"));
    sock.on("error", () => fin("CLOSED"));
    setTimeout(() => fin("TIMEOUT"), 2000);
  });
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "awamer-ipc-test-"));
  socketPath = join(dir, "vpn-helper.sock");
  const core = new HelperCore({ openvpnPath: "/usr/sbin/openvpn", runtimeDir: join(dir, "rt"), spawnFn: fakeSpawn, startupTimeoutMs: 1000 });
  server = createHelperServer({ core, secret: SECRET, socketPath });
  await listenHelper(server, socketPath);
  client = new VpnHelperClient({ socketPath, secret: SECRET, timeoutMs: 3000 });
});
after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await rm(dir, { recursive: true, force: true }).catch(() => {});
});

const VALID_CONFIG = "client\ndev tun\nproto udp\nremote 198.51.100.9 1194\n";

test("INFRA-VPN-010: the backend client drives the helper (health + client_connect)", async () => {
  const h = await client.request("health", {});
  assert.equal(h.ready, true);
  const r = await client.request("client_connect", { sessionRef: "ipc-sess-1", config: VALID_CONFIG });
  assert.equal(r.state, "running");
  const stopped = await client.request("client_stop", { sessionRef: "ipc-sess-1" });
  assert.equal(stopped.stopped, true);
});

test("INFRA-VPN-025: an unauthenticated (unsigned) request is rejected", async () => {
  const unsigned = JSON.stringify({ v: PROTOCOL_VERSION, op: "health", id: "u1", ts: Date.now(), payload: {} });
  const resp = await sendRaw(unsigned);
  assert.match(resp, /unauthenticated/);
});

test("INFRA-VPN-026: a request signed with the WRONG secret is rejected", async () => {
  const bad = signRequest("w".repeat(48), { v: PROTOCOL_VERSION, op: "health", id: "w1", ts: Date.now(), payload: {} });
  const resp = await sendRaw(JSON.stringify(bad));
  assert.match(resp, /unauthenticated/);
});

test("INFRA-VPN-027: a replayed request (same id) is rejected the second time", async () => {
  const req = signRequest(SECRET, { v: PROTOCOL_VERSION, op: "health", id: "replay-1", ts: Date.now(), payload: {} });
  const first = await sendRaw(JSON.stringify(req));
  assert.doesNotMatch(first, /replayed|unauthenticated/);
  const second = await sendRaw(JSON.stringify(req));
  assert.match(second, /replayed/);
});

test("INFRA-VPN-028: a malformed (non-JSON) request closes the connection", async () => {
  const resp = await sendRaw("this-is-not-json{{{");
  assert.equal(resp, "CLOSED");
});

test("INFRA-VPN-029: an unknown operation is rejected", async () => {
  // Signed with the right secret, but op is not in the allow-list.
  const bad = signRequest(SECRET, { v: PROTOCOL_VERSION, op: "exec" as any, id: "op-1", ts: Date.now(), payload: { command: "id" } });
  const resp = await sendRaw(JSON.stringify(bad));
  assert.match(resp, /unauthenticated|unknown/);
});

test("INFRA-VPN-030: an oversized payload closes the connection", async () => {
  const huge = "A".repeat(2 * 1024 * 1024 + 10);
  const resp = await sendRaw(huge);
  assert.equal(resp, "CLOSED");
});

test("INFRA-VPN-031: a 'command' field carries no exec semantics (ignored)", async () => {
  // A well-formed client_connect that also smuggles a `command` field: the helper
  // ignores unknown fields and requires a real config — it never executes it.
  const req = signRequest(SECRET, {
    v: PROTOCOL_VERSION, op: "client_connect", id: "cmd-1", ts: Date.now(),
    payload: { sessionRef: "cmd-sess", command: "rm -rf /", args: ["--up", "/tmp/x"] },
  });
  const resp = await sendRaw(JSON.stringify(req));
  // Missing `config` → structured error; NOT executed.
  assert.match(resp, /"ok":false/);
  assert.match(resp, /bad_request|config/);
});

test("INFRA-VPN-032: a raw OpenVPN argument-injection attempt is rejected as a dangerous directive", async () => {
  // The only channel is `config`; injecting a script directive is caught by the
  // dangerous-directive gate (there is no arg-array channel to abuse).
  const r = await client.request("client_connect", { sessionRef: "inj-sess", config: "client\ndev tun\nup /tmp/x\n" })
    .then(() => "ALLOWED").catch((e) => `REJECTED:${e.code ?? e.message}`);
  assert.match(r, /REJECTED/);
});

test("INFRA-VPN-038: the backend FAILS CLOSED when the helper socket is absent", async () => {
  const orphan = new VpnHelperClient({ socketPath: join(dir, "does-not-exist.sock"), secret: SECRET, timeoutMs: 1500 });
  await assert.rejects(() => orphan.request("client_connect", { sessionRef: "x", config: VALID_CONFIG }), VpnHelperUnavailable);
});
