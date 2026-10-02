/**
 * SEC-REMOTE-DEST-001 — remote-session destination policy.
 * Private infrastructure stays reachable (the product's purpose); metadata,
 * link-local, unspecified, multicast and (by default) loopback are refused,
 * including encoded / IPv4-mapped / multi-answer forms.
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  resolveRemoteDestination, decideRemoteIp, configureRemoteDestinationPolicy, RemoteDestinationDenied, localIpv4Subnets,
} from "./remoteDestination.js";

afterEach(() => configureRemoteDestinationPolicy({}));

const denied = (e: unknown) => e instanceof RemoteDestinationDenied;
const fakeDns = (map: Record<string, string[]>) => async (h: string) => {
  const a = map[h];
  if (!a) throw new Error("ENOTFOUND");
  return a.map((address) => ({ address }));
};

test("REMOTE-DEST-001: RFC1918 / ULA / CGNAT / public stay allowed", async () => {
  for (const ip of ["10.0.0.5", "172.16.3.4", "192.168.1.10", "100.64.0.1", "fd00::5", "8.8.8.8", "2001:db8::1"]) {
    assert.equal(decideRemoteIp(ip), null, ip);
    assert.equal(await resolveRemoteDestination(ip), ip);
  }
});

test("REMOTE-DEST-002: metadata, link-local, unspecified, multicast are always denied", async () => {
  for (const ip of ["169.254.169.254", "169.254.1.1", "0.0.0.0", "fe80::1", "::", "224.0.0.1", "255.255.255.255", "ff02::1", "::ffff:169.254.169.254"]) {
    await assert.rejects(() => resolveRemoteDestination(ip), denied, ip);
  }
  configureRemoteDestinationPolicy({ allowLoopback: true });
  await assert.rejects(() => resolveRemoteDestination("169.254.169.254"), denied); // loopback opt-in does not open metadata
});

test("REMOTE-DEST-003: loopback is denied by default and allowed only on opt-in", async () => {
  for (const ip of ["127.0.0.1", "127.1.2.3", "::1", "::ffff:127.0.0.1", "[::1]"]) {
    await assert.rejects(() => resolveRemoteDestination(ip), denied, ip);
  }
  configureRemoteDestinationPolicy({ allowLoopback: true });
  assert.equal(await resolveRemoteDestination("127.0.0.1"), "127.0.0.1");
});

test("REMOTE-DEST-004: names are judged by what they resolve to (encoded IPs, localhost, rebinding)", async () => {
  // getaddrinfo normalises decimal/hex/short forms to dotted quads.
  const dns = fakeDns({
    localhost: ["127.0.0.1"], "2130706433": ["127.0.0.1"], "0x7f.1": ["127.0.0.1"],
    "metadata.google.internal": ["169.254.169.254"],
    "mixed.example": ["10.0.0.9", "127.0.0.1"], // any bad answer → refuse
    "server.corp": ["10.1.2.3"],
  });
  for (const h of ["localhost", "2130706433", "0x7f.1", "metadata.google.internal", "mixed.example"]) {
    await assert.rejects(() => resolveRemoteDestination(h, dns), denied, h);
  }
  // The checked IP is what the caller connects to (no second lookup to rebind).
  assert.equal(await resolveRemoteDestination("server.corp", dns), "10.1.2.3");
  await assert.rejects(() => resolveRemoteDestination("nope.invalid", dns), denied);
});

test("REMOTE-DEST-005: operator deny CIDRs (e.g. the Docker/PostgreSQL network) are enforced", async () => {
  configureRemoteDestinationPolicy({ denyCidrs: "172.18.0.0/16" });
  await assert.rejects(() => resolveRemoteDestination("172.18.0.2"), denied);
  await assert.rejects(() => resolveRemoteDestination("::ffff:172.18.0.2"), denied);
  assert.equal(await resolveRemoteDestination("172.19.0.2"), "172.19.0.2");
});

test("REMOTE-DEST-006: deny-local-subnets refuses the backend's own network (Docker: postgres/redis)", async () => {
  const subnets = localIpv4Subnets();
  if (subnets.length === 0) return; // no non-loopback IPv4 interface in this sandbox
  const ownIp = subnets[0]!.split("/")[0]!;
  assert.equal(await resolveRemoteDestination(ownIp), ownIp, "allowed when the option is off");
  configureRemoteDestinationPolicy({ denyLocalSubnets: true });
  const dns = fakeDns({ postgres: [ownIp] });
  await assert.rejects(() => resolveRemoteDestination("postgres", dns), denied);
});
