import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertSafeOvpnConfig, assembleOvpnConfig, toVpnProfilePublic, type VpnProfile,
} from "./vpn.js";

function profile(overrides: Partial<VpnProfile> = {}): VpnProfile {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    userId: "22222222-2222-2222-2222-222222222222",
    name: "test",
    description: null,
    runtime: "backend",
    source: "manual",
    remoteHost: "vpn.example.com",
    remotePort: 1194,
    proto: "udp",
    authMode: "none",
    autoConnect: true,
    secret: {},
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

test("assertSafeOvpnConfig accepts a benign config", () => {
  assert.doesNotThrow(() => assertSafeOvpnConfig("client\ndev tun\nremote vpn.example.com 1194 udp\n"));
});

test("assertSafeOvpnConfig rejects command-executing directives", () => {
  for (const line of [
    "up /bin/sh -c 'id'",
    "down /tmp/x.sh",
    "script-security 2",
    "plugin /tmp/evil.so",
    "route-up /tmp/x",
    "tls-verify /tmp/x",
    "auth-user-pass-verify /tmp/x via-file",
    "learn-address /tmp/x",
    "ipchange /tmp/x",
    "iproute /tmp/fake-ip",
  ]) {
    assert.throws(
      () => assertSafeOvpnConfig(`client\n${line}\n`),
      /disallowed directive/,
      `expected "${line}" to be rejected`,
    );
  }
});

test("assertSafeOvpnConfig is case-insensitive and ignores -- prefixes and comments", () => {
  assert.throws(() => assertSafeOvpnConfig("UP /bin/sh"), /disallowed directive/);
  assert.throws(() => assertSafeOvpnConfig("--up /bin/sh"), /disallowed directive/);
  // A commented-out directive is not active and must not trip the check.
  assert.doesNotThrow(() => assertSafeOvpnConfig("# up /bin/sh\nclient\n"));
  assert.doesNotThrow(() => assertSafeOvpnConfig("client ; up here\n"));
});

test("assembleOvpnConfig rejects an inline-cert breakout injection (manual profile)", () => {
  // Attacker closes the <ca> block early and smuggles an `up` script directive.
  const evilCa = "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n</ca>\nup /bin/sh -c id";
  assert.throws(
    () => assembleOvpnConfig(profile({ source: "manual", secret: { ca: evilCa } })),
    /disallowed directive/,
  );
});

test("assembleOvpnConfig builds a manual config and appends auth-user-pass", () => {
  const cfg = assembleOvpnConfig(profile({ source: "manual", authMode: "userpass", secret: {} }));
  assert.match(cfg, /^client$/m);
  assert.match(cfg, /^remote vpn\.example\.com 1194$/m);
  assert.match(cfg, /^auth-user-pass$/m);
});

test("assembleOvpnConfig passes through a benign uploaded config", () => {
  const cfg = assembleOvpnConfig(profile({ source: "config", secret: { ovpn: "client\ndev tun\nremote a.b.c 1194\n" } }));
  assert.match(cfg, /remote a\.b\.c 1194/);
});

test("toVpnProfilePublic strips all secret material to presence flags", () => {
  const pub = toVpnProfilePublic(profile({
    authMode: "userpass",
    secret: { ovpn: "client", username: "u", password: "p", ca: "CA" },
  })) as unknown as Record<string, unknown>;
  assert.equal(pub.has_config, true);
  assert.equal(pub.has_username, true);
  assert.equal(pub.has_password, true);
  assert.equal(pub.has_ca, true);
  // No raw secret fields leak into the public projection.
  assert.equal("secret" in pub, false);
  assert.equal("password" in pub, false);
  assert.equal("ovpn" in pub, false);
});
