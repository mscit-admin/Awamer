/**
 * SEC-INFRA-001 — vpn-helper core tests. A fake spawn lets these run without
 * root/openvpn/Docker while proving the security-relevant behaviour:
 *  - dangerous OpenVPN directives are rejected BEFORE any spawn (INFRA-VPN-011..020)
 *  - path-traversal session refs are rejected (INFRA-VPN-021..024)
 *  - fixed binary + argument array + shell:false; --script-security 1 forced
 *  - process control: stop maps ref→proc, unknown refs are no-ops, session cap,
 *    child terminated, secret temp files cleaned (INFRA-VPN-033..037)
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, access, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HelperCore, type SpawnFn, type ChildLike } from "./helperCore.js";

let runtimeDir = "";
beforeEach(async () => { runtimeDir = await mkdtemp(join(tmpdir(), "awamer-helper-test-")); });
afterEach(async () => { await rm(runtimeDir, { recursive: true, force: true }).catch(() => {}); });

interface FakeChild extends ChildLike { emitReady(): void; emitExit(code: number): void; killed: boolean; }
function makeFakeSpawn(opts: { autoReady?: boolean; autoExit?: number } = {}): { fn: SpawnFn; calls: { cmd: string; args: string[]; opts: any }[]; children: FakeChild[] } {
  const calls: { cmd: string; args: string[]; opts: any }[] = [];
  const children: FakeChild[] = [];
  const fn: SpawnFn = (cmd, args, o) => {
    calls.push({ cmd, args, opts: o });
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const ee = new EventEmitter();
    const child = ee as unknown as FakeChild;
    (child as any).stdout = stdout;
    (child as any).stderr = stderr;
    (child as any).pid = 4242;
    child.killed = false;
    child.kill = () => { child.killed = true; setImmediate(() => ee.emit("exit", 0)); return true; };
    child.emitReady = () => stdout.emit("data", Buffer.from("Initialization Sequence Completed\n"));
    child.emitExit = (code: number) => ee.emit("exit", code);
    children.push(child);
    if (opts.autoExit !== undefined) setImmediate(() => child.emitExit(opts.autoExit!));
    else if (opts.autoReady !== false) setImmediate(() => child.emitReady());
    return child;
  };
  return { fn, calls, children };
}

const VALID_CONFIG = "client\ndev tun\nproto udp\nremote 198.51.100.7 1194\n";

function core(spawnFn: SpawnFn) {
  return new HelperCore({ openvpnPath: "/usr/sbin/openvpn", runtimeDir, spawnFn, startupTimeoutMs: 1000, maxSessions: 3 });
}

test("valid client config spawns the fixed binary with an argument array, shell:false, --script-security 1", async () => {
  const s = makeFakeSpawn();
  const c = core(s.fn);
  const r = await c.clientConnect({ sessionRef: "sess-ok-1", config: VALID_CONFIG });
  assert.equal(r.state, "running");
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0]!.cmd, "/usr/sbin/openvpn"); // fixed path
  assert.ok(Array.isArray(s.calls[0]!.args));         // argument array, not a string
  assert.deepEqual(s.calls[0]!.args.slice(-2), ["--script-security", "1"]); // forced sandbox
  // SEC-OVPN-FILE-001: server-pushed default-route takeover is filtered.
  assert.ok(s.calls[0]!.args.join(" ").includes("--pull-filter ignore redirect-gateway"));
  assert.equal(s.calls[0]!.opts.shell, undefined);    // never shell:true
});

// ---- INFRA-VPN-011..020: dangerous directives rejected before any spawn ----
const DANGEROUS: Record<string, string> = {
  "011 script-security 3": "client\ndev tun\nscript-security 3\n",
  "012 up script": "client\ndev tun\nup /tmp/x\n",
  "013 down script": "client\ndev tun\ndown /tmp/x\n",
  "014 plugin": "client\ndev tun\nplugin /tmp/evil.so\n",
  "015 route-up": "client\ndev tun\nroute-up /tmp/x\n",
  "016 client-connect": "client\ndev tun\nclient-connect /tmp/x\n",
  "017 auth-user-pass-verify": "client\ndev tun\nauth-user-pass-verify /tmp/x via-file\n",
  "018 learn-address": "client\ndev tun\nlearn-address /tmp/x\n",
  "019 tls-verify": "client\ndev tun\ntls-verify /tmp/x\n",
  "020 ipchange + PEM-smuggled up": "client\ndev tun\n<ca>\n-----BEGIN CERTIFICATE-----\n</ca>\nup /tmp/x\n",
};
for (const [label, cfg] of Object.entries(DANGEROUS)) {
  test(`INFRA-VPN-${label}: rejected before spawn`, async () => {
    const s = makeFakeSpawn();
    const c = core(s.fn);
    await assert.rejects(() => c.clientConnect({ sessionRef: `sess-${label.slice(0, 3)}`, config: cfg }));
    assert.equal(s.calls.length, 0, "openvpn must NOT be spawned for a dangerous config");
  });
}

// ---- INFRA-VPN-021..024: path-traversal refs rejected ----
const BAD_REFS = ["../../../etc/passwd", "/etc/shadow", "..%2f..%2fetc", "a/../../b"];
for (let i = 0; i < BAD_REFS.length; i++) {
  test(`INFRA-VPN-02${i + 1}: path-traversal ref "${BAD_REFS[i]}" rejected`, async () => {
    const s = makeFakeSpawn();
    const c = core(s.fn);
    await assert.rejects(() => c.clientConnect({ sessionRef: BAD_REFS[i]!, config: VALID_CONFIG }), /bad_ref|invalid/);
    assert.equal(s.calls.length, 0);
  });
}

// ---- INFRA-VPN-033..037: process control ----
test("INFRA-VPN-033: stop maps a ref to a helper-started process (no arbitrary PID)", async () => {
  const s = makeFakeSpawn();
  const c = core(s.fn);
  await c.clientConnect({ sessionRef: "sess-stop", config: VALID_CONFIG });
  const child = s.children[0]!;
  assert.equal(c.clientStop("sess-stop"), true);
  assert.equal(child.killed, true, "the tracked child was signalled");
});

test("INFRA-VPN-034: stopping an unknown/unstarted session is a safe no-op", async () => {
  const s = makeFakeSpawn();
  const c = core(s.fn);
  assert.equal(c.clientStop("never-started"), false);
  assert.equal(s.children.length, 0);
});

test("INFRA-VPN-035: the concurrent-session cap is enforced", async () => {
  const s = makeFakeSpawn();
  const c = core(s.fn); // maxSessions: 3
  await c.clientConnect({ sessionRef: "s1", config: VALID_CONFIG });
  await c.clientConnect({ sessionRef: "s2", config: VALID_CONFIG });
  await c.clientConnect({ sessionRef: "s3", config: VALID_CONFIG });
  await assert.rejects(() => c.clientConnect({ sessionRef: "s4", config: VALID_CONFIG }), /too_many|limit/);
});

test("INFRA-VPN-036: a child that exits before ready is reported as failure and cleaned up", async () => {
  const s = makeFakeSpawn({ autoExit: 1 });
  const c = core(s.fn);
  await assert.rejects(() => c.clientConnect({ sessionRef: "sess-fail", config: VALID_CONFIG }), /exited|before ready/);
  // runtime dir for the failed session is removed
  await assert.rejects(access(join(runtimeDir, "client-sess-fail")), /ENOENT/);
});

test("INFRA-VPN-037: secret temp files (auth.txt) are removed when the session stops", async () => {
  const s = makeFakeSpawn();
  const c = core(s.fn);
  await c.clientConnect({ sessionRef: "sess-secret", config: VALID_CONFIG, authUser: "alice", authPass: "hunter2" });
  const dir = join(runtimeDir, "client-sess-secret");
  const before = await readdir(dir);
  assert.ok(before.includes("auth.txt"), "auth file was written for the running session");
  c.clientStop("sess-secret");
  await new Promise((r) => setTimeout(r, 20));
  await assert.rejects(access(dir), /ENOENT/, "secret material dir removed on stop");
});

test("health reports capability presence without leaking secrets", async () => {
  const s = makeFakeSpawn();
  const c = core(s.fn);
  const h = await c.health();
  assert.equal(typeof h.openvpn, "boolean");
  assert.equal(typeof h.tun, "boolean");
  assert.equal(h.ready, true);
  assert.ok(!Object.prototype.hasOwnProperty.call(h, "secret"));
});
