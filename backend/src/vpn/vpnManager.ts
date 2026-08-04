/**
 * Server-managed OpenVPN connections (runtime = "backend").
 *
 * For a backend-runtime profile the openvpn client process runs here, on the
 * server, so every session that reaches the associated assets does so through
 * this host's tunnel. Connections are in-memory and user-scoped; a backend
 * restart drops them (definitions live in the DB, the live tunnels do not).
 *
 * Bringing up a real tun device needs the `openvpn` binary and elevated
 * privileges on the server — absent those, `connect` fails with a clear error
 * rather than pretending to be up. Desktop-runtime profiles never touch this
 * manager; their tunnel runs in the native client.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "../logger/index.js";
import { assembleOvpnConfig, VpnErrors, type VpnProfile } from "../domain/vpn.js";

export type VpnConnState = "connecting" | "connected" | "error" | "closed";

export interface PublicVpnConnection {
  id: string;
  profile_id: string;
  profile_name: string;
  state: VpnConnState;
  error: string | null;
  created_at: string;
  connected_at: string | null;
}

interface ConnRuntime {
  id: string;
  userId: string;
  profileId: string;
  profileName: string;
  state: VpnConnState;
  error: string | null;
  createdAt: string;
  connectedAt: string | null;
  proc: ChildProcess | null;
  dir: string | null;
}

const MAX_CONN_PER_USER = 10;
const READY_MARKER = "Initialization Sequence Completed";

/**
 * Distil the most useful line(s) from openvpn's output for an error message —
 * prefer explicit ERROR/FATAL/warning lines, else fall back to the last line.
 */
function tailSummary(tail: string[]): string {
  if (tail.length === 0) return "";
  const meaningful = tail.filter((l) => /error|fatal|cannot|failed|denied|unable|auth|tls|no such/i.test(l));
  const picks = (meaningful.length ? meaningful : tail.slice(-1)).slice(-3);
  return `: ${picks.join(" | ")}`;
}

function toPublic(c: ConnRuntime): PublicVpnConnection {
  return {
    id: c.id,
    profile_id: c.profileId,
    profile_name: c.profileName,
    state: c.state,
    error: c.error,
    created_at: c.createdAt,
    connected_at: c.connectedAt,
  };
}

export class VpnManager {
  private readonly conns = new Map<string, ConnRuntime>();

  constructor(private readonly log: Logger) {}

  list(userId: string): PublicVpnConnection[] {
    return [...this.conns.values()]
      .filter((c) => c.userId === userId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(toPublic);
  }

  private findByProfile(userId: string, profileId: string): ConnRuntime | undefined {
    return [...this.conns.values()].find(
      (c) => c.userId === userId && c.profileId === profileId && c.state !== "closed" && c.state !== "error",
    );
  }

  /**
   * Bring up (or reuse) a tunnel for a backend-runtime profile. Idempotent per
   * (user, profile): a live connection is returned as-is. Resolves once the
   * process reports the tunnel is up, or rejects on failure/timeout.
   */
  async connect(userId: string, profile: VpnProfile): Promise<PublicVpnConnection> {
    if (profile.runtime !== "backend") throw VpnErrors.BackendOnly();

    const existing = this.findByProfile(userId, profile.id);
    if (existing) return toPublic(existing);

    const mine = [...this.conns.values()].filter((c) => c.userId === userId && c.state !== "closed");
    if (mine.length >= MAX_CONN_PER_USER) throw VpnErrors.TooManyConnections();

    const config = assembleOvpnConfig(profile).trim();
    if (!config) throw VpnErrors.ConfigMissing();

    const id = randomUUID();
    const runtime: ConnRuntime = {
      id, userId,
      profileId: profile.id,
      profileName: profile.name,
      state: "connecting",
      error: null,
      createdAt: new Date().toISOString(),
      connectedAt: null,
      proc: null,
      dir: null,
    };
    this.conns.set(id, runtime);

    let dir: string;
    try {
      dir = await mkdtemp(join(tmpdir(), "awamer-vpn-"));
      runtime.dir = dir;
      const configPath = join(dir, "client.ovpn");
      await writeFile(configPath, config, { mode: 0o600 });

      const args = ["--config", configPath];
      if (profile.authMode === "userpass") {
        const authPath = join(dir, "auth.txt");
        await writeFile(authPath, `${profile.secret.username ?? ""}\n${profile.secret.password ?? ""}\n`, { mode: 0o600 });
        args.push("--auth-user-pass", authPath);
        args.push("--auth-nocache");
      }
      // Force the script sandbox on last so it overrides anything in the config:
      // only openvpn's built-in helpers (ifconfig/ip/route) may run, never a
      // user `up`/`down`/`plugin` script. Combined with assertSafeOvpnConfig
      // this closes the "config = code execution as root" vector.
      args.push("--script-security", "1");

      const proc = spawn("openvpn", args, { stdio: ["ignore", "pipe", "pipe"] });
      runtime.proc = proc;

      // Keep the last few openvpn log lines so a failure explains itself
      // (bad config, missing certs, tun permission, auth) instead of just an
      // exit code. Lines are also logged so `docker logs` shows the detail.
      const tail: string[] = [];

      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const timeout = setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(new Error(`openvpn did not connect within 30s${tailSummary(tail)}`));
        }, 30_000);

        const onLine = (buf: Buffer) => {
          for (const raw of buf.toString().split(/\r?\n/)) {
            const line = raw.trim();
            if (!line) continue;
            tail.push(line);
            if (tail.length > 25) tail.shift();
            this.log.info({ conn: id, profile: profile.id }, `openvpn: ${line}`);
            if (line.includes(READY_MARKER) && !settled) {
              settled = true;
              clearTimeout(timeout);
              runtime.state = "connected";
              runtime.connectedAt = new Date().toISOString();
              resolve();
            }
          }
        };
        proc.stdout?.on("data", onLine);
        proc.stderr?.on("data", onLine);

        proc.once("error", (err: NodeJS.ErrnoException) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          reject(err.code === "ENOENT" ? VpnErrors.OpenvpnUnavailable() : err);
        });
        proc.once("exit", (code) => {
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            reject(new Error(`openvpn exited (code ${code ?? "?"}) before connecting${tailSummary(tail)}`));
          } else if (runtime.state === "connected") {
            runtime.state = "closed";
          }
          void this.cleanupDir(runtime);
        });
      });

      this.log.info({ conn: id, profile: profile.id }, "backend VPN connected");
      return toPublic(runtime);
    } catch (e) {
      runtime.state = "error";
      runtime.error = e instanceof Error ? e.message : String(e);
      try { runtime.proc?.kill("SIGTERM"); } catch { /* ignore */ }
      await this.cleanupDir(runtime);
      // Keep the failed record briefly so the UI can show why; drop the handle.
      this.conns.delete(id);
      throw e;
    }
  }

  remove(userId: string, id: string): boolean {
    const c = this.conns.get(id);
    if (!c || c.userId !== userId) return false;
    this.conns.delete(id);
    try { c.proc?.kill("SIGTERM"); } catch { /* ignore */ }
    c.state = "closed";
    void this.cleanupDir(c);
    this.log.info({ conn: id }, "backend VPN stopped");
    return true;
  }

  private async cleanupDir(c: ConnRuntime): Promise<void> {
    if (!c.dir) return;
    const dir = c.dir;
    c.dir = null;
    try { await rm(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  stopAll(): void {
    for (const c of this.conns.values()) {
      try { c.proc?.kill("SIGTERM"); } catch { /* ignore */ }
      void this.cleanupDir(c);
    }
    this.conns.clear();
  }
}
