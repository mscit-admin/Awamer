/**
 * Server-managed SSH local port forwarding (the `ssh -L` model).
 *
 * For each tunnel the backend:
 *   1. opens an SSH connection to the host (user-scoped credentials),
 *   2. listens on a local TCP port (127.0.0.1 by default; 0.0.0.0 only when
 *      an admin explicitly opts in),
 *   3. for every inbound connection, opens a forwarded channel through the SSH
 *      host to (dstHost, dstPort) and pipes bytes both ways.
 *
 * Tunnels live in memory (one ssh2 Client + one net.Server each) and are scoped
 * to the user that created them. They are ephemeral by design — a backend
 * restart drops them (definitions are not persisted).
 */
import net from "node:net";
import { Client } from "ssh2";
import { randomUUID } from "node:crypto";
import type { HostRepository, CredentialRepository } from "../repos/sessionRepos.js";
import type { Logger } from "../logger/index.js";
import { resolveSshConnection } from "./resolveAuth.js";

export interface TunnelDeps {
  hosts: HostRepository;
  credentials: CredentialRepository;
  log: Logger;
}

export interface CreateTunnelParams {
  hostId: string;
  listenPort: number;
  bindPublic: boolean;
  dstHost: string;
  dstPort: number;
}

export interface PublicTunnel {
  id: string;
  host_id: string;
  host_label: string;
  listen_host: string;
  listen_port: number;
  dst_host: string;
  dst_port: number;
  status: "active" | "error" | "closed";
  error: string | null;
  connections: number;
  active: number;
  bytes_in: number;
  bytes_out: number;
  created_at: string;
}

interface TunnelRuntime {
  id: string;
  userId: string;
  hostId: string;
  hostLabel: string;
  listenHost: string;
  listenPort: number;
  dstHost: string;
  dstPort: number;
  createdAt: string;
  server: net.Server;
  conn: Client;
  status: "active" | "error" | "closed";
  error: string | null;
  connections: number;
  active: number;
  bytesIn: number;
  bytesOut: number;
}

const MAX_TUNNELS_PER_USER = 20;

function toPublic(t: TunnelRuntime): PublicTunnel {
  return {
    id: t.id,
    host_id: t.hostId,
    host_label: t.hostLabel,
    listen_host: t.listenHost,
    listen_port: t.listenPort,
    dst_host: t.dstHost,
    dst_port: t.dstPort,
    status: t.status,
    error: t.error,
    connections: t.connections,
    active: t.active,
    bytes_in: t.bytesIn,
    bytes_out: t.bytesOut,
    created_at: t.createdAt,
  };
}

export class TunnelManager {
  private readonly tunnels = new Map<string, TunnelRuntime>();

  constructor(private readonly deps: TunnelDeps) {}

  list(userId: string): PublicTunnel[] {
    return [...this.tunnels.values()]
      .filter((t) => t.userId === userId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(toPublic);
  }

  get(userId: string, id: string): PublicTunnel | null {
    const t = this.tunnels.get(id);
    return t && t.userId === userId ? toPublic(t) : null;
  }

  /** Create and start a local-forwarding tunnel. Resolves once it's listening. */
  async create(userId: string, params: CreateTunnelParams): Promise<PublicTunnel> {
    const mine = [...this.tunnels.values()].filter((t) => t.userId === userId);
    if (mine.length >= MAX_TUNNELS_PER_USER) {
      throw new TunnelError("too_many", `tunnel limit reached (${MAX_TUNNELS_PER_USER})`);
    }
    // Reject a port already in use by one of this process's tunnels early
    // (the OS bind also catches external clashes).
    if ([...this.tunnels.values()].some((t) => t.listenPort === params.listenPort)) {
      throw new TunnelError("port_in_use", `port ${params.listenPort} is already used by another tunnel`);
    }

    const resolved = await resolveSshConnection(this.deps, userId, params.hostId);
    const { host, username, auth } = resolved;
    const listenHost = params.bindPublic ? "0.0.0.0" : "127.0.0.1";

    const conn = new Client();
    const id = randomUUID();
    const createdAt = new Date().toISOString();

    // Wait for SSH to be ready (or fail) before we accept connections.
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const onError = (err: Error) => {
        if (settled) return;
        settled = true;
        reject(new TunnelError("ssh_error", err.message));
      };
      conn.once("error", onError);
      conn.once("ready", () => {
        if (settled) return;
        settled = true;
        conn.removeListener("error", onError);
        resolve();
      });
      conn.connect({
        host: host.hostname,
        port: host.port,
        username,
        readyTimeout: 20_000,
        hostVerifier: () => true, // TOFU (consistent with the SSH gateway)
        ...auth,
      });
    });

    const runtime: TunnelRuntime = {
      id, userId,
      hostId: host.id,
      hostLabel: host.name,
      listenHost,
      listenPort: params.listenPort,
      dstHost: params.dstHost,
      dstPort: params.dstPort,
      createdAt,
      server: null as unknown as net.Server,
      conn,
      status: "active",
      error: null,
      connections: 0,
      active: 0,
      bytesIn: 0,
      bytesOut: 0,
    };

    const server = net.createServer((socket) => {
      runtime.connections++;
      runtime.active++;
      const srcPort = socket.remotePort ?? 0;
      conn.forwardOut("127.0.0.1", srcPort, runtime.dstHost, runtime.dstPort, (err, stream) => {
        if (err) {
          runtime.active--;
          socket.destroy();
          this.deps.log.warn({ tunnel: id, err: err.message }, "tunnel forwardOut failed");
          return;
        }
        socket.on("data", (b: Buffer) => { runtime.bytesIn += b.length; });
        stream.on("data", (b: Buffer) => { runtime.bytesOut += b.length; });
        const done = () => { runtime.active = Math.max(0, runtime.active - 1); };
        socket.once("close", done);
        socket.pipe(stream).pipe(socket);
        socket.on("error", () => stream.destroy());
        stream.on("error", () => socket.destroy());
      });
    });

    runtime.server = server;

    conn.on("error", (err) => {
      runtime.status = "error";
      runtime.error = err.message;
      this.deps.log.warn({ tunnel: id, err: err.message }, "tunnel ssh connection error");
      try { server.close(); } catch { /* ignore */ }
    });
    conn.on("close", () => {
      if (runtime.status === "active") runtime.status = "closed";
      try { server.close(); } catch { /* ignore */ }
    });

    // Bind the listener (or fail the whole create).
    await new Promise<void>((resolve, reject) => {
      server.once("error", (err: NodeJS.ErrnoException) => {
        try { conn.end(); } catch { /* ignore */ }
        if (err.code === "EADDRINUSE") reject(new TunnelError("port_in_use", `port ${params.listenPort} is already in use`));
        else if (err.code === "EACCES") reject(new TunnelError("port_forbidden", `not permitted to bind port ${params.listenPort}`));
        else reject(new TunnelError("listen_failed", err.message));
      });
      server.listen(params.listenPort, listenHost, () => resolve());
    });

    this.tunnels.set(id, runtime);
    this.deps.log.info(
      { tunnel: id, listen: `${listenHost}:${params.listenPort}`, dst: `${params.dstHost}:${params.dstPort}`, via: host.hostname },
      "tunnel started",
    );
    return toPublic(runtime);
  }

  remove(userId: string, id: string): boolean {
    const t = this.tunnels.get(id);
    if (!t || t.userId !== userId) return false;
    this.tunnels.delete(id);
    try { t.server.close(); } catch { /* ignore */ }
    try { t.conn.end(); } catch { /* ignore */ }
    this.deps.log.info({ tunnel: id }, "tunnel stopped");
    return true;
  }

  /** Stop everything (graceful shutdown). */
  stopAll(): void {
    for (const t of this.tunnels.values()) {
      try { t.server.close(); } catch { /* ignore */ }
      try { t.conn.end(); } catch { /* ignore */ }
    }
    this.tunnels.clear();
  }
}

export class TunnelError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "TunnelError";
  }
}
