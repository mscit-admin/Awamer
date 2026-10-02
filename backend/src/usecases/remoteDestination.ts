/**
 * SEC-REMOTE-DEST-001 — destination policy for remote sessions (SSH, SFTP,
 * Telnet, VNC and the SSH hop of tunnels).
 *
 * Reaching private / internal infrastructure (RFC1918, ULA, CGNAT, public) is
 * the PRODUCT'S PURPOSE and stays allowed. What is never a legitimate managed
 * target — and is dangerous because the connection originates INSIDE the
 * backend — is denied:
 *   - link-local incl. cloud metadata (169.254.0.0/16, fe80::/10)
 *   - unspecified / this-network (0.0.0.0/8, ::), multicast / reserved
 *   - loopback (127.0.0.0/8, ::1): the backend's own host/container, unless the
 *     operator opts in with REMOTE_SESSION_ALLOW_LOOPBACK=true
 *   - any operator-supplied REMOTE_SESSION_DENY_CIDRS
 *   - with REMOTE_SESSION_DENY_LOCAL_SUBNETS=true, the IPv4 subnets the backend
 *     itself is attached to. In the Docker deployment that is ONLY the internal
 *     network holding PostgreSQL/Redis (whose subnet Docker assigns
 *     dynamically), so "postgres:5432" cannot be targeted by a Telnet/VNC relay.
 *     Off by default: on a bare-metal install it would block the server's LAN.
 * Telnet/VNC are raw TCP relays, so without this a standard user could reach
 * e.g. 169.254.169.254 and replay crafted HTTP to steal cloud credentials.
 *
 * The name is resolved ONCE here and callers connect to the returned IP, so a
 * DNS answer cannot change between the check and the connect (rebinding).
 * Encoded forms (2130706433, 0x7f.1, ::ffff:127.0.0.1) are normalised by the
 * resolver before the check.
 */
import { lookup } from "node:dns/promises";
import net from "node:net";
import os from "node:os";
import { isSensitiveIp, ipToInt, parseCidrList, cidrContainsIp, type ParsedCidr } from "./networkPolicy.js";

export interface RemoteDestinationPolicy {
  allowLoopback: boolean;
  deny: ParsedCidr[];
}

let policy: RemoteDestinationPolicy = { allowLoopback: false, deny: [] };

/** Install the policy (server startup; integration tests opt in to loopback). */
export function configureRemoteDestinationPolicy(p: {
  allowLoopback?: boolean; denyCidrs?: string | null; denyLocalSubnets?: boolean;
}): void {
  const deny = parseCidrList(p.denyCidrs ?? null);
  if (p.denyLocalSubnets) deny.push(...parseCidrList(localIpv4Subnets().join(",")));
  policy = { allowLoopback: p.allowLoopback === true, deny };
}

/** IPv4 CIDRs of this host's non-loopback interfaces (e.g. the Docker network). */
export function localIpv4Subnets(): string[] {
  const out: string[] = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal && a.cidr) out.push(a.cidr);
    }
  }
  return out;
}

export class RemoteDestinationDenied extends Error {
  readonly code = "destination_denied";
  constructor(readonly reason: string) {
    super("this destination is not allowed for remote sessions");
    this.name = "RemoteDestinationDenied";
  }
}

function isLoopback(ip: string): boolean {
  if (net.isIP(ip) === 4) return ip.startsWith("127.");
  const low = ip.toLowerCase();
  return low === "::1" || (low.startsWith("::ffff:") && low.slice(7).startsWith("127."));
}

/** Pure decision for one resolved address (exported for tests). */
export function decideRemoteIp(ip: string, p: RemoteDestinationPolicy = policy): string | null {
  if (net.isIP(ip) === 0) return "invalid_destination";
  if (isLoopback(ip)) return p.allowLoopback ? null : "loopback";
  if (isSensitiveIp(ip)) return "sensitive_destination";
  const v4 = ip.toLowerCase().startsWith("::ffff:") ? ip.slice(7) : ip;
  const n = net.isIP(v4) === 4 ? ipToInt(v4) : null;
  if (n !== null && p.deny.some((c) => cidrContainsIp(c, n))) return "denied_range";
  return null;
}

/**
 * Resolve `hostname` and return the IP to connect to, or throw
 * RemoteDestinationDenied. EVERY resolved address must pass (a name that
 * resolves to both a public and a loopback address is refused).
 */
export async function resolveRemoteDestination(
  hostname: string,
  resolver: (h: string) => Promise<{ address: string }[]> = (h) => lookup(h, { all: true, verbatim: true }),
): Promise<string> {
  const h = hostname.trim().replace(/^\[(.*)\]$/, "$1");
  if (!h) throw new RemoteDestinationDenied("invalid_destination");
  let addrs: string[];
  if (net.isIP(h)) addrs = [h];
  else {
    try { addrs = (await resolver(h)).map((a) => a.address); }
    catch { throw new RemoteDestinationDenied("unresolvable"); }
  }
  if (addrs.length === 0) throw new RemoteDestinationDenied("unresolvable");
  for (const a of addrs) {
    const reason = decideRemoteIp(a);
    if (reason) throw new RemoteDestinationDenied(reason);
  }
  return addrs[0]!;
}
