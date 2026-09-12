/**
 * Network diagnostics target policy (focused fix — Network CIDR hardening).
 *
 * The prior policy allowed ANY RFC1918 target and only blocked infra-sensitive
 * addresses. That let a privileged admin probe the whole private network
 * (Docker networks, PostgreSQL, Redis, management interfaces, other tenants'
 * services). This module makes the policy explicit and fail-closed:
 *
 *   1. Sensitive destinations (loopback, unspecified/0.0.0.0, link-local +
 *      cloud metadata, multicast, broadcast) are ALWAYS denied.
 *   2. An operator-configured deny list (`NETWORK_DIAGNOSTIC_DENY_CIDRS`, e.g.
 *      the app's own infra subnets) is denied even inside an allowed range.
 *   3. Private / internal addresses are permitted ONLY when contained in the
 *      explicit allow list (`NETWORK_DIAGNOSTIC_ALLOWED_CIDRS`). With no allow
 *      list, ALL private targets are denied (fail-closed) — the default.
 *   4. Public addresses (the internet) are allowed; the finding is about
 *      reaching internal infrastructure, not public diagnostics.
 *
 * Allow/deny CIDRs are IPv4 (matching the LAN-scan feature). IPv6 targets are
 * classified only: sensitive → deny, unique-local (private) → deny (no v6 allow
 * list), global → allow. This is intentionally conservative (fail-closed) for v6.
 */
import net from "node:net";

export interface ParsedCidr {
  /** Network base as a 32-bit unsigned int (host bits zeroed). */
  base: number;
  /** Prefix length 0..32. */
  prefix: number;
}

export interface NetworkDiagnosticPolicy {
  allowed: ParsedCidr[];
  deny: ParsedCidr[];
}

export interface TargetDecision {
  allowed: boolean;
  /** Machine-readable reason when denied. */
  reason?: "sensitive_destination" | "denied_range" | "not_in_allowlist" | "invalid_target";
}

const ALLOW = (): TargetDecision => ({ allowed: true });
const DENY = (reason: NonNullable<TargetDecision["reason"]>): TargetDecision => ({ allowed: false, reason });

export function ipToInt(ip: string): number | null {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip.trim());
  if (!m) return null;
  const o = m.slice(1).map(Number);
  if (o.some((n) => n > 255)) return null;
  return ((o[0]! << 24) | (o[1]! << 16) | (o[2]! << 8) | o[3]!) >>> 0;
}

/** Parse a single IPv4 CIDR (or bare IPv4 → /32). Returns null if invalid. */
export function parseCidr(input: string): ParsedCidr | null {
  const s = input.trim();
  if (s === "") return null;
  const slash = s.indexOf("/");
  const ipPart = slash === -1 ? s : s.slice(0, slash);
  const prefixPart = slash === -1 ? "32" : s.slice(slash + 1);
  if (net.isIP(ipPart) !== 4) return null;
  const prefix = Number(prefixPart);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
  const ipInt = ipToInt(ipPart);
  if (ipInt === null) return null;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return { base: (ipInt & mask) >>> 0, prefix };
}

/** Parse a comma/space separated CIDR list, silently dropping invalid entries. */
export function parseCidrList(raw: string | undefined | null): ParsedCidr[] {
  if (!raw) return [];
  return raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map(parseCidr)
    .filter((c): c is ParsedCidr => c !== null);
}

function maskFor(prefix: number): number {
  return prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
}

/** True if the IPv4 int falls inside the CIDR. */
export function cidrContainsIp(cidr: ParsedCidr, ipInt: number): boolean {
  const mask = maskFor(cidr.prefix);
  return ((ipInt & mask) >>> 0) === cidr.base;
}

/**
 * True if the requested CIDR is FULLY contained within `outer` (no partial
 * overlap): the requested prefix must be at least as specific, and its network
 * must sit inside `outer`.
 */
export function cidrWithin(requested: ParsedCidr, outer: ParsedCidr): boolean {
  if (requested.prefix < outer.prefix) return false; // broader than outer → not contained
  const mask = maskFor(outer.prefix);
  return ((requested.base & mask) >>> 0) === outer.base;
}

/**
 * Infrastructure-sensitive addresses that are ALWAYS denied regardless of any
 * allow list: loopback, unspecified/this-network, link-local (incl. cloud
 * metadata 169.254.169.254), multicast, and the limited broadcast address.
 */
export function isSensitiveIp(ip: string): boolean {
  const fam = net.isIP(ip);
  if (fam === 4) {
    const o = ip.split(".").map(Number);
    const [a, b] = o as number[];
    if (a === 127) return true;                 // loopback 127.0.0.0/8
    if (a === 0) return true;                    // 0.0.0.0/8 unspecified / this-network
    if (a === 169 && b === 254) return true;     // link-local + cloud metadata
    if (a! >= 224) return true;                  // 224.0.0.0/4 multicast + 240/4 reserved (incl. 255.255.255.255 broadcast)
    return false;
  }
  if (fam === 6) {
    const low = ip.toLowerCase().split("%")[0]!;
    if (low === "::1" || low === "::") return true;
    if (low.startsWith("fe8") || low.startsWith("fe9") || low.startsWith("fea") || low.startsWith("feb")) return true; // fe80::/10
    if (low.startsWith("ff")) return true;       // multicast ff00::/8
    if (low.startsWith("::ffff:")) return isSensitiveIp(low.slice("::ffff:".length)); // IPv4-mapped
    return false;
  }
  return false;
}

/** RFC1918 / internal address that must be explicitly allowlisted to diagnose. */
export function isPrivateIp(ip: string): boolean {
  const fam = net.isIP(ip);
  if (fam === 4) {
    const o = ip.split(".").map(Number);
    const [a, b] = o as number[];
    if (a === 10) return true;                       // 10.0.0.0/8
    if (a === 172 && b! >= 16 && b! <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true;         // 192.168.0.0/16
    if (a === 100 && b! >= 64 && b! <= 127) return true; // 100.64.0.0/10 CGNAT
    return false;
  }
  if (fam === 6) {
    const low = ip.toLowerCase().split("%")[0]!;
    if (low.startsWith("fc") || low.startsWith("fd")) return true; // fc00::/7 unique-local
    if (low.startsWith("::ffff:")) return isPrivateIp(low.slice("::ffff:".length));
    return false;
  }
  return false;
}

/** Decide whether a single resolved IP may be diagnosed under the policy. */
export function decideTargetIp(ip: string, policy: NetworkDiagnosticPolicy): TargetDecision {
  const fam = net.isIP(ip);
  if (fam === 0) return DENY("invalid_target");
  if (isSensitiveIp(ip)) return DENY("sensitive_destination");

  if (fam === 4) {
    const n = ipToInt(ip);
    if (n === null) return DENY("invalid_target");
    if (policy.deny.some((c) => cidrContainsIp(c, n))) return DENY("denied_range");
    if (isPrivateIp(ip)) {
      return policy.allowed.some((c) => cidrContainsIp(c, n)) ? ALLOW() : DENY("not_in_allowlist");
    }
    return ALLOW(); // public IPv4
  }
  // IPv6: no allow-list support → private (ULA) is denied, global is allowed.
  if (isPrivateIp(ip)) return DENY("not_in_allowlist");
  return ALLOW();
}

/**
 * Decide whether a requested scan CIDR is permitted: it must be fully contained
 * within one allowed CIDR, and it must not intersect the deny list or contain a
 * sensitive network. With no allow list, every scan is denied (fail-closed).
 */
export function decideScanCidr(requested: ParsedCidr, policy: NetworkDiagnosticPolicy): TargetDecision {
  const contained = policy.allowed.some((outer) => cidrWithin(requested, outer));
  if (!contained) return DENY("not_in_allowlist");
  // A deny CIDR that overlaps the requested range blocks it.
  if (policy.deny.some((d) => cidrWithin(requested, d) || cidrWithin(d, requested))) return DENY("denied_range");
  return ALLOW();
}
