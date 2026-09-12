/**
 * Network CIDR hardening — pure policy unit tests (no DB). Covers the
 * allow/deny/sensitive classification and CIDR containment used by the network
 * diagnostics routes. Complements the route-level netCidr.itest.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseCidr, parseCidrList, cidrContainsIp, cidrWithin,
  isSensitiveIp, isPrivateIp, decideTargetIp, decideScanCidr, ipToInt,
  type NetworkDiagnosticPolicy,
} from "./networkPolicy.js";

const EMPTY: NetworkDiagnosticPolicy = { allowed: [], deny: [] };
const allow = (...cidrs: string[]): NetworkDiagnosticPolicy => ({ allowed: parseCidrList(cidrs.join(",")), deny: [] });

test("parseCidr accepts valid IPv4 CIDRs and a bare IP as /32", () => {
  assert.deepEqual(parseCidr("192.168.10.0/24"), { base: ipToInt("192.168.10.0"), prefix: 24 });
  assert.deepEqual(parseCidr("10.1.2.3"), { base: ipToInt("10.1.2.3"), prefix: 32 });
  assert.equal(parseCidr("nope"), null);
  assert.equal(parseCidr("192.168.1.0/33"), null);
  assert.equal(parseCidr("::1/64"), null); // IPv6 not accepted in the allow list
});

test("cidrContainsIp / cidrWithin enforce full containment", () => {
  const c24 = parseCidr("192.168.10.0/24")!;
  assert.ok(cidrContainsIp(c24, ipToInt("192.168.10.42")!));
  assert.ok(!cidrContainsIp(c24, ipToInt("192.168.11.42")!));
  assert.ok(cidrWithin(parseCidr("192.168.10.0/28")!, c24), "/28 is inside /24");
  assert.ok(!cidrWithin(parseCidr("192.168.0.0/16")!, c24), "/16 is broader than /24");
  assert.ok(!cidrWithin(parseCidr("192.168.20.0/24")!, c24), "different /24");
});

test("isSensitiveIp flags loopback/link-local/metadata/multicast/broadcast/unspecified", () => {
  for (const ip of ["127.0.0.1", "0.0.0.0", "169.254.0.1", "169.254.169.254", "224.0.0.1", "255.255.255.255", "::1", "fe80::1", "ff02::1"]) {
    assert.ok(isSensitiveIp(ip), `${ip} sensitive`);
  }
  assert.ok(!isSensitiveIp("192.168.1.1"));
  assert.ok(!isSensitiveIp("8.8.8.8"));
  assert.ok(isSensitiveIp("::ffff:127.0.0.1"), "IPv4-mapped loopback");
});

test("isPrivateIp flags RFC1918 + CGNAT + IPv6 ULA", () => {
  for (const ip of ["10.0.0.1", "172.16.5.5", "172.31.9.9", "192.168.1.1", "100.64.0.1", "fd00::1"]) {
    assert.ok(isPrivateIp(ip), `${ip} private`);
  }
  assert.ok(!isPrivateIp("8.8.8.8"));
  assert.ok(!isPrivateIp("172.32.0.1"), "172.32 is public");
});

test("NET-CIDR policy: no allow list denies all private, allows public", () => {
  assert.equal(decideTargetIp("192.168.1.1", EMPTY).allowed, false);
  assert.equal(decideTargetIp("10.0.0.1", EMPTY).reason, "not_in_allowlist");
  assert.equal(decideTargetIp("8.8.8.8", EMPTY).allowed, true, "public allowed");
  assert.equal(decideTargetIp("127.0.0.1", EMPTY).reason, "sensitive_destination");
});

test("NET-CIDR policy: an allowed CIDR permits its members only", () => {
  const p = allow("192.168.10.0/24");
  assert.equal(decideTargetIp("192.168.10.50", p).allowed, true);
  assert.equal(decideTargetIp("192.168.20.50", p).allowed, false, "outside allowlist");
  // sensitive is denied even if an allow list is broad
  const broad = allow("169.254.0.0/16");
  assert.equal(decideTargetIp("169.254.169.254", broad).reason, "sensitive_destination");
});

test("NET-CIDR policy: deny list overrides an allowed range", () => {
  const p: NetworkDiagnosticPolicy = { allowed: parseCidrList("192.168.0.0/16"), deny: parseCidrList("192.168.99.0/24") };
  assert.equal(decideTargetIp("192.168.1.1", p).allowed, true);
  assert.equal(decideTargetIp("192.168.99.5", p).reason, "denied_range");
});

test("NET-CIDR scan: full containment required, partial overlap rejected", () => {
  const p = allow("192.168.10.0/24");
  assert.equal(decideScanCidr(parseCidr("192.168.10.0/28")!, p).allowed, true, "subnet inside allowed");
  assert.equal(decideScanCidr(parseCidr("192.168.10.0/24")!, p).allowed, true, "exact allowed");
  assert.equal(decideScanCidr(parseCidr("192.168.20.0/24")!, p).allowed, false, "outside allowlist");
  assert.equal(decideScanCidr(parseCidr("192.168.0.0/23")!, p).allowed, false, "broader than allowed = partial overlap");
  assert.equal(decideScanCidr(parseCidr("192.168.10.0/24")!, EMPTY).allowed, false, "no allow list = denied");
});
