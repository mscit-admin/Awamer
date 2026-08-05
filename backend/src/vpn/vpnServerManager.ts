/**
 * Runs the built-in OpenVPN *server* instances (migration 019).
 *
 * For a started server the manager assembles its config from the DB (certs,
 * keys, tls-crypt), writes it to a private temp dir, and spawns `openvpn` in
 * server mode with `AWAMER_VPN_SERVER_ID` set so the auth-verify child can scope
 * its lookups. Instances are in-memory and keyed by server id; a backend
 * restart drops them (re-start from the UI). Binding a UDP/TCP listener + tun
 * needs the container's `NET_ADMIN` + tun device (already granted for VPN).
 */
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger } from "../logger/index.js";
import {
  assembleServerConfig, assignClientIps, cidrNetmask, clientIpCcd, internetFirewallSpecs,
  type FirewallSpec, type VpnServer, VpnServerErrors,
} from "../domain/vpnServer.js";

const execFileAsync = promisify(execFile);

/** Minimal client shape the manager needs to build per-client push files. */
export interface VpnServerClientNet {
  username: string;
  internetAccess: boolean;
  revoked: boolean;
}

export type ServerState = "starting" | "running" | "error" | "stopped";

export interface PublicVpnServerStatus {
  server_id: string;
  state: ServerState;
  error: string | null;
  started_at: string | null;
}

interface ServerProc {
  serverId: string;
  state: ServerState;
  error: string | null;
  startedAt: string | null;
  proc: ChildProcess | null;
  dir: string | null;
  /** Firewall rules installed for internet policy (for exact teardown), or null. */
  firewall: FirewallSpec[] | null;
}

const READY = "Initialization Sequence Completed";

// Single-quote a string for safe inclusion in a POSIX /bin/sh script.
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

// The auth-verify script sits next to this module (dist/vpn/authVerify.js in
// production). OpenVPN execve()s the verify command directly — it does NOT
// search PATH — so the interpreter MUST be an absolute path. `process.execPath`
// is the running node binary (e.g. /usr/local/bin/node in the container); a bare
// "node" fails with `execve: No such file or directory`. In a tsx dev run the
// script is a .ts, loaded via node's --import hook (openvpn isn't used in dev,
// but keep the command runnable).
const HERE = dirname(fileURLToPath(import.meta.url));
const VERIFY_SCRIPT = join(HERE, "authVerify.js");
const VERIFY_EXEC = VERIFY_SCRIPT.endsWith(".ts")
  ? `${shq(process.execPath)} --import tsx ${shq(VERIFY_SCRIPT)}`
  : `${shq(process.execPath)} ${shq(VERIFY_SCRIPT)}`;

function tailSummary(tail: string[]): string {
  if (tail.length === 0) return "";
  const m = tail.filter((l) => /error|fatal|cannot|failed|denied|unable|no such|address already/i.test(l));
  return `: ${(m.length ? m : tail.slice(-1)).slice(-3).join(" | ")}`;
}

export class VpnServerManager {
  private readonly servers = new Map<string, ServerProc>();

  constructor(private readonly log: Logger) {}

  status(serverId: string): PublicVpnServerStatus {
    const s = this.servers.get(serverId);
    if (!s) return { server_id: serverId, state: "stopped", error: null, started_at: null };
    return { server_id: s.serverId, state: s.state, error: s.error, started_at: s.startedAt };
  }

  list(): PublicVpnServerStatus[] {
    return [...this.servers.values()].map((s) => this.status(s.serverId));
  }

  async start(server: VpnServer, clients: VpnServerClientNet[] = []): Promise<PublicVpnServerStatus> {
    const existing = this.servers.get(server.id);
    if (existing && (existing.state === "running" || existing.state === "starting")) {
      return this.status(server.id);
    }

    const runtime: ServerProc = {
      serverId: server.id, state: "starting", error: null, startedAt: null, proc: null, dir: null, firewall: null,
    };
    this.servers.set(server.id, runtime);

    try {
      const dir = await mkdtemp(join(tmpdir(), "awamer-vpnsrv-"));
      runtime.dir = dir;

      // OpenVPN builds the verify script's environment itself (it does NOT
      // forward the daemon's env), so a tiny wrapper carries the two values the
      // script needs and execs node by absolute path. It lives in the same
      // private dir as the server key (0700, removed on stop).
      const wrapperPath = join(dir, "verify.sh");
      const wrapper =
        "#!/bin/sh\n" +
        `export DATABASE_URL=${shq(process.env.DATABASE_URL ?? "")}\n` +
        `export AWAMER_VPN_SERVER_ID=${shq(server.id)}\n` +
        `exec ${VERIFY_EXEC} "$@"\n`;
      await writeFile(wrapperPath, wrapper, { mode: 0o700 });

      // Internet policy (master switch on): force every client through the
      // tunnel and let the server firewall allow (allowed users) or block
      // (everyone else) their internet — blocked users can still reach the local
      // VPN subnet. Each non-revoked client gets a fixed VPN IP so the firewall
      // can identify them. Best-effort: any failure here falls back to no policy
      // (base VPN still starts), so it can never take the server down.
      let clientConfigDir: string | null = null;
      let firewallSpecs: FirewallSpec[] | null = null;
      if (server.internetAccess) {
        try {
          const active = clients.filter((c) => !c.revoked);
          const ips = assignClientIps(server.subnet, active.map((c) => c.username));
          const netmask = cidrNetmask(server.subnet);
          const ccdDir = join(dir, "ccd");
          await mkdir(ccdDir, { mode: 0o700 });
          for (const c of active) {
            const ip = ips.get(c.username);
            if (ip) await writeFile(join(ccdDir, c.username), clientIpCcd(ip, netmask), { mode: 0o600 });
          }
          clientConfigDir = ccdDir;
          const blockedIps = active
            .filter((c) => !c.internetAccess)
            .map((c) => ips.get(c.username))
            .filter((ip): ip is string => Boolean(ip));
          firewallSpecs = internetFirewallSpecs(server.subnet, blockedIps);
        } catch (e) {
          this.log.warn({ err: e instanceof Error ? e.message : String(e) },
            "vpn-server: internet policy setup failed — starting without it");
          clientConfigDir = null;
          firewallSpecs = null;
        }
      }

      const config = assembleServerConfig({
        port: server.port, proto: server.proto, subnet: server.subnet, dns: server.dns,
        clientToClient: server.clientToClient, cipher: server.cipher,
        caCert: server.caCert, serverCert: server.serverCert, serverKey: server.serverKey,
        tlsCrypt: server.tlsCrypt, verifyCommand: `"${wrapperPath}"`,
        clientConfigDir, internetPolicy: Boolean(firewallSpecs),
      });
      const configPath = join(dir, "server.conf");
      await writeFile(configPath, config, { mode: 0o600 });

      const proc = spawn("openvpn", ["--config", configPath], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, AWAMER_VPN_SERVER_ID: server.id },
      });
      runtime.proc = proc;

      const tail: string[] = [];
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const timeout = setTimeout(() => {
          if (!settled) { settled = true; reject(new Error(`server did not start within 20s${tailSummary(tail)}`)); }
        }, 20_000);
        const onLine = (buf: Buffer) => {
          for (const raw of buf.toString().split(/\r?\n/)) {
            const line = raw.trim();
            if (!line) continue;
            tail.push(line); if (tail.length > 25) tail.shift();
            this.log.info({ server: server.id }, `openvpn-server: ${line}`);
            if (line.includes(READY) && !settled) {
              settled = true; clearTimeout(timeout);
              runtime.state = "running"; runtime.startedAt = new Date().toISOString();
              resolve();
            }
          }
        };
        proc.stdout?.on("data", onLine);
        proc.stderr?.on("data", onLine);
        proc.once("error", (err: NodeJS.ErrnoException) => {
          if (settled) return; settled = true; clearTimeout(timeout);
          reject(err.code === "ENOENT" ? VpnServerErrors.OpenvpnUnavailable() : err);
        });
        proc.once("exit", (code) => {
          if (!settled) { settled = true; clearTimeout(timeout); reject(new Error(`openvpn exited (code ${code ?? "?"})${tailSummary(tail)}`)); }
          else if (runtime.state === "running") runtime.state = "stopped";
          void this.cleanup(runtime);
        });
      });

      // Install the firewall *after* the server is confirmed up, so a slow or
      // failing iptables can never block or break the VPN coming online. Fully
      // best-effort: internet allow/block just won't apply if it fails (logged).
      if (firewallSpecs) {
        const specs = firewallSpecs;
        this.applyFirewall(specs, true)
          .then(() => { runtime.firewall = specs; })
          .catch((e) => this.log.warn({ err: e instanceof Error ? e.message : String(e) }, "vpn-server: firewall setup failed"));
      }

      this.log.info({ server: server.id, port: server.port }, "VPN server started");
      return this.status(server.id);
    } catch (e) {
      runtime.state = "error";
      runtime.error = e instanceof Error ? e.message : String(e);
      try { runtime.proc?.kill("SIGTERM"); } catch { /* ignore */ }
      await this.cleanup(runtime);
      throw e;
    }
  }

  stop(serverId: string): boolean {
    const s = this.servers.get(serverId);
    if (!s) return false;
    this.servers.delete(serverId);
    try { s.proc?.kill("SIGTERM"); } catch { /* ignore */ }
    s.state = "stopped";
    void this.cleanup(s);
    this.log.info({ server: serverId }, "VPN server stopped");
    return true;
  }

  private async cleanup(s: ServerProc): Promise<void> {
    if (s.firewall) {
      const specs = s.firewall; s.firewall = null;
      await this.applyFirewall(specs, false).catch(() => { /* best-effort teardown */ });
    }
    if (!s.dir) return;
    const dir = s.dir; s.dir = null;
    try { await rm(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  /**
   * Add (`add=true`) or remove the internet-policy firewall rules. Best-effort:
   * missing iptables just means the allow/block policy isn't enforced (the
   * server still runs). `-w 5` avoids hanging on the xtables lock; each exec has
   * a hard 10s timeout. Rules are appended in `specs` order so the per-IP DROPs
   * precede the general internet ACCEPT.
   */
  private async applyFirewall(specs: FirewallSpec[], add: boolean): Promise<void> {
    const flag = add ? "-A" : "-D";
    for (const s of specs) {
      const args = ["-w", "5", ...(s.table ? ["-t", s.table] : []), flag, s.chain, ...s.rule];
      if (add) {
        const del = args.slice();
        del[del.indexOf(flag)] = "-D";
        await execFileAsync("iptables", del, { timeout: 10_000 }).catch(() => { /* not present yet */ });
      }
      try {
        await execFileAsync("iptables", args, { timeout: 10_000 });
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code === "ENOENT") {
          this.log.warn("VPN internet policy needs iptables, which is not installed — allow/block won't be enforced");
          return;
        }
        if (add) this.log.warn({ err: err.message, rule: args.join(" ") }, "vpn-server: iptables rule failed");
      }
    }
  }

  stopAll(): void {
    for (const s of this.servers.values()) {
      try { s.proc?.kill("SIGTERM"); } catch { /* ignore */ }
      void this.cleanup(s);
    }
    this.servers.clear();
  }
}
