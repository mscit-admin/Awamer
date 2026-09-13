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
