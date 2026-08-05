import { test } from "node:test";
import assert from "node:assert/strict";
import { cidrToServerLine, assembleClientOvpn, assembleServerConfig, clientInternetCcd } from "./vpnServer.js";

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

test("assembleServerConfig adds client-config-dir only when internet routing is on", () => {
  const base = {
    port: 1194, proto: "udp" as const, subnet: "10.8.0.0/24", dns: null,
    clientToClient: true, cipher: "AES-256-GCM", caCert: "CA", serverCert: "SC", serverKey: "SK",
    tlsCrypt: "TC", verifyCommand: "cmd",
  };
  const without = assembleServerConfig(base);
  assert.doesNotMatch(without, /^client-config-dir/m);
  const withCcd = assembleServerConfig({ ...base, clientConfigDir: "/run/ccd" });
  assert.match(withCcd, /^client-config-dir \/run\/ccd$/m);
});

test("clientInternetCcd pushes redirect-gateway (and DNS when set)", () => {
  const noDns = clientInternetCcd(null);
  assert.match(noDns, /push "redirect-gateway def1 bypass-dhcp"/);
  assert.doesNotMatch(noDns, /dhcp-option DNS/);
  const withDns = clientInternetCcd("9.9.9.9");
  assert.match(withDns, /push "redirect-gateway def1 bypass-dhcp"/);
  assert.match(withDns, /push "dhcp-option DNS 9\.9\.9\.9"/);
});
