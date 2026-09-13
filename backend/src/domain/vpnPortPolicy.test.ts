/**
 * Multi-VPN-Server port/subnet policy — unit tests.
 * VPN-PORT-POLICY-001..010 (range/reserved/proto) + VPN-SUBNET-001..008 (overlap).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  makeVpnPortPolicy, assertPortAllowed, assertProto, assertNoSubnetOverlap,
  assertSubnetValid, cidrsOverlap, parseCidr4, nextFreePort, VpnPortErrors,
} from "./vpnPortPolicy.js";

const POLICY = makeVpnPortPolicy({ min: 20000, max: 30000, reserved: [22, 80, 443, 8081, 5432, 6379] });
/** assert.throws matcher on DomainError.code. */
const code = (c: string) => (e: unknown) => (e as { code?: string })?.code === c;

test("makeVpnPortPolicy fails closed on an invalid range", () => {
  assert.throws(() => makeVpnPortPolicy({ min: 0, max: 30000 }), /invalid VPN port range/);
  assert.throws(() => makeVpnPortPolicy({ min: 30000, max: 20000 }), /invalid VPN port range/);
  assert.throws(() => makeVpnPortPolicy({ min: 1, max: 70000 }), /invalid VPN port range/);
});

test("VPN-PORT-POLICY-001: a port inside the range is allowed", () => {
  assert.doesNotThrow(() => assertPortAllowed(20001, POLICY));
  assert.doesNotThrow(() => assertPortAllowed(30000, POLICY));
});
test("VPN-PORT-POLICY-002: below range rejected", () => { assert.throws(() => assertPortAllowed(19999, POLICY), code("vpn_port_out_of_range")); });
test("VPN-PORT-POLICY-003: above range rejected", () => { assert.throws(() => assertPortAllowed(30001, POLICY), code("vpn_port_out_of_range")); });
test("VPN-PORT-POLICY-004: reserved 22 rejected", () => { assert.throws(() => assertPortAllowed(22, POLICY), code("vpn_port_out_of_range")); });
test("VPN-PORT-POLICY-005: reserved 443 rejected", () => { assert.throws(() => assertPortAllowed(443, POLICY), code("vpn_port_out_of_range")); });
test("VPN-PORT-POLICY-006: reserved 8081 (backend) rejected even if numerically in range", () => {
  const p = makeVpnPortPolicy({ min: 1, max: 65535, reserved: [8081] });
  assert.throws(() => assertPortAllowed(8081, p), code("vpn_port_reserved"));
});
test("VPN-PORT-POLICY-007: PostgreSQL port rejected", () => {
  const p = makeVpnPortPolicy({ min: 1, max: 65535, reserved: [5432] });
  assert.throws(() => assertPortAllowed(5432, p), code("vpn_port_reserved"));
});
test("VPN-PORT-POLICY-008: Redis port rejected", () => {
  const p = makeVpnPortPolicy({ min: 1, max: 65535, reserved: [6379] });
  assert.throws(() => assertPortAllowed(6379, p), code("vpn_port_reserved"));
});
test("VPN-PORT-POLICY-009: proto must be udp/tcp", () => {
  assert.doesNotThrow(() => assertProto("udp"));
  assert.doesNotThrow(() => assertProto("tcp"));
  assert.throws(() => assertProto("sctp"), code("vpn_bad_proto"));
});
test("VPN-PORT-POLICY-010: nextFreePort skips used + reserved", () => {
  const p = makeVpnPortPolicy({ min: 20000, max: 20003, reserved: [20001] });
  assert.equal(nextFreePort([20000], p), 20002); // 20001 reserved, 20000 used → 20002
  assert.equal(nextFreePort([20000, 20002, 20003], p), null); // all used/reserved
});

test("VPN-SUBNET-001: identical subnets overlap", () => {
  assert.ok(cidrsOverlap(parseCidr4("10.8.1.0/24")!, parseCidr4("10.8.1.0/24")!));
});
test("VPN-SUBNET-002: /24 vs contained /25 overlap", () => {
  assert.ok(cidrsOverlap(parseCidr4("10.8.1.0/24")!, parseCidr4("10.8.1.128/25")!));
});
test("VPN-SUBNET-003: adjacent distinct /24s do not overlap", () => {
  assert.ok(!cidrsOverlap(parseCidr4("10.8.1.0/24")!, parseCidr4("10.8.2.0/24")!));
});
test("VPN-SUBNET-004: supernet vs subnet overlap (both directions)", () => {
  assert.ok(cidrsOverlap(parseCidr4("10.8.0.0/16")!, parseCidr4("10.8.5.0/24")!));
  assert.ok(cidrsOverlap(parseCidr4("10.8.5.0/24")!, parseCidr4("10.8.0.0/16")!));
});
test("VPN-SUBNET-005: assertNoSubnetOverlap accepts a non-overlapping subnet", () => {
  assert.doesNotThrow(() => assertNoSubnetOverlap("10.8.3.0/24", ["10.8.1.0/24", "10.8.2.0/24"]));
});
test("VPN-SUBNET-006: assertNoSubnetOverlap rejects an overlapping subnet", () => {
  assert.throws(() => assertNoSubnetOverlap("10.8.1.128/25", ["10.8.1.0/24"]), code("vpn_subnet_overlap"));
});
test("VPN-SUBNET-007: invalid CIDR rejected", () => {
  assert.throws(() => assertSubnetValid("10.8.1.0"), code("vpn_bad_subnet"));
  assert.throws(() => assertSubnetValid("999.0.0.0/24"), code("vpn_bad_subnet"));
});
test("VPN-SUBNET-008: reserved error type is a DomainError with code", () => {
  const e = VpnPortErrors.InUse();
  assert.equal((e as { code: string }).code, "vpn_port_in_use");
});
