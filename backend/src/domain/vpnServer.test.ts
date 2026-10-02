import { test } from "node:test";
import assert from "node:assert/strict";
import { cidrToServerLine, assembleClientOvpn, assembleServerConfig } from "./vpnServer.js";

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
