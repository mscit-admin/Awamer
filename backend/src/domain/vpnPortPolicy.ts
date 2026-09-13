/**
 * Multi-VPN-Server dynamic-port policy (centralized).
 *
 * Each VPN Server owns its own port + protocol + subnet (the DB record is the
 * source of truth — there is NO deployment-wide single OPENVPN_SERVER_PORT).
 * This module is the ONE place that decides whether a (port, proto) and a subnet
 * are acceptable, so the same rules apply in the API, the repository, and the
 * privileged firewall helper (no duplicated lists). Pure + unit-testable.
 */
import { DomainError } from "./index.js";

export type VpnProto = "udp" | "tcp";

export interface VpnPortPolicy {
  /** Inclusive assignable range for VPN Server data ports. */
  min: number;
  max: number;
  /** Infrastructure/application ports that a VPN Server may never use. */
  reserved: ReadonlySet<number>;
}

export const VpnPortErrors = {
  OutOfRange: (min: number, max: number) =>
    new DomainError("vpn_port_out_of_range", `VPN server port must be within ${min}-${max}`),
  Reserved: (port: number) =>
    new DomainError("vpn_port_reserved", `port ${port} is reserved by system/infrastructure`),
  BadProto: () => new DomainError("vpn_bad_proto", "protocol must be udp or tcp"),
  InUse: () => new DomainError("vpn_port_in_use", "that port/protocol is already assigned to another VPN server"),
  BadSubnet: () => new DomainError("vpn_bad_subnet", "subnet must be valid IPv4 CIDR, e.g. 10.8.1.0/24"),
  SubnetOverlap: () => new DomainError("vpn_subnet_overlap", "subnet overlaps another VPN server's subnet"),
  NoFreePort: () => new DomainError("vpn_no_free_port", "no free port available in the configured VPN port range"),
} as const;

/** Build the effective policy. Fails closed on an invalid range (1<=min<=max<=65535). */
export function makeVpnPortPolicy(input: { min: number; max: number; reserved?: Iterable<number> }): VpnPortPolicy {
  const { min, max } = input;
  if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max > 65535 || min > max) {
    throw new Error(`invalid VPN port range: min=${min} max=${max} (require 1<=min<=max<=65535)`);
  }
  const reserved = new Set<number>();
  for (const p of input.reserved ?? []) if (Number.isInteger(p) && p >= 1 && p <= 65535) reserved.add(p);
  return { min, max, reserved };
}

/** Validate a requested port against range + reserved list. Throws on violation. */
export function assertPortAllowed(port: number, policy: VpnPortPolicy): void {
  if (!Number.isInteger(port) || port < policy.min || port > policy.max) {
    throw VpnPortErrors.OutOfRange(policy.min, policy.max);
  }
  if (policy.reserved.has(port)) throw VpnPortErrors.Reserved(port);
}

export function assertProto(proto: string): asserts proto is VpnProto {
  if (proto !== "udp" && proto !== "tcp") throw VpnPortErrors.BadProto();
}

// ---- IPv4 CIDR helpers (subnet overlap) --------------------------------

export interface Cidr4 { base: number; prefix: number; }

export function parseCidr4(cidr: string): Cidr4 | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(String(cidr).trim());
  if (!m) return null;
  const o = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  const prefix = Number(m[5]);
  if (o.some((n) => n > 255) || prefix < 0 || prefix > 32) return null;
  const ip = ((o[0]! << 24) | (o[1]! << 16) | (o[2]! << 8) | o[3]!) >>> 0;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return { base: (ip & mask) >>> 0, prefix };
}

/** True if two IPv4 CIDRs share any address (their ranges intersect). */
export function cidrsOverlap(a: Cidr4, b: Cidr4): boolean {
  const aEnd = (a.base + 2 ** (32 - a.prefix) - 1) >>> 0;
  const bEnd = (b.base + 2 ** (32 - b.prefix) - 1) >>> 0;
  return a.base <= bEnd && b.base <= aEnd;
}

export function assertSubnetValid(subnet: string): Cidr4 {
  const c = parseCidr4(subnet);
  if (!c) throw VpnPortErrors.BadSubnet();
  return c;
}

/** Throw if `subnet` overlaps any of the existing subnets. */
export function assertNoSubnetOverlap(subnet: string, existing: Iterable<string>): void {
  const c = assertSubnetValid(subnet);
  for (const other of existing) {
    const o = parseCidr4(other);
    if (o && cidrsOverlap(c, o)) throw VpnPortErrors.SubnetOverlap();
  }
}

/**
 * Pick the lowest free port in the range for a protocol given the ports already
 * taken (for that protocol) and the reserved set. Returns null if none free.
 */
export function nextFreePort(taken: Iterable<number>, policy: VpnPortPolicy): number | null {
  const used = new Set<number>(taken);
  for (let p = policy.min; p <= policy.max; p++) {
    if (!used.has(p) && !policy.reserved.has(p)) return p;
  }
  return null;
}
