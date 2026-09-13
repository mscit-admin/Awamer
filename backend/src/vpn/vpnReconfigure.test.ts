/**
 * MULTI-VPN-ROLLBACK-001 — rollback-safe port/protocol reconfiguration.
 *
 * VPN-PORT-CHANGE-001..005  successful running port change + correct ordering
 * VPN-ROLLBACK-001..011     failure injection at every stage + stopped/proto
 * VPN-RECONFIG-CONCURRENCY-001  two simultaneous changes → deterministic conflict
 *
 * Fakes for the repo + manager (no DB, no helper, no OpenVPN) so the state
 * machine's ordering + rollback are exercised deterministically.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { VpnReconfigurationService } from "./vpnReconfigure.js";
import { makeVpnPortPolicy } from "../domain/vpnPortPolicy.js";
import type { VpnServer } from "../domain/vpnServer.js";

const POLICY = makeVpnPortPolicy({ min: 20000, max: 30000, reserved: [22, 80, 443, 8081, 5432, 6379] });
const U = "user-1";
const S = "srv-1";

function baseServer(over: Partial<VpnServer> = {}): VpnServer {
  return {
    id: S, userId: U, name: "vpn-a", description: null, publicHost: "vpn.example.com",
    port: 20001, proto: "udp", subnet: "10.8.1.0/24", dns: null, clientToClient: false,
    cipher: "AES-256-GCM", caCert: "ca", caKey: "cak", serverCert: "sc", serverKey: "sk",
    tlsCrypt: "tc", createdAt: new Date(), updatedAt: new Date(), ...over,
  };
}

interface Ctl {
  running: boolean;
  failUpdatePort?: number;      // updateServer throws when patch.port === this
  failUpdateMsg?: string;
  failFwAllowPort?: number;     // firewallAllow returns hard failure for this port
  failFwRemovePort?: number;    // firewallRemove throws for this port
  failStartPort?: number;       // manager.start throws for a server on this port
  unhealthyStartPort?: number;  // manager.start returns non-running for this port
  failStartProto?: "udp" | "tcp"; // manager.start throws for this protocol
  failAllStarts?: boolean;      // manager.start always throws
}

function harness(ctl: Ctl, initial: Partial<VpnServer> = {}) {
  let server = baseServer(initial);
  let runtime = ctl.running ? "running" : "stopped";
  const calls: string[] = [];
  const audits: Record<string, unknown>[] = [];

  const servers = {
    async getServer() { return { ...server }; },
    async updateServer(_u: string, _id: string, patch: Record<string, unknown>) {
      calls.push(`update:${patch.port ?? server.port}/${patch.proto ?? server.proto}`);
      if (ctl.failUpdatePort !== undefined && patch.port === ctl.failUpdatePort) {
        throw new Error(ctl.failUpdateMsg ?? "db update failed");
      }
      server = { ...server, ...patch } as VpnServer;
      return { ...server };
    },
  };

  const fwResult = (applied: boolean, action = false) => ({ applied, action_required: action, backend: "iptables", detail: "" });
  const manager = {
    status() { return { state: runtime }; },
    async stop() { calls.push("stop"); runtime = "stopped"; return true; },
    async start(s: VpnServer) {
      calls.push(`start:${s.port}/${s.proto}`);
      if (ctl.failAllStarts) throw new Error("openvpn start failed");
      if (ctl.failStartPort !== undefined && s.port === ctl.failStartPort) throw new Error("openvpn start failed");
      if (ctl.failStartProto !== undefined && s.proto === ctl.failStartProto) throw new Error("openvpn start failed");
      if (ctl.unhealthyStartPort !== undefined && s.port === ctl.unhealthyStartPort) { runtime = "error"; return { state: "error" }; }
      runtime = "running";
      return { state: "running" };
    },
    async firewallAllow(_id: string, port: number, proto: string) {
      calls.push(`fwAllow:${port}/${proto}`);
      if (ctl.failFwAllowPort !== undefined && port === ctl.failFwAllowPort) return fwResult(false, false);
      return fwResult(true);
    },
    async firewallRemove(_id: string, port: number, proto: string) {
      calls.push(`fwRemove:${port}/${proto}`);
      if (ctl.failFwRemovePort !== undefined && port === ctl.failFwRemovePort) throw new Error("iptables delete failed");
      return fwResult(true);
    },
  };

  const audit = { log(e: Record<string, unknown>) { audits.push(e); } };
  const log = { info() {}, warn() {}, error() {}, debug() {}, child() { return log; } } as unknown as import("../logger/index.js").Logger;
  const svc = new VpnReconfigurationService({
    servers: servers as any, manager: manager as any, audit: audit as any, policy: POLICY, log,
  });
  return { svc, calls, audits, get server() { return server; }, get runtime() { return runtime; } };
}

// ---------------------------------------------------------------- success ---

test("VPN-PORT-CHANGE-001: running 20001/udp → 20005/udp succeeds", async () => {
  const h = harness({ running: true });
  const r = await h.svc.reconfigure(U, S, { port: 20005 });
  assert.equal(r.status, "reconfigured");
  assert.equal(h.server.port, 20005);
  assert.equal(h.runtime, "running");
});

test("VPN-PORT-CHANGE-002/003/004: old rule removed only AFTER a healthy new start", async () => {
  const h = harness({ running: true });
  await h.svc.reconfigure(U, S, { port: 20005 });
  const iAllowNew = h.calls.indexOf("fwAllow:20005/udp");
  const iStop = h.calls.indexOf("stop");
  const iStartNew = h.calls.indexOf("start:20005/udp");
  const iRemoveOld = h.calls.indexOf("fwRemove:20001/udp");
  assert.ok(iAllowNew >= 0 && iStop >= 0 && iStartNew >= 0 && iRemoveOld >= 0, "all steps ran");
  assert.ok(iAllowNew < iStop, "new firewall prepared before stopping old");        // VPN-PORT-CHANGE-002
  assert.ok(iStop < iStartNew, "old stopped before new start");
  assert.ok(iStartNew < iRemoveOld, "OLD firewall removed only after new start");    // VPN-PORT-CHANGE-004
});

test("VPN-PORT-CHANGE-005: DB matches the actual runtime listener after success", async () => {
  const h = harness({ running: true });
  await h.svc.reconfigure(U, S, { port: 20005 });
  assert.equal(h.server.port, 20005);          // DB
  assert.equal(h.calls.includes("start:20005/udp"), true); // runtime listener on the same port
});

// ------------------------------------------------------------- rollbacks ---

test("VPN-ROLLBACK-001: new firewall add fails → old server left working, DB unchanged", async () => {
  const h = harness({ running: true, failFwAllowPort: 20005 });
  const r = await h.svc.reconfigure(U, S, { port: 20005 });
  assert.equal(r.status, "rolled_back");
  assert.equal(h.server.port, 20001, "DB never changed");
  assert.equal(h.runtime, "running", "old server never stopped");
  assert.equal(h.calls.includes("stop"), false, "old was not stopped");
});

test("VPN-ROLLBACK-002: DB update fails → new rule cleaned up, old restored", async () => {
  const h = harness({ running: true, failUpdatePort: 20005 });
  const r = await h.svc.reconfigure(U, S, { port: 20005 });
  assert.equal(r.status, "rolled_back");
  assert.equal(h.server.port, 20001);
  assert.ok(h.calls.includes("fwRemove:20005/udp"), "new firewall rule cleaned up");
  assert.equal(h.runtime, "running", "old restarted");
});

test("VPN-ROLLBACK-003: new OpenVPN start fails → old config + firewall + process restored", async () => {
  const h = harness({ running: true, failStartPort: 20005 });
  const r = await h.svc.reconfigure(U, S, { port: 20005 });
  assert.equal(r.status, "rolled_back");
  assert.equal(h.server.port, 20001, "DB reverted");
  assert.ok(h.calls.includes("fwRemove:20005/udp"), "new firewall rule removed");
  assert.ok(h.calls.includes("start:20001/udp"), "old OpenVPN restarted");
  assert.equal(h.runtime, "running");
});

test("VPN-ROLLBACK-004: new listener unhealthy → rollback performed", async () => {
  const h = harness({ running: true, unhealthyStartPort: 20005 });
  const r = await h.svc.reconfigure(U, S, { port: 20005 });
  assert.equal(r.status, "rolled_back");
  assert.equal(h.server.port, 20001);
  assert.ok(h.calls.includes("start:20001/udp"), "old restarted");
  assert.equal(h.runtime, "running");
});

test("VPN-ROLLBACK-005: new works but old firewall cleanup fails → cleanup_required, new NOT broken", async () => {
  const h = harness({ running: true, failFwRemovePort: 20001 });
  const r = await h.svc.reconfigure(U, S, { port: 20005 });
  assert.equal(r.status, "cleanup_required");
  assert.equal(h.server.port, 20005, "new config committed");
  assert.equal(h.runtime, "running", "new server still running");
});

test("VPN-ROLLBACK-006: rollback restart also fails → RECOVERY_REQUIRED (no false success)", async () => {
  // Every start fails: the new start fails, then the rollback's old-restart fails too.
  const h = harness({ running: true, failAllStarts: true });
  const r = await h.svc.reconfigure(U, S, { port: 20005 });
  assert.equal(r.status, "recovery_required");
  assert.ok(h.audits.some((a) => (a.details as Record<string, unknown>)?.result === "recovery_required"), "recovery audited");
});

// ------------------------------------------------------- stopped server ----

test("VPN-ROLLBACK-007/008/009: reconfigure a STOPPED server → stays stopped, DB updated, no OpenVPN start", async () => {
  const h = harness({ running: false });
  const r = await h.svc.reconfigure(U, S, { port: 20005 });
  assert.equal(r.status, "reconfigured");
  assert.equal(h.server.port, 20005, "DB updated");           // VPN-ROLLBACK-008
  assert.equal(h.runtime, "stopped", "remains stopped");       // VPN-ROLLBACK-007
  assert.equal(h.calls.some((c) => c.startsWith("start:")), false, "no OpenVPN started"); // VPN-ROLLBACK-009
  assert.ok(h.calls.includes("fwAllow:20005/udp") && h.calls.includes("fwRemove:20001/udp"), "firewall moved");
});

// ------------------------------------------------------- protocol change ---

test("VPN-ROLLBACK-010: 20001/udp → 20001/tcp succeeds (port+proto identity)", async () => {
  const h = harness({ running: true });
  const r = await h.svc.reconfigure(U, S, { proto: "tcp" });
  assert.equal(r.status, "reconfigured");
  assert.equal(h.server.proto, "tcp");
  assert.ok(h.calls.includes("fwAllow:20001/tcp") && h.calls.includes("fwRemove:20001/udp"), "rule moved udp→tcp");
});

test("VPN-ROLLBACK-011: protocol-change start failure restores the UDP configuration", async () => {
  // New proto tcp fails to start; rollback must restore + restart the udp config.
  const h = harness({ running: true, failStartProto: "tcp" });
  const r = await h.svc.reconfigure(U, S, { proto: "tcp" });
  assert.equal(r.status, "rolled_back");
  assert.equal(h.server.proto, "udp", "reverted to UDP");
  assert.ok(h.calls.includes("start:20001/udp"), "UDP config restarted");
});

// ---------------------------------------------------------- concurrency ----

test("VPN-RECONFIG-CONCURRENCY-001: two simultaneous changes → one succeeds, other conflicts", async () => {
  const h = harness({ running: true });
  const p1 = h.svc.reconfigure(U, S, { port: 20005 });
  const p2 = h.svc.reconfigure(U, S, { port: 20006 });
  await assert.rejects(p2, (e: unknown) => (e as { code?: string })?.code === "vpn_reconfiguration_in_progress");
  const r1 = await p1;
  assert.equal(r1.status, "reconfigured");
  assert.equal(h.server.port, 20005);
});
