/**
 * Server-managed OpenVPN client connections (runtime = "backend").
 *
 * SEC-INFRA-001 — the backend NO LONGER spawns OpenVPN. It assembles + validates
 * the profile's config, then hands the privileged tunnel lifecycle to the
 * isolated `awamer-vpn-helper` over an authenticated Unix socket. This manager
 * keeps the user-scoped, in-memory record of connections (for list/stop) and
 * mirrors the helper's state. If the helper is unavailable the connect FAILS
 * CLOSED — there is deliberately no local-OpenVPN fallback.
 */
import { randomUUID } from "node:crypto";
import type { Logger } from "../logger/index.js";
import { assembleOvpnConfig, VpnErrors, type VpnProfile } from "../domain/vpn.js";
import { VpnHelperClient, VpnHelperUnavailable, VpnHelperError } from "./helperClient.js";

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
}

const MAX_CONN_PER_USER = 10;

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

  constructor(private readonly log: Logger, private readonly helper: VpnHelperClient) {}

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
   * Bring up (or reuse) a tunnel for a backend-runtime profile via the helper.
   * Idempotent per (user, profile). Rejects on validation failure, on a helper
   * error, or (fail-closed) if the helper is unreachable.
   */
  async connect(userId: string, profile: VpnProfile): Promise<PublicVpnConnection> {
    if (profile.runtime !== "backend") throw VpnErrors.BackendOnly();

    const existing = this.findByProfile(userId, profile.id);
    if (existing) return toPublic(existing);

    const mine = [...this.conns.values()].filter((c) => c.userId === userId && c.state !== "closed");
    if (mine.length >= MAX_CONN_PER_USER) throw VpnErrors.TooManyConnections();

    // Assemble + validate on the backend too (defence in depth; the helper
    // re-validates). Never build an OpenVPN argument array here.
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
    };
    this.conns.set(id, runtime);

    try {
      const res = await this.helper.request("client_connect", {
        sessionRef: id,
        config,
        ...(profile.authMode === "userpass"
          ? { authUser: profile.secret.username ?? "", authPass: profile.secret.password ?? "" }
          : {}),
      });
      if (res.state !== "running") {
        throw new Error(typeof res.error === "string" && res.error ? res.error : "the VPN helper did not bring the tunnel up");
      }
      runtime.state = "connected";
      runtime.connectedAt = new Date().toISOString();
      this.log.info({ conn: id, profile: profile.id }, "backend VPN connected via helper");
      return toPublic(runtime);
    } catch (e) {
      runtime.state = "error";
      runtime.error = e instanceof Error ? e.message : String(e);
      this.conns.delete(id);
      if (e instanceof VpnHelperUnavailable) {
        // Fail closed — never fall back to a local OpenVPN spawn.
        throw VpnErrors.OpenvpnUnavailable();
      }
      if (e instanceof VpnHelperError) throw new Error(e.message);
      throw e;
    }
  }

  async remove(userId: string, id: string): Promise<boolean> {
    const c = this.conns.get(id);
    if (!c || c.userId !== userId) return false;
    this.conns.delete(id);
    c.state = "closed";
    try { await this.helper.request("client_stop", { sessionRef: id }); }
    catch (e) { this.log.warn({ conn: id, err: e instanceof Error ? e.message : String(e) }, "helper client_stop failed"); }
    this.log.info({ conn: id }, "backend VPN stopped");
    return true;
  }

  async stopAll(): Promise<void> {
    const ids = [...this.conns.keys()];
    this.conns.clear();
    for (const id of ids) {
      try { await this.helper.request("client_stop", { sessionRef: id }); } catch { /* best effort */ }
    }
  }
}
