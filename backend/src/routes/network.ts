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

interface Deps {
  jwt: JwtService;
}

const HOST_RE = /^[a-zA-Z0-9._-]+$/;
const hostSchema = z.string().min(1).max(253).regex(HOST_RE, "invalid host");

const MAX_OUTPUT = 64 * 1024;

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
    app.addHook("preHandler", makeAuthMiddleware(deps.jwt));
    app.addHook("preHandler", requirePermission("sessions:connect"));

    // ---- ping ---------------------------------------------------------
    app.post("/ping", async (req, reply) => {
      const parsed = z.object({ host: hostSchema }).safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: { code: "validation_failed", message: parsed.error.message } });
      const r = await runCommand("ping", ["-c", "4", "-w", "10", parsed.data.host], 12_000);
      return reply.send(r);
    });

    // ---- traceroute ---------------------------------------------------
    app.post("/traceroute", async (req, reply) => {
      const parsed = z.object({ host: hostSchema }).safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: { code: "validation_failed", message: parsed.error.message } });
      const r = await runCommand("traceroute", ["-m", "20", "-w", "2", "-q", "1", parsed.data.host], 30_000);
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
      return reply.send(result);
    });
  };
}
