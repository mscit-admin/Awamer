import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cidrToServerLine, assembleClientOvpn, assembleServerConfig,
  assignClientIps, cidrNetmask, clientIpCcd, internetFirewallSpecs, isSafeVpnUsername,
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

// SEC-VPN-CFG-001 — the server config runs with `script-security 2` inside the
// root, host-network vpn-helper; no interpolated value may inject a directive.
const baseServer = {
  port: 1194, proto: "udp" as const, subnet: "10.8.0.0/24", dns: null, clientToClient: false,
  cipher: "AES-256-GCM", caCert: "CA", serverCert: "CERT", serverKey: "KEY", tlsCrypt: "TC", verifyCommand: "/x/verify.sh",
};

test("VPN-CFG-001: a cipher carrying a newline + `up` directive is rejected (was root RCE)", () => {
  for (const cipher of ['AES-256-GCM\nup "/bin/sh -c id"', "AES-256-GCM\r\nplugin /tmp/x.so", "BF-CBC", "", "aes-256-gcm "]) {
    assert.throws(() => assembleServerConfig({ ...baseServer, cipher }), /invalid VPN cipher/, JSON.stringify(cipher));
    assert.throws(() => assembleClientOvpn({ proto: "udp", publicHost: "vpn.example.com", port: 1194, cipher, caCert: "a", clientCert: "b", clientKey: "c", tlsCrypt: "d" }));
  }
});

test("VPN-CFG-002: allowlisted ciphers still assemble; other scalars are validated too", () => {
  for (const cipher of ["AES-256-GCM", "AES-128-GCM"]) {
    assert.match(assembleServerConfig({ ...baseServer, cipher }), new RegExp(`^cipher ${cipher}$`, "m"));
  }
  assert.throws(() => assembleServerConfig({ ...baseServer, subnet: "10.8.0.0/24\nup x" }), /invalid VPN subnet/);
  assert.throws(() => assembleServerConfig({ ...baseServer, dns: "1.1.1.1\nup x" }), /invalid VPN DNS/);
  assert.throws(() => assembleServerConfig({ ...baseServer, proto: "udp\nup x" as "udp" }), /invalid VPN protocol/);
  assert.throws(() => assembleClientOvpn({ proto: "udp", publicHost: "h\nup x", port: 1194, cipher: "AES-256-GCM", caCert: "a", clientCert: "b", clientKey: "c", tlsCrypt: "d" }), /invalid VPN public host/);
});

// ---- Internet policy (VPN-INET-*) ------------------------------------------
test("VPN-INET-001: clients get stable fixed addresses in sorted-username order, skipping the server's .1", () => {
  const m = assignClientIps("10.8.0.0/24", ["carol", "alice", "bob", "alice"]);
  assert.deepEqual([...m.entries()], [["alice", "10.8.0.2"], ["bob", "10.8.0.3"], ["carol", "10.8.0.4"]]);
  assert.equal(cidrNetmask("10.8.0.0/24"), "255.255.255.0");
  assert.equal(clientIpCcd("10.8.0.2", "255.255.255.0"), "ifconfig-push 10.8.0.2 255.255.255.0\n");
  // A /30 has two usable hosts: the server (.1) and one client.
  assert.equal(assignClientIps("10.9.0.0/30", ["a", "b"]).size, 1);
});

test("VPN-INET-002: firewall rules block listed clients before the general allow, all tagged", () => {
  const specs = internetFirewallSpecs("10.8.0.0/24", ["10.8.0.3"], "awamer-vpn-inet:S1");
  const flat = specs.map((s) => `${s.table ?? "filter"} ${s.chain} ${s.rule.join(" ")}`);
  const drop = flat.findIndex((r) => r.includes("-s 10.8.0.3/32") && r.endsWith("-j DROP"));
  const allow = flat.findIndex((r) => r.includes("-s 10.8.0.0/24 ! -d 10.8.0.0/24") && r.endsWith("-j ACCEPT"));
  assert.ok(drop >= 0 && allow > drop, "the per-client DROP precedes the internet ACCEPT");
  assert.ok(flat.some((r) => r.startsWith("nat POSTROUTING") && r.endsWith("-j MASQUERADE")));
  assert.ok(specs.every((s) => s.rule.includes("awamer-vpn-inet:S1")), "every rule carries the ownership tag");
});

test("VPN-INET-003: server config with the policy pins clients and pushes the default route", () => {
  const cfg = assembleServerConfig({ ...baseServer, clientConfigDir: "/var/lib/awamer/vpn-runtime/server-x/ccd", internetPolicy: true });
  assert.match(cfg, /^client-config-dir \/var\/lib\/awamer\/vpn-runtime\/server-x\/ccd$/m);
  assert.match(cfg, /^ccd-exclusive$/m);
  assert.match(cfg, /^push "redirect-gateway def1 bypass-dhcp"$/m);
  const plain = assembleServerConfig(baseServer);
  assert.doesNotMatch(plain, /client-config-dir|ccd-exclusive|redirect-gateway/);
});

test("VPN-INET-004: a client-config-dir that could inject a directive is rejected", () => {
  for (const bad of ["/tmp/ccd\nup /bin/sh", "relative/ccd", "/tmp/c cd", "/tmp/\"ccd"]) {
    assert.throws(() => assembleServerConfig({ ...baseServer, clientConfigDir: bad }), /client-config-dir/);
  }
});

test("VPN-INET-005: usernames that would escape the client-config-dir are not safe", () => {
  for (const u of ["alice", "bob.smith", "ops_1", "a-b"]) assert.equal(isSafeVpnUsername(u), true);
  for (const u of [".", "..", "../etc", "a/b", "", "x".repeat(65), "a b", 5, null]) assert.equal(isSafeVpnUsername(u), false);
});
