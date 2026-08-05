import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cidrToServerLine, cidrNetmask, assembleClientOvpn, assembleServerConfig,
  assignClientIps, clientIpCcd, internetFirewallSpecs,
} from "./vpnServer.js";

test("cidrToServerLine converts CIDR to network+netmask", () => {
  assert.equal(cidrToServerLine("10.8.0.0/24"), "10.8.0.0 255.255.255.0");
  assert.equal(cidrToServerLine("10.0.0.0/16"), "10.0.0.0 255.255.0.0");
  assert.equal(cidrToServerLine("192.168.50.0/23"), "192.168.50.0 255.255.254.0");
});

test("assembleClientOvpn produces a valid unified client config", () => {
  const cfg = assembleClientOvpn({
    proto: "udp", publicHost: "vpn.example.com", port: 1194, cipher: "AES-256-GCM",
    caCert: "CA", clientCert: "CERT", clientKey: "KEY", tlsCrypt: "TLSCRYPT",
  });
  assert.match(cfg, /^client$/m);
  assert.match(cfg, /^remote vpn\.example\.com 1194$/m);
  assert.match(cfg, /^remote-cert-tls server$/m);
  assert.match(cfg, /^auth-user-pass$/m);
  for (const tag of ["ca", "cert", "key", "tls-crypt"]) {
    assert.match(cfg, new RegExp(`<${tag}>`), `missing <${tag}>`);
  }
});

test("assembleServerConfig includes verify, subnet, tls-crypt and client-to-client toggle", () => {
  const base = {
    port: 1194, proto: "udp" as const, subnet: "10.8.0.0/24", dns: "1.1.1.1",
    cipher: "AES-256-GCM", caCert: "CA", serverCert: "SC", serverKey: "SK", tlsCrypt: "TC",
    verifyCommand: "node /app/dist/vpn/authVerify.js",
  };
  const on = assembleServerConfig({ ...base, clientToClient: true });
  assert.match(on, /^server 10\.8\.0\.0 255\.255\.255\.0$/m);
  assert.match(on, /^auth-user-pass-verify node \/app\/dist\/vpn\/authVerify\.js via-file$/m);
  assert.match(on, /^client-to-client$/m);
  assert.match(on, /push "dhcp-option DNS 1\.1\.1\.1"/);
  assert.match(on, /<tls-crypt>/);
  const off = assembleServerConfig({ ...base, clientToClient: false });
  assert.doesNotMatch(off, /^client-to-client$/m);
});

test("assembleServerConfig adds client-config-dir + redirect-gateway only under internet policy", () => {
  const base = {
    port: 1194, proto: "udp" as const, subnet: "10.8.0.0/24", dns: null,
    clientToClient: true, cipher: "AES-256-GCM", caCert: "CA", serverCert: "SC", serverKey: "SK",
    tlsCrypt: "TC", verifyCommand: "cmd",
  };
  const without = assembleServerConfig(base);
  assert.doesNotMatch(without, /^client-config-dir/m);
  assert.doesNotMatch(without, /redirect-gateway/);
  const withPolicy = assembleServerConfig({ ...base, clientConfigDir: "/run/ccd", internetPolicy: true });
  assert.match(withPolicy, /^client-config-dir \/run\/ccd$/m);
  assert.match(withPolicy, /^push "redirect-gateway def1 bypass-dhcp"$/m);
});

test("cidrNetmask + assignClientIps give stable, server-skipping addresses", () => {
  assert.equal(cidrNetmask("10.8.0.0/24"), "255.255.255.0");
  assert.equal(cidrNetmask("10.0.0.0/16"), "255.255.0.0");
  const ips = assignClientIps("10.8.0.0/24", ["charlie", "alice", "bob"]);
  // Sorted by username, starting at .2 (.1 is the server).
  assert.equal(ips.get("alice"), "10.8.0.2");
  assert.equal(ips.get("bob"), "10.8.0.3");
  assert.equal(ips.get("charlie"), "10.8.0.4");
  // Deterministic across calls.
  assert.deepEqual([...assignClientIps("10.8.0.0/24", ["bob", "alice"]).entries()], [["alice", "10.8.0.2"], ["bob", "10.8.0.3"]]);
  assert.equal(clientIpCcd("10.8.0.5", "255.255.255.0"), "ifconfig-push 10.8.0.5 255.255.255.0\n");
});

test("internetFirewallSpecs drops blocked IPs before the general internet accept", () => {
  const specs = internetFirewallSpecs("10.8.0.0/24", ["10.8.0.3", "10.8.0.7"]);
  const flat = specs.map((s) => `${s.table ?? "filter"} ${s.chain} ${s.rule.join(" ")}`);
  // Local subnet reachable by everyone.
  assert.ok(flat.some((r) => r === "filter FORWARD -s 10.8.0.0/24 -d 10.8.0.0/24 -j ACCEPT"));
  // Each blocked IP dropped for non-local (internet) destinations.
  const dropC = flat.findIndex((r) => r === "filter FORWARD -s 10.8.0.3 ! -d 10.8.0.0/24 -j DROP");
  const dropG = flat.findIndex((r) => r === "filter FORWARD -s 10.8.0.7 ! -d 10.8.0.0/24 -j DROP");
  const accept = flat.findIndex((r) => r === "filter FORWARD -s 10.8.0.0/24 ! -d 10.8.0.0/24 -j ACCEPT");
  assert.ok(dropC >= 0 && dropG >= 0 && accept >= 0);
  assert.ok(dropC < accept && dropG < accept, "DROP rules must come before the general ACCEPT");
  // NAT masquerade present.
  assert.ok(flat.some((r) => r === "nat POSTROUTING -s 10.8.0.0/24 ! -d 10.8.0.0/24 -j MASQUERADE"));
  // No blocked IPs → no DROP rules.
  assert.equal(internetFirewallSpecs("10.8.0.0/24", []).filter((s) => s.rule.includes("DROP")).length, 0);
});
