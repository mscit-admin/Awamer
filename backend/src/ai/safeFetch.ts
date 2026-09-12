/**
 * SEC-SSRF-001 — SSRF-safe outbound HTTP client for user-configured AI providers.
 *
 * Defends the server's network position against custom provider base URLs by:
 *   - protocol allowlist (https; http only in explicit dev/test);
 *   - DNS resolution + validation of EVERY candidate address (blocks loopback,
 *     private, link-local, cloud-metadata, CGNAT, reserved, multicast, and
 *     IPv4-mapped IPv6);
 *   - pinning the TCP connection to the validated IP (rebinding-safe) while
 *     preserving the Host header + TLS SNI for the original hostname;
 *   - manual redirect handling with per-hop revalidation and a hop cap;
 *   - connect/response timeouts and a response-size limit.
 *
 * Implemented on node:http/https with a custom socket `lookup` that is the
 * SINGLE resolution point — the address it validates is the exact address it
 * connects to, closing the TOCTOU/rebinding gap a validate-then-fetch leaves open.
 */
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { promises as dns } from "node:dns";
import type { LookupFunction } from "node:net";

export class SsrfError extends Error {
  constructor(message: string) { super(message); this.name = "SsrfError"; }
}

export interface SafeFetchPolicy {
  allowHttp?: boolean;          // default false (https only)
  /**
   * Permit loopback (127.0.0.0/8, ::1) ONLY. Off by default. Enable for an
   * explicit local-dev AI endpoint (e.g. a localhost Ollama). Never enables
   * any other private/link-local/metadata range.
   */
  allowLoopback?: boolean;      // default false
  maxRedirects?: number;        // default 3
  connectTimeoutMs?: number;    // default 5000
  requestTimeoutMs?: number;    // default 20000
  maxResponseBytes?: number;    // default 5 MiB
}

const DEFAULTS: Required<SafeFetchPolicy> = {
  allowHttp: false,
  allowLoopback: false,
  maxRedirects: 3,
  connectTimeoutMs: 5_000,
  requestTimeoutMs: 20_000,
  maxResponseBytes: 5 * 1024 * 1024,
};

// ---- IP validation --------------------------------------------------------

function ipv4Blocked(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
  const [a, b] = p as [number, number, number, number];
  if (a === 0) return true;                         // 0.0.0.0/8 "this network"
  if (a === 10) return true;                        // private
  if (a === 127) return true;                       // loopback
  if (a === 169 && b === 254) return true;          // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true;          // private
  if (a === 100 && b >= 64 && b <= 127) return true;// CGNAT
  if (a === 192 && b === 0) return true;            // 192.0.0/24 + 192.0.2/24 (test)
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51) return true;           // 198.51.100/24 (test)
  if (a === 203 && b === 0) return true;            // 203.0.113/24 (test)
  if (a >= 224) return true;                        // 224/4 multicast + 240/4 reserved + 255.*
  return false;
}

function expandIpv6(ip: string): number[] | null {
  // returns 8 hextets as numbers, or null if unparseable
  let s = ip;
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  // handle embedded IPv4 tail
  let v4tail: number[] | null = null;
  const lastColon = s.lastIndexOf(":");
  const tail = s.slice(lastColon + 1);
  if (tail.includes(".")) {
    const q = tail.split(".").map(Number);
    if (q.length === 4 && q.every((n) => n >= 0 && n <= 255)) {
      v4tail = q as number[];
      s = s.slice(0, lastColon + 1) + ((q[0]! << 8) | q[1]!).toString(16) + ":" + ((q[2]! << 8) | q[3]!).toString(16);
    }
  }
  const parts = s.split("::");
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(":") : [];
  const tailArr = parts.length === 2 && parts[1] ? parts[1].split(":") : [];
  const missing = 8 - (head.length + tailArr.length);
  if (parts.length === 1 && head.length !== 8) return null;
  if (parts.length === 2 && missing < 0) return null;
  const middle = parts.length === 2 ? new Array(missing).fill("0") : [];
  const all = [...head, ...middle, ...tailArr];
  if (all.length !== 8) return null;
  const nums = all.map((h) => (h === "" ? 0 : parseInt(h, 16)));
  if (nums.some((n) => Number.isNaN(n) || n < 0 || n > 0xffff)) return null;
  void v4tail;
  return nums;
}

function ipv6Blocked(ip: string): boolean {
  const h = expandIpv6(ip);
  if (!h) return true;
  const [h0, h1] = h as number[];
  // ::/128 unspecified and ::1 loopback (all-zero except last =1)
  if (h.slice(0, 7).every((x) => x === 0) && (h[7] === 0 || h[7] === 1)) return true;
  if ((h0! & 0xfe00) === 0xfc00) return true;   // fc00::/7 unique-local
  if ((h0! & 0xffc0) === 0xfe80) return true;   // fe80::/10 link-local
  if ((h0! & 0xff00) === 0xff00) return true;   // ff00::/8 multicast
  if (h0 === 0x2001 && h1 === 0x0db8) return true; // 2001:db8::/32 documentation
  // IPv4-mapped ::ffff:a.b.c.d  → validate the embedded v4
  if (h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff) {
    const a = (h[6]! >> 8) & 0xff, b = h[6]! & 0xff, c = (h[7]! >> 8) & 0xff, d = h[7]! & 0xff;
    return ipv4Blocked(`${a}.${b}.${c}.${d}`);
  }
  return false;
}

function isLoopback(ip: string): boolean {
  const fam = isIP(ip);
  if (fam === 4) return ip.split(".")[0] === "127";
  if (fam === 6) {
    const h = expandIpv6(ip);
    return !!h && h.slice(0, 7).every((x) => x === 0) && h[7] === 1;
  }
  return false;
}

/** True if the literal IP must not be connected to (SSRF-unsafe). */
export function isBlockedIp(ip: string, opts: { allowLoopback?: boolean } = {}): boolean {
  if (opts.allowLoopback && isLoopback(ip)) return false;
  const fam = isIP(ip);
  if (fam === 4) return ipv4Blocked(ip);
  if (fam === 6) return ipv6Blocked(ip);
  return true; // not a literal IP → cannot validate → block
}

/** Validate a URL's protocol + host shape (no connection yet). */
export function assertSafeUrl(raw: string, allowHttp: boolean, allowLoopback = false): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new SsrfError("invalid URL"); }
  const scheme = u.protocol.toLowerCase();
  if (scheme === "https:") { /* ok */ }
  else if (scheme === "http:") { if (!allowHttp) throw new SsrfError("http:// is not allowed"); }
  else throw new SsrfError(`protocol not allowed: ${scheme}`);
  if (u.username || u.password) throw new SsrfError("embedded credentials are not allowed");
  if (!u.hostname) throw new SsrfError("missing host");
  // If the host is a literal IP, validate it immediately.
  if (isIP(u.hostname) && isBlockedIp(u.hostname, { allowLoopback })) throw new SsrfError("destination IP is not permitted");
  return u;
}

// A pinning `lookup` (node:net signature): resolve the hostname, validate ALL
// returned addresses, and connect to a validated one. This is the single
// resolution point, so the connected socket goes to the validated IP
// (rebinding-safe). TLS SNI / Host still use the original hostname.
function makePinnedLookup(allowLoopback: boolean): LookupFunction {
  return (hostname, _opts, cb): void => {
    const lit = isIP(hostname);
    if (lit) {
      if (isBlockedIp(hostname, { allowLoopback })) return cb(new SsrfError("destination IP is not permitted") as NodeJS.ErrnoException, "", lit);
      return cb(null, hostname, lit);
    }
    dns.lookup(hostname, { all: true, verbatim: true }).then((addrs) => {
      if (!addrs.length) return cb(new SsrfError("host did not resolve") as NodeJS.ErrnoException, "", 0);
      // Reject if ANY resolved address is unsafe (defends against split-horizon).
      for (const a of addrs) if (isBlockedIp(a.address, { allowLoopback })) return cb(new SsrfError("host resolves to a non-permitted address") as NodeJS.ErrnoException, "", 0);
      const chosen = addrs[0]!;
      cb(null, chosen.address, chosen.family);
    }).catch((e) => cb((e instanceof Error ? e : new SsrfError("dns lookup failed")) as NodeJS.ErrnoException, "", 0));
  };
}

export interface SafeResponse {
  status: number;
  ok: boolean;
  text(): string;
  json(): unknown;
}

export interface SafeFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

interface RawResponse { status: number; location?: string; body: Buffer; }

function once(url: URL, init: SafeFetchInit, p: Required<SafeFetchPolicy>): Promise<RawResponse> {
  return new Promise<RawResponse>((resolve, reject) => {
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.request(url, {
      method: init.method ?? "GET",
      headers: init.headers,
      lookup: makePinnedLookup(p.allowLoopback), // single, validated resolution point
      timeout: p.connectTimeoutMs,
    }, (res) => {
      const chunks: Buffer[] = [];
      let total = 0;
      res.on("data", (c: Buffer) => {
        total += c.length;
        if (total > p.maxResponseBytes) {
          req.destroy(new SsrfError("response exceeded maximum size"));
          res.destroy();
          return;
        }
        chunks.push(c);
      });
      res.on("end", () => resolve({
        status: res.statusCode ?? 0,
        location: res.headers.location,
        body: Buffer.concat(chunks),
      }));
      res.on("error", reject);
    });
    // Overall request deadline.
    req.setTimeout(p.requestTimeoutMs, () => req.destroy(new SsrfError("request timed out")));
    req.on("error", reject);
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}

/** SSRF-safe request with manual, revalidated redirects. */
export async function safeFetch(rawUrl: string, init: SafeFetchInit = {}, policy: SafeFetchPolicy = {}): Promise<SafeResponse> {
  const p = { ...DEFAULTS, ...policy };
  let url = assertSafeUrl(rawUrl, p.allowHttp, p.allowLoopback);
  let method = init.method ?? "GET";
  let body: string | undefined = init.body;
  let headers: Record<string, string> = { ...(init.headers ?? {}) };

  for (let hop = 0; hop <= p.maxRedirects; hop++) {
    const res = await once(url, { method, headers, body }, p);
    if (res.status >= 300 && res.status < 400 && res.location) {
      if (hop === p.maxRedirects) throw new SsrfError("too many redirects");
      url = assertSafeUrl(new URL(res.location, url).toString(), p.allowHttp, p.allowLoopback); // revalidate each hop
      // RFC 7231: 303 (and commonly 301/302 for POST) → GET without body.
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method !== "GET" && method !== "HEAD")) {
        method = "GET"; body = undefined; delete headers["content-type"]; delete headers["content-length"];
      }
      continue;
    }
    const text = res.body.toString("utf8");
    return {
      status: res.status,
      ok: res.status >= 200 && res.status < 300,
      text: () => text,
      json: () => JSON.parse(text),
    };
  }
  throw new SsrfError("too many redirects");
}
