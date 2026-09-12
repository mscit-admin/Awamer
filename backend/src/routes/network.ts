/**
 * Network diagnostics (Phase: Network tools).
 *
 * Small, safe toolbox: ping, traceroute, TCP port check, DNS lookup. Gated by
 * the `sessions:connect` permission (if you may open sessions, you may probe).
 *
 * Safety:
 *  - External binaries are run via spawn with an ARGUMENT ARRAY (never a
 *    shell), so no command injection is possible.
 *  - The target is still validated to a hostname/IP charset and length.
 *  - Each command is time- and output-bounded.
 */
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { spawn } from "node:child_process";
import net from "node:net";
import dns from "node:dns/promises";
import { makeAuthMiddleware, requirePermission } from "../middleware/auth.js";
import type { JwtService } from "../jwt/index.js";
import type { AuditRepository } from "../repos/otherRepos.js";

interface Deps {
  jwt: JwtService;
  users: import("../repos/userRepo.js").UserRepository;
  audit: AuditRepository;
}

const HOST_RE = /^[a-zA-Z0-9._-]+$/;
const hostSchema = z.string().min(1).max(253).regex(HOST_RE, "invalid host");

const MAX_OUTPUT = 64 * 1024;

// SEC-NET-001: block infrastructure-sensitive diagnostic targets by default.
// Loopback, unspecified, link-local (incl. cloud metadata 169.254.169.254),
// and multicast/reserved are refused; general RFC1918 LAN stays allowed because
// LAN diagnostics is the tool's legitimate purpose.
function isInfraSensitiveIp(ip: string): boolean {
  const fam = net.isIP(ip);
  if (fam === 4) {
    const o = ip.split(".").map(Number);
    const [a, b] = o as number[];
    if (a === 127) return true;               // loopback
    if (a === 0) return true;                  // unspecified / this-network
    if (a === 169 && b === 254) return true;   // link-local + cloud metadata
    if (a! >= 224) return true;                // multicast + reserved
    return false;
  }
  if (fam === 6) {
    const low = ip.toLowerCase().split("%")[0]!;
    if (low === "::1" || low === "::") return true;
    if (low.startsWith("fe8") || low.startsWith("fe9") || low.startsWith("fea") || low.startsWith("feb")) return true; // fe80::/10
    if (low.startsWith("ff")) return true;     // multicast
    if (low.startsWith("::ffff:")) return isInfraSensitiveIp(low.slice("::ffff:".length)); // mapped v4
    return false;
  }
  return false;
}

/** Throws { code } if the host (literal or resolved) is infra-sensitive. */
async function assertDiagnosableTarget(host: string): Promise<void> {
  if (net.isIP(host)) {
    if (isInfraSensitiveIp(host)) throw { code: "target_not_allowed" as const };
    return;
  }
  let addrs: string[] = [];
  try { addrs = (await dns.lookup(host, { all: true })).map((a) => a.address); } catch { return; }
  for (const a of addrs) if (isInfraSensitiveIp(a)) throw { code: "target_not_allowed" as const };
}

// SEC-NET-001 §34: simple per-user request-frequency limit (per instance).
const RL_MAX = 40;          // requests
const RL_WINDOW_MS = 60_000; // per minute
const rlBuckets = new Map<string, number[]>();
function rateLimited(userId: string): boolean {
  const now = Date.now();
  const arr = (rlBuckets.get(userId) ?? []).filter((t) => now - t < RL_WINDOW_MS);
  if (arr.length >= RL_MAX) { rlBuckets.set(userId, arr); return true; }
  arr.push(now); rlBuckets.set(userId, arr);
  return false;
}

// ----- LAN discovery helpers ----------------------------------------
const DEFAULT_SCAN_PORTS = [22, 80, 443, 445, 3389, 5900, 8080];
const MAX_SCAN_HOSTS = 256;

function ipToInt(ip: string): number | null {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  if (o.some((n) => n > 255)) return null;
  return ((o[0]! << 24) | (o[1]! << 16) | (o[2]! << 8) | o[3]!) >>> 0;
}
function intToIp(n: number): string {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

/** Expand an IPv4 CIDR (prefix ≥ /24) into its usable host addresses. */
function expandCidr(cidr: string): string[] | { error: string } {
  const m = /^(\d+\.\d+\.\d+\.\d+)\/(\d+)$/.exec(cidr.trim());
  if (!m) return { error: "use CIDR notation, e.g. 192.168.1.0/24" };
  const base = ipToInt(m[1]!);
  const prefix = Number(m[2]);
  if (base === null || prefix < 24 || prefix > 32) {
    return { error: "prefix must be between /24 and /32" };
  }
  const size = 2 ** (32 - prefix);
  if (size > MAX_SCAN_HOSTS) return { error: "range too large (max /24 = 256 addresses)" };
  const network = base & (size === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0);
  const ips: string[] = [];
  for (let i = 0; i < size; i++) {
    // Skip network & broadcast for /24..../30; keep both for /31,/32.
    if (size >= 4 && (i === 0 || i === size - 1)) continue;
    ips.push(intToIp((network + i) >>> 0));
  }
  return ips;
}

/** Probe one host across a few TCP ports; "up" if anything responds. */
async function probeHost(ip: string, ports: number[], timeoutMs: number): Promise<{ ip: string; open: number[]; up: boolean; hostname: string | null } | null> {
  let up = false;
  const open: number[] = [];
  await Promise.all(
    ports.map(
      (port) =>
        new Promise<void>((resolve) => {
          const sock = new net.Socket();
          let done = false;
          const fin = () => { if (done) return; done = true; sock.destroy(); resolve(); };
          sock.setTimeout(timeoutMs);
          sock.once("connect", () => { up = true; open.push(port); fin(); });
          sock.once("timeout", fin);
          sock.once("error", (e: NodeJS.ErrnoException) => {
            // A refusal/reset means the host is alive (port just closed).
            if (e.code === "ECONNREFUSED" || e.code === "ECONNRESET") up = true;
            fin();
          });
          sock.connect(port, ip);
        }),
    ),
  );
  if (!up) return null;
  let hostname: string | null = null;
  try { const names = await dns.reverse(ip); hostname = names[0] ?? null; } catch { /* none */ }
  return { ip, open: open.sort((a, b) => a - b), up, hostname };
}

/** Run probes with a bounded concurrency pool. */
async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]!);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Run a binary with arg array (no shell), bounded by time and output size. */
function runCommand(cmd: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; output: string; error?: string }> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      return resolve({ ok: false, output: "", error: `${cmd} is not available on the server` });
    }
    let out = "";
    let killed = false;
    const timer = setTimeout(() => { killed = true; child.kill("SIGKILL"); }, timeoutMs);

    const onData = (d: Buffer) => {
      if (out.length < MAX_OUTPUT) out += d.toString("utf8");
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);

    child.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (e.code === "ENOENT") return resolve({ ok: false, output: "", error: `${cmd} is not installed on the server` });
      resolve({ ok: false, output: out, error: e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (killed) return resolve({ ok: false, output: out.slice(0, MAX_OUTPUT), error: "timed out" });
      resolve({ ok: code === 0, output: out.slice(0, MAX_OUTPUT) });
    });
  });
}

export function makeNetworkRoutes(deps: Deps): FastifyPluginAsync {
  return async function (app: FastifyInstance) {
    app.addHook("preHandler", makeAuthMiddleware(deps.jwt, deps.users));
    // SEC-NET-001: dedicated permission (Super Admin + Admin), NOT the broad
    // sessions:connect that every standard user holds.
    app.addHook("preHandler", requirePermission("network:diagnose"));
    // SEC-NET-001 §34: per-user rate limit across all diagnostic endpoints.
    app.addHook("preHandler", async (req, reply) => {
      if (rateLimited(req.auth!.sub)) {
        return reply.code(429).send({ error: { code: "rate_limited", message: "too many diagnostic requests; slow down" } });
      }
    });

    const audit = (req: import("fastify").FastifyRequest, op: string, target: string, ok: boolean) =>
      deps.audit.log({
        userId: req.auth!.sub, action: "network_diagnose", success: ok,
        ipAddress: req.ip, resourceType: "network", resourceId: op, details: { op, target },
      });
    // Guard a per-host op: reject infra-sensitive targets (audited).
    const guardHost = async (req: import("fastify").FastifyRequest, reply: import("fastify").FastifyReply, op: string, host: string): Promise<boolean> => {
      try {
        await assertDiagnosableTarget(host);
        return true;
      } catch {
        await audit(req, op, host, false);
        reply.code(403).send({ error: { code: "target_not_allowed", message: "that target is not permitted for diagnostics" } });
        return false;
      }
    };

    // ---- ping ---------------------------------------------------------
    app.post("/ping", async (req, reply) => {
      const parsed = z.object({ host: hostSchema }).safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: { code: "validation_failed", message: parsed.error.message } });
      if (!(await guardHost(req, reply, "ping", parsed.data.host))) return;
      const r = await runCommand("ping", ["-c", "4", "-w", "10", parsed.data.host], 12_000);
      await audit(req, "ping", parsed.data.host, r.ok);
      return reply.send(r);
    });

    // ---- traceroute ---------------------------------------------------
    app.post("/traceroute", async (req, reply) => {
      const parsed = z.object({ host: hostSchema }).safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: { code: "validation_failed", message: parsed.error.message } });
      if (!(await guardHost(req, reply, "traceroute", parsed.data.host))) return;
      const r = await runCommand("traceroute", ["-m", "20", "-w", "2", "-q", "1", parsed.data.host], 30_000);
      await audit(req, "traceroute", parsed.data.host, r.ok);
      return reply.send(r);
    });

    // ---- DNS lookup ---------------------------------------------------
    app.post("/dns", async (req, reply) => {
      const parsed = z.object({ host: hostSchema }).safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: { code: "validation_failed", message: parsed.error.message } });
      const host = parsed.data.host;
      try {
        const [a, aaaa] = await Promise.allSettled([dns.resolve4(host), dns.resolve6(host)]);
        const v4 = a.status === "fulfilled" ? a.value : [];
        const v6 = aaaa.status === "fulfilled" ? aaaa.value : [];
        if (v4.length === 0 && v6.length === 0) {
          // resolve4/6 only do real DNS queries; fall back to the system
          // resolver (which also honors /etc/hosts, e.g. "localhost").
          try {
            const all = await dns.lookup(host, { all: true });
            if (all.length > 0) {
              return reply.send({ ok: true, output: all.map((r) => `${r.family === 6 ? "AAAA" : "A"}     ${r.address}`).join("\n") });
            }
          } catch { /* fall through */ }
          return reply.send({ ok: false, output: "", error: "no records found" });
        }
        const lines = [...v4.map((ip) => `A     ${ip}`), ...v6.map((ip) => `AAAA  ${ip}`)];
        return reply.send({ ok: true, output: lines.join("\n") });
      } catch (e) {
        return reply.send({ ok: false, output: "", error: e instanceof Error ? e.message : "lookup failed" });
      }
    });

    // ---- TCP port check ----------------------------------------------
    app.post("/port-check", async (req, reply) => {
      const parsed = z.object({ host: hostSchema, port: z.number().int().min(1).max(65535) }).safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: { code: "validation_failed", message: parsed.error.message } });
      const { host, port } = parsed.data;
      if (!(await guardHost(req, reply, "port-check", host))) return;
      const result = await new Promise<{ ok: boolean; output: string; error?: string }>((resolve) => {
        const started = Date.now();
        const socket = new net.Socket();
        let done = false;
        const finish = (r: { ok: boolean; output: string; error?: string }) => {
          if (done) return; done = true;
          socket.destroy();
          resolve(r);
        };
        socket.setTimeout(5000);
        socket.once("connect", () => finish({ ok: true, output: `Port ${port} on ${host} is OPEN (${Date.now() - started} ms)` }));
        socket.once("timeout", () => finish({ ok: false, output: "", error: `Port ${port} on ${host}: timed out` }));
        socket.once("error", (e: NodeJS.ErrnoException) =>
          finish({ ok: false, output: "", error: `Port ${port} on ${host}: ${e.code === "ECONNREFUSED" ? "refused (closed)" : e.message}` }));
        socket.connect(port, host);
      });
      await audit(req, "port-check", `${host}:${port}`, result.ok);
      return reply.send(result);
    });

    // ---- LAN device discovery (scan a /24..../32) --------------------
    app.post("/scan", async (req, reply) => {
      const parsed = z.object({
        cidr: z.string().min(1).max(64),
        ports: z.array(z.number().int().min(1).max(65535)).max(12).optional(),
      }).safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: { code: "validation_failed", message: parsed.error.message } });

      const ips = expandCidr(parsed.data.cidr);
      if (!Array.isArray(ips)) return reply.code(400).send({ error: { code: "invalid_cidr", message: ips.error } });

      // SEC-NET-001: refuse scanning an infra-sensitive range (loopback,
      // link-local/metadata, multicast). RFC1918 LAN ranges remain allowed.
      if (ips.some((ip) => isInfraSensitiveIp(ip))) {
        await audit(req, "scan", parsed.data.cidr, false);
        return reply.code(403).send({ error: { code: "target_not_allowed", message: "that range is not permitted for scanning" } });
      }

      const ports = parsed.data.ports?.length ? parsed.data.ports : DEFAULT_SCAN_PORTS;
      const results = await pool(ips, 48, (ip) => probeHost(ip, ports, 700));
      const devices = results.filter(Boolean);
      await audit(req, "scan", parsed.data.cidr, true);
      return reply.send({ scanned: ips.length, found: devices.length, ports, devices });
    });
  };
}
