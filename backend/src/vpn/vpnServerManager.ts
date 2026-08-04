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
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger } from "../logger/index.js";
import { assembleServerConfig, type VpnServer, VpnServerErrors } from "../domain/vpnServer.js";

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
}

const READY = "Initialization Sequence Completed";

// Resolve the auth-verify script next to this module (dist/vpn/authVerify.js in
// production). openvpn runs it via `node <path>`; in a tsx dev run it's a .ts,
// so prefer tsx there.
const HERE = dirname(fileURLToPath(import.meta.url));
const VERIFY_SCRIPT = join(HERE, "authVerify.js");
const VERIFY_CMD = `"${VERIFY_SCRIPT.endsWith(".ts") ? "npx tsx" : "node"} ${VERIFY_SCRIPT}"`;

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

  async start(server: VpnServer): Promise<PublicVpnServerStatus> {
    const existing = this.servers.get(server.id);
    if (existing && (existing.state === "running" || existing.state === "starting")) {
      return this.status(server.id);
    }

    const config = assembleServerConfig({
      port: server.port, proto: server.proto, subnet: server.subnet, dns: server.dns,
      clientToClient: server.clientToClient, cipher: server.cipher,
      caCert: server.caCert, serverCert: server.serverCert, serverKey: server.serverKey,
      tlsCrypt: server.tlsCrypt, verifyCommand: VERIFY_CMD,
    });

    const runtime: ServerProc = {
      serverId: server.id, state: "starting", error: null, startedAt: null, proc: null, dir: null,
    };
    this.servers.set(server.id, runtime);

    try {
      const dir = await mkdtemp(join(tmpdir(), "awamer-vpnsrv-"));
      runtime.dir = dir;
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
    if (!s.dir) return;
    const dir = s.dir; s.dir = null;
    try { await rm(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  stopAll(): void {
    for (const s of this.servers.values()) {
      try { s.proc?.kill("SIGTERM"); } catch { /* ignore */ }
      void this.cleanup(s);
    }
    this.servers.clear();
  }
}
