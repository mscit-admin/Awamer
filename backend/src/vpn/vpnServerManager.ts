/**
 * Built-in OpenVPN *server* instances (migration 019).
 *
 * SEC-INFRA-001 — the backend NO LONGER spawns OpenVPN. It sends the server's
 * STRUCTURED parameters (port/proto/subnet/cipher + PKI material) to the
 * isolated `awamer-vpn-helper`, which assembles the config, writes its OWN
 * auth-verify wrapper (pointing at its own authVerify.js), and runs OpenVPN with
 * NET_ADMIN + /dev/net/tun. This manager mirrors the helper's state. Start FAILS
 * CLOSED if the helper is unreachable — no local OpenVPN fallback.
 */
import type { Logger } from "../logger/index.js";
import { type VpnServer, VpnServerErrors } from "../domain/vpnServer.js";
import { VpnHelperClient, VpnHelperUnavailable, VpnHelperError } from "./helperClient.js";

export type ServerState = "starting" | "running" | "error" | "stopped";

export interface PublicVpnServerStatus {
  server_id: string;
  state: ServerState;
  error: string | null;
  started_at: string | null;
}

interface ServerRuntime {
  serverId: string;
  state: ServerState;
  error: string | null;
  startedAt: string | null;
}

export class VpnServerManager {
  private readonly servers = new Map<string, ServerRuntime>();

  constructor(private readonly log: Logger, private readonly helper: VpnHelperClient) {}

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
    const runtime: ServerRuntime = { serverId: server.id, state: "starting", error: null, startedAt: null };
    this.servers.set(server.id, runtime);
    try {
      const res = await this.helper.request("server_start", {
        serverId: server.id,
        port: server.port, proto: server.proto, subnet: server.subnet, dns: server.dns,
        clientToClient: server.clientToClient, cipher: server.cipher,
        caCert: server.caCert, serverCert: server.serverCert, serverKey: server.serverKey,
        tlsCrypt: server.tlsCrypt,
      });
      if (res.state !== "running") {
        throw new Error(typeof res.error === "string" && res.error ? res.error : "the VPN helper did not start the server");
      }
      runtime.state = "running";
      runtime.startedAt = new Date().toISOString();
      this.log.info({ server: server.id, port: server.port }, "VPN server started via helper");
      return this.status(server.id);
    } catch (e) {
      runtime.state = "error";
      runtime.error = e instanceof Error ? e.message : String(e);
      this.servers.delete(server.id);
      if (e instanceof VpnHelperUnavailable) throw VpnServerErrors.OpenvpnUnavailable();
      if (e instanceof VpnHelperError) throw new Error(e.message);
      throw e;
    }
  }

  async stop(serverId: string): Promise<boolean> {
    const s = this.servers.get(serverId);
    if (!s) {
      // Still ask the helper to stop in case our mirror is stale.
      try { await this.helper.request("server_stop", { serverId }); } catch { /* ignore */ }
      return false;
    }
    this.servers.delete(serverId);
    s.state = "stopped";
    try { await this.helper.request("server_stop", { serverId }); }
    catch (e) { this.log.warn({ server: serverId, err: e instanceof Error ? e.message : String(e) }, "helper server_stop failed"); }
    this.log.info({ server: serverId }, "VPN server stopped");
    return true;
  }

  async stopAll(): Promise<void> {
    const ids = [...this.servers.keys()];
    this.servers.clear();
    for (const id of ids) {
      try { await this.helper.request("server_stop", { serverId: id }); } catch { /* best effort */ }
    }
  }
}
