/**
 * Multi-VPN-Server firewall + runtime port-collision helper tests.
 * VPN-FW-005..008 (validation / no arbitrary command / structured only),
 * firewall allow/remove ownership tagging, backend "none" action-required, and
 * the runtime port-in-use probe. Fake spawn/probe — no root/iptables/Docker.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { HelperCore, type SpawnFn, type ChildLike } from "./helperCore.js";

/** Fake iptables: -C (check) → not present (1); -I/-D → success (0), one -D then done. */
function fakeIptables(): { fn: SpawnFn; calls: string[][] } {
  const calls: string[][] = [];
  let deletes = 0;
  const fn: SpawnFn = (cmd, args) => {
    calls.push([cmd, ...args]);
    const stdout = new EventEmitter(), stderr = new EventEmitter(), ee = new EventEmitter() as any;
    ee.stdout = stdout; ee.stderr = stderr; ee.kill = () => true;
    let code = 0;
    if (args.includes("-C")) code = 1;                 // rule not present yet
    else if (args.includes("-D")) code = deletes++ === 0 ? 0 : 1; // remove one then stop
    setImmediate(() => ee.emit("exit", code));
    return ee as ChildLike;
  };
  return { fn, calls };
}
const core = (over = {}) => new HelperCore({ iptablesPath: "/usr/sbin/iptables", portMin: 20000, portMax: 30000, firewallBackend: "iptables", ...over });
const SID = "11111111-2222-3333-4444-555555555555";
/** assert.rejects matcher on HelperError.code. */
const code = (c: string) => (e: unknown) => (e as { code?: string })?.code === c;

test("firewall_allow uses the fixed iptables path + argument array with an ownership comment (no shell)", async () => {
  const fk = fakeIptables();
  const c = core({ spawnFn: fk.fn });
  const r = await c.firewallAllow(SID, 20001, "udp");
  assert.equal(r.applied, true);
  // First a -C check, then a -I insert.
  const insert = fk.calls.find((a) => a.includes("-I"));
  assert.ok(insert, "an insert was issued");
  assert.equal(insert![0], "/usr/sbin/iptables");               // fixed binary
  assert.ok(insert!.includes("--comment") && insert!.includes(`awamer-vpn:${SID}`), "ownership comment tag present");
  assert.ok(insert!.includes("20001") && insert!.includes("udp"));
});

test("firewall_remove deletes ONLY the Awamer-tagged rule", async () => {
  const fk = fakeIptables();
  const c = core({ spawnFn: fk.fn });
  const r = await c.firewallRemove(SID, 20001, "udp");
  assert.equal(r.applied, true);
  const del = fk.calls.find((a) => a.includes("-D"));
  assert.ok(del!.includes(`awamer-vpn:${SID}`), "delete matches the ownership tag only");
});

test("VPN-FW-006: a reserved/out-of-window port cannot reach the firewall command", async () => {
  const fk = fakeIptables();
  const c = core({ spawnFn: fk.fn });
  await assert.rejects(() => c.firewallAllow(SID, 443, "udp"), code("bad_port"));   // below window
  await assert.rejects(() => c.firewallAllow(SID, 40000, "udp"), code("bad_port")); // above window
  assert.equal(fk.calls.length, 0, "iptables never invoked for a disallowed port");
});

test("VPN-FW-007/008: arbitrary protocol / bad server id are rejected before any command", async () => {
  const fk = fakeIptables();
  const c = core({ spawnFn: fk.fn });
  await assert.rejects(() => c.firewallAllow(SID, 20001, "raw"), code("bad_proto"));
  await assert.rejects(() => c.firewallAllow("../../etc", 20001, "udp"), code("bad_ref"));
  assert.equal(fk.calls.length, 0);
});

test("VPN-FW backend=none reports action_required (no command run)", async () => {
  const fk = fakeIptables();
  const c = core({ spawnFn: fk.fn, firewallBackend: "none" });
  const r = await c.firewallAllow(SID, 20001, "udp");
  assert.equal(r.applied, false);
  assert.equal(r.actionRequired, true);
  assert.equal(fk.calls.length, 0);
});

// ---- MULTI-VPN-FW-001: firewall backend availability (fail-closed) ----------

test("VPN-FW-BINARY-003: health reports the firewall backend + availability after a successful probe", async () => {
  const fk = fakeIptables();
  // Point at an executable that exists in the test env; --version returns 0 (fake).
  const c = core({ spawnFn: fk.fn, iptablesPath: process.execPath, iptablesCandidates: [] });
  const probe = await c.probeFirewall();
  assert.deepEqual(probe, { firewallBackend: "iptables", firewallAvailable: true });
  const h = await c.health();
  assert.equal(h.firewallBackend, "iptables");
  assert.equal(h.firewallAvailable, true);
});

test("VPN-FW-BINARY-004: a MISSING firewall executable fails closed (no command run, health=false)", async () => {
  const fk = fakeIptables();
  const c = core({ spawnFn: fk.fn, iptablesPath: "/no/such/iptables", iptablesCandidates: ["/also/missing"] });
  const probe = await c.probeFirewall();
  assert.equal(probe.firewallAvailable, false);
  const h = await c.health();
  assert.equal(h.firewallAvailable, false);
  // firewall ops now fail closed: action required, and iptables is NEVER invoked.
  const r = await c.firewallAllow(SID, 20001, "udp");
  assert.equal(r.applied, false);
  assert.equal(r.actionRequired, true);
  assert.equal(fk.calls.length, 0, "no iptables command attempted when backend is unavailable");
});

test("VPN-FW-BINARY-003b: backend=none reports firewallAvailable=false in health", async () => {
  const c = core({ firewallBackend: "none" });
  await c.probeFirewall();
  const h = await c.health();
  assert.equal(h.firewallBackend, "none");
  assert.equal(h.firewallAvailable, false);
});

test("VPN-FW-BINARY-005: firewall execution is structured (fixed path + arg array, never a shell)", async () => {
  const seen: { cmd: string; args: string[]; opts: Record<string, unknown> }[] = [];
  const fn: SpawnFn = (cmd, args, opts) => {
    seen.push({ cmd, args, opts: opts as Record<string, unknown> });
    const ee = new EventEmitter() as any; ee.stdout = new EventEmitter(); ee.stderr = new EventEmitter(); ee.kill = () => true;
    setImmediate(() => ee.emit("exit", args.includes("-C") ? 1 : 0));
    return ee as ChildLike;
  };
  const c = core({ spawnFn: fn });
  await c.firewallAllow(SID, 20001, "udp");
  assert.ok(seen.length > 0);
  for (const s of seen) {
    assert.equal(s.cmd, "/usr/sbin/iptables", "fixed executable path");
    assert.ok(Array.isArray(s.args), "arguments are an array");
    assert.ok(!("shell" in s.opts) || s.opts.shell !== true, "never spawned via a shell");
    // No single argument is a packed shell string / rule blob.
    assert.ok(!s.args.some((a) => /[;&|`$]/.test(a)), "no shell metacharacters in any argument");
  }
});

test("runtime port-collision: serverStart rejects vpn_port_in_use when the port is occupied", async () => {
  const c = new HelperCore({
    spawnFn: (() => { const ee = new EventEmitter() as any; ee.stdout = new EventEmitter(); ee.stderr = new EventEmitter(); ee.kill = () => true; return ee; }) as unknown as SpawnFn,
    portProbe: async () => false, // port is occupied
    startupTimeoutMs: 500,
  });
  await assert.rejects(
    () => c.serverStart({ serverId: SID, port: 20002, proto: "udp", subnet: "10.8.1.0/24", dns: null, clientToClient: true, cipher: "AES-256-GCM", caCert: "x", serverCert: "y", serverKey: "z", tlsCrypt: "t" }),
    code("vpn_port_in_use"),
  );
});

// ---- Internet policy on the helper (VPN-INET-HELPER-*) ---------------------
import { mkdtemp, readFile, readdir, writeFile as writeFileFs, rm as rmFs } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Fake spawn: openvpn becomes ready; iptables -D fails (nothing to delete), everything else succeeds. */
function fakeSpawnAll(opts: { failInsert?: boolean } = {}) {
  const ipt: string[][] = [];
  const fn: SpawnFn = (cmd, args) => {
    const stdout = new EventEmitter(), stderr = new EventEmitter(), ee = new EventEmitter() as any;
    ee.stdout = stdout; ee.stderr = stderr; ee.kill = () => { setImmediate(() => ee.emit("exit", 0)); return true; }; ee.pid = 77;
    if (cmd === "/usr/sbin/iptables") {
      ipt.push(args);
      const code = args.includes("-D") ? 1 : opts.failInsert && args.includes("-I") && ipt.filter((a) => a.includes("-I")).length >= 3 ? 1 : 0;
      setImmediate(() => ee.emit("exit", code));
    } else {
      setImmediate(() => stdout.emit("data", Buffer.from("Initialization Sequence Completed\n")));
    }
    return ee as ChildLike;
  };
  return { fn, ipt };
}
const SERVER_INPUT = {
  serverId: SID, port: 20001, proto: "udp" as const, subnet: "10.8.0.0/24", dns: null, clientToClient: false,
  cipher: "AES-256-GCM", caCert: "CA", serverCert: "SC", serverKey: "SK", tlsCrypt: "TC",
};

test("VPN-INET-HELPER-001: policy on → per-client files, ccd-exclusive config and tagged rules; stop removes them", async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), "awamer-inet-"));
  const fwd = join(runtimeDir, "ip_forward"); await writeFileFs(fwd, "1\n");
  const fk = fakeSpawnAll();
  const c = core({ spawnFn: fk.fn, runtimeDir, openvpnPath: "/usr/sbin/openvpn", portProbe: async () => true, ipForwardPath: fwd });
  const r = await c.serverStart({ ...SERVER_INPUT, internetAccess: true, clients: [
    { username: "bob", internetAccess: false }, { username: "alice", internetAccess: true },
  ] });
  assert.equal(r.state, "running");
  assert.deepEqual(r.internet, { applied: true, detail: "applied" });
  const dir = join(runtimeDir, `server-${SID}`);
  assert.deepEqual((await readdir(join(dir, "ccd"))).sort(), ["alice", "bob"]);
  assert.equal(await readFile(join(dir, "ccd", "bob"), "utf8"), "ifconfig-push 10.8.0.3 255.255.255.0\n");
  const conf = await readFile(join(dir, "server.conf"), "utf8");
  assert.match(conf, /^ccd-exclusive$/m);
  assert.match(conf, /^push "redirect-gateway def1 bypass-dhcp"$/m);
  const inserts = fk.ipt.filter((a) => a.includes("-I"));
  assert.ok(inserts.length >= 5 && inserts.every((a) => a.includes(`awamer-vpn-inet:${SID}`)), "all inserted rules are tagged");
  assert.ok(inserts.some((a) => a.includes("10.8.0.3/32") && a.includes("DROP")), "bob (blocked) gets a DROP");
  assert.ok(!inserts.some((a) => a.includes("10.8.0.2/32")), "alice (allowed) has no DROP");
  const before = fk.ipt.length;
  c.serverStop(SID);
  await new Promise((res) => setTimeout(res, 50));
  const deletes = fk.ipt.slice(before).filter((a) => a.includes("-D"));
  assert.ok(deletes.length >= inserts.length && deletes.every((a) => a.includes(`awamer-vpn-inet:${SID}`)), "stop removes the tagged rules");
  await rmFs(runtimeDir, { recursive: true, force: true });
});

test("VPN-INET-HELPER-002: a failing rule is rolled back and the VPN still runs", async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), "awamer-inet-"));
  const fk = fakeSpawnAll({ failInsert: true });
  const c = core({ spawnFn: fk.fn, runtimeDir, openvpnPath: "/usr/sbin/openvpn", portProbe: async () => true, ipForwardPath: join(runtimeDir, "none") });
  const r = await c.serverStart({ ...SERVER_INPUT, internetAccess: true, clients: [{ username: "bob", internetAccess: false }] });
  assert.equal(r.state, "running");
  assert.equal(r.internet?.applied, false);
  const inserted = fk.ipt.filter((a) => a.includes("-I")).length;
  const removed = fk.ipt.filter((a) => a.includes("-D")).length;
  assert.ok(removed > 0 && inserted > 0, "rollback deletes what was inserted");
  c.serverStop(SID);
  await rmFs(runtimeDir, { recursive: true, force: true });
});

test("VPN-INET-HELPER-003: policy off → no client files, no routing push, no iptables calls", async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), "awamer-inet-"));
  const fk = fakeSpawnAll();
  const c = core({ spawnFn: fk.fn, runtimeDir, openvpnPath: "/usr/sbin/openvpn", portProbe: async () => true });
  const r = await c.serverStart({ ...SERVER_INPUT });
  assert.equal(r.state, "running");
  assert.equal(r.internet, undefined);
  const conf = await readFile(join(runtimeDir, `server-${SID}`, "server.conf"), "utf8");
  assert.doesNotMatch(conf, /ccd|redirect-gateway/);
  assert.equal(fk.ipt.length, 0);
  c.serverStop(SID);
  await rmFs(runtimeDir, { recursive: true, force: true });
});

test("VPN-INET-HELPER-004: the IPC layer rejects a malformed client list before the core", async () => {
  const { dispatch } = await import("./helperServer.js");
  let called = false;
  const fakeCore = { serverStart: async () => { called = true; return { state: "running", error: null }; } } as never;
  const base = { ...SERVER_INPUT };
  const req = (payload: Record<string, unknown>) => ({ op: "server_start", payload: { ...base, ...payload } }) as never;
  for (const clients of [[{ username: "../x", internetAccess: true }], [{ username: "a" }], "x", new Array(4097).fill({ username: "a", internetAccess: true })]) {
    await assert.rejects(() => dispatch(fakeCore, req({ internetAccess: true, clients })), code("bad_request"));
  }
  assert.equal(called, false);
  await dispatch(fakeCore, req({ internetAccess: true, clients: [{ username: "alice", internetAccess: true }] }));
  assert.equal(called, true);
});
