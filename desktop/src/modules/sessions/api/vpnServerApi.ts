/**
 * Built-in OpenVPN *server* instances (migration 019).
 *
 * Awamer can act as an OpenVPN hub: create a server profile (which mints its
 * own CA + server certificate + tls-crypt key), add users to it, download a
 * ready-to-use `.ovpn` per user (certs inlined, so it installs directly into
 * OpenVPN Connect on Linux/Windows/macOS), and start/stop the running
 * `openvpn` process on the backend host. All gated by `vpn_server:manage`.
 */
import { request, fetchBlob } from "@/shared/lib/api";

export type VpnProto = "udp" | "tcp";
export type VpnServerState = "starting" | "running" | "error" | "stopped";

export interface VpnServerStatus {
  server_id: string;
  state: VpnServerState;
  error: string | null;
  started_at: string | null;
}

export interface VpnServerProfile {
  id: string;
  name: string;
  description: string | null;
  public_host: string;
  port: number;
  proto: VpnProto;
  subnet: string;
  dns: string | null;
  client_to_client: boolean;
  cipher: string;
  ca_cert: string;
  client_count: number;
  created_at: string;
  updated_at: string;
  /** Live process status (absent from create/update responses). */
  status?: VpnServerStatus;
}

export interface VpnServerInput {
  name?: string;
  description?: string | null;
  public_host?: string;
  port?: number;
  proto?: VpnProto;
  subnet?: string;
  dns?: string | null;
  client_to_client?: boolean;
  cipher?: string;
}

export interface VpnServerClient {
  id: string;
  name: string;
  username: string;
  revoked: boolean;
  revoked_at: string | null;
  created_at: string;
}

/** Client-create response — includes the one-time password to hand over. */
export interface VpnServerClientCreated extends VpnServerClient {
  password: string;
}

export interface VpnServerClientInput {
  name: string;
  username: string;
  /** Optional — the server auto-generates a strong one when omitted. */
  password?: string;
}

export const vpnServerApi = {
  list() {
    return request<{ data: VpnServerProfile[] }>("/api/v1/vpn-server/servers");
  },
  get(id: string) {
    return request<VpnServerProfile>(`/api/v1/vpn-server/servers/${id}`);
  },
  create(input: VpnServerInput & { name: string; public_host: string }) {
    return request<VpnServerProfile>("/api/v1/vpn-server/servers", { method: "POST", body: input });
  },
  update(id: string, patch: VpnServerInput) {
    return request<VpnServerProfile>(`/api/v1/vpn-server/servers/${id}`, { method: "PATCH", body: patch });
  },
  remove(id: string) {
    return request<void>(`/api/v1/vpn-server/servers/${id}`, { method: "DELETE" });
  },

  // ---- runtime -----------------------------------------------------
  start(id: string) {
    return request<VpnServerStatus>(`/api/v1/vpn-server/servers/${id}/start`, { method: "POST" });
  },
  stop(id: string) {
    return request<{ ok: boolean }>(`/api/v1/vpn-server/servers/${id}/stop`, { method: "POST" });
  },

  // ---- clients -----------------------------------------------------
  clients(serverId: string) {
    return request<{ data: VpnServerClient[] }>(`/api/v1/vpn-server/servers/${serverId}/clients`);
  },
  addClient(serverId: string, input: VpnServerClientInput) {
    return request<VpnServerClientCreated>(`/api/v1/vpn-server/servers/${serverId}/clients`, { method: "POST", body: input });
  },
  setRevoked(serverId: string, clientId: string, revoked: boolean) {
    return request<{ ok: boolean; revoked: boolean }>(
      `/api/v1/vpn-server/servers/${serverId}/clients/${clientId}/revoke`,
      { method: "POST", body: { revoked } },
    );
  },
  removeClient(serverId: string, clientId: string) {
    return request<void>(`/api/v1/vpn-server/servers/${serverId}/clients/${clientId}`, { method: "DELETE" });
  },
  /** Reveal a client's username/password (audited server-side). */
  credentials(serverId: string, clientId: string) {
    return request<{ username: string; password: string }>(
      `/api/v1/vpn-server/servers/${serverId}/clients/${clientId}/credentials`,
    );
  },
  /** Fetch the unified `.ovpn` for a client as a Blob (for download). */
  ovpn(serverId: string, clientId: string) {
    return fetchBlob(`/api/v1/vpn-server/servers/${serverId}/clients/${clientId}/ovpn`);
  },
};
