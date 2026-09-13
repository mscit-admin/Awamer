/**
 * OpenVPN client profiles (migration 017).
 *
 * Profiles live in the backend (encrypted, RBAC-gated). The tunnel itself runs
 * either in the desktop app (native `openvpn` via Tauri commands) or on the
 * backend (a server-managed process), selectable per profile. `vpnClient`
 * hides that split: `connect`/`disconnect`/`statusFor` pick the right runtime.
 */
import { invoke } from "@tauri-apps/api/core";
import { request } from "@/shared/lib/api";
import { isTauri } from "@/shared/lib/tauri";

export type VpnRuntime = "desktop" | "backend";
export type VpnSource = "config" | "manual";
export type VpnProto = "udp" | "tcp";
export type VpnAuthMode = "none" | "userpass";

export interface VpnProfile {
  id: string;
  name: string;
  description: string | null;
  runtime: VpnRuntime;
  source: VpnSource;
  remote_host: string | null;
  remote_port: number | null;
  proto: VpnProto;
  auth_mode: VpnAuthMode;
  auto_connect: boolean;
  has_config: boolean;
  has_ca: boolean;
  has_cert: boolean;
  has_key: boolean;
  has_tls_auth: boolean;
  has_username: boolean;
  has_password: boolean;
  created_at: string;
  updated_at: string;
}

/** Secret + metadata accepted on create/update. Omit a secret field on update
 *  to keep it; pass "" to clear it. */
export interface VpnProfileInput {
  name?: string;
  description?: string | null;
  runtime?: VpnRuntime;
  source?: VpnSource;
  remote_host?: string | null;
  remote_port?: number | null;
  proto?: VpnProto;
  auth_mode?: VpnAuthMode;
  auto_connect?: boolean;
  config?: string;
  ca?: string;
  cert?: string;
  key?: string;
  tls_auth?: string;
  username?: string;
  password?: string;
}

export interface VpnConfigPayload {
  id: string;
  name: string;
  runtime: VpnRuntime;
  auth_mode: VpnAuthMode;
  config: string;
  username: string | null;
  password: string | null;
}

/** Backend-runtime live connection (from the server manager). */
export interface VpnConnection {
  id: string;
  profile_id: string;
  profile_name: string;
  state: "connecting" | "connected" | "error" | "closed";
  error: string | null;
  created_at: string;
  connected_at: string | null;
}

/** Native desktop tunnel status (from the Rust manager). */
export interface VpnNativeStatus {
  profile_id: string;
  name: string;
  state: "connecting" | "connected" | "error" | "closed";
  error: string | null;
}

export const vpnApi = {
  list() {
    return request<{ data: VpnProfile[] }>("/api/v1/vpn/profiles");
  },
  get(id: string) {
    return request<VpnProfile>(`/api/v1/vpn/profiles/${id}`);
  },
  create(input: VpnProfileInput & { name: string }) {
    return request<VpnProfile>("/api/v1/vpn/profiles", { method: "POST", body: input });
  },
  update(id: string, patch: VpnProfileInput) {
    return request<VpnProfile>(`/api/v1/vpn/profiles/${id}`, { method: "PATCH", body: patch });
  },
  remove(id: string) {
    return request<void>(`/api/v1/vpn/profiles/${id}`, { method: "DELETE" });
  },
  /** Reveal the launchable config + auth (sensitive; audited server-side). */
  config(id: string) {
    return request<VpnConfigPayload>(`/api/v1/vpn/profiles/${id}/config`);
  },
  /** Effective profile for an asset (own, else nearest ancestor folder). */
  resolve(hostId: string) {
    return request<{ profile: VpnProfile | null }>(`/api/v1/vpn/resolve?host_id=${encodeURIComponent(hostId)}`);
  },

  // ---- backend-runtime connections ---------------------------------
  connections() {
    return request<{ data: VpnConnection[] }>("/api/v1/vpn/connections");
  },
  connectBackend(profileId: string) {
    return request<VpnConnection>("/api/v1/vpn/connections", { method: "POST", body: { profile_id: profileId } });
  },
  disconnectBackend(connectionId: string) {
    return request<{ ok: boolean }>(`/api/v1/vpn/connections/${connectionId}`, { method: "DELETE" });
  },
};

// ---- native (desktop) tunnel commands ------------------------------

export const vpnNative = {
  connect(payload: VpnConfigPayload) {
    return invoke<VpnNativeStatus>("vpn_connect", {
      args: {
        profile_id: payload.id,
        name: payload.name,
        config: payload.config,
        auth_mode: payload.auth_mode,
        username: payload.username,
        password: payload.password,
      },
    });
  },
  disconnect(profileId: string) {
    return invoke<void>("vpn_disconnect", { profileId });
  },
  status(profileId: string) {
    return invoke<VpnNativeStatus | null>("vpn_status", { profileId });
  },
  list() {
    return invoke<VpnNativeStatus[]>("vpn_list");
  },
};

export type VpnLiveState = "connecting" | "connected" | "error" | "closed" | "disconnected";

/**
 * Runtime-agnostic client. For desktop profiles it drives the native openvpn
 * client; for backend profiles it drives the server manager. Desktop profiles
 * outside the Tauri app report `desktop_unavailable`.
 */
export const vpnClient = {
  async connect(profile: VpnProfile): Promise<{ state: VpnLiveState; error?: string | null }> {
    if (profile.runtime === "backend") {
      const c = await vpnApi.connectBackend(profile.id);
      return { state: c.state, error: c.error };
    }
    if (!isTauri) return { state: "error", error: "Desktop VPN tunnels require the Awamer desktop app." };
    const payload = await vpnApi.config(profile.id);
    const s = await vpnNative.connect(payload);
    return { state: s.state, error: s.error };
  },

  async disconnect(profile: VpnProfile, connectionId?: string): Promise<void> {
    if (profile.runtime === "backend") {
      if (connectionId) await vpnApi.disconnectBackend(connectionId);
      return;
    }
    if (isTauri) await vpnNative.disconnect(profile.id);
  },

  /** Ensure the effective VPN for a host is up before connecting to it. */
  async ensureForHost(hostId: string): Promise<void> {
    let profile: VpnProfile | null = null;
    try {
      profile = (await vpnApi.resolve(hostId)).profile;
    } catch {
      return; // resolution failure shouldn't block the connect attempt
    }
    if (!profile || !profile.auto_connect) return;
    const r = await vpnClient.connect(profile);
    if (r.state === "error") {
      throw new Error(r.error || `Could not establish VPN "${profile.name}"`);
    }
  },
};
