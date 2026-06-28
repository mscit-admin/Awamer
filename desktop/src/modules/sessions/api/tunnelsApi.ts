/** SSH port-forwarding (tunnels) API — server-managed local forwarding. */
import { request } from "@/shared/lib/api";

export interface Tunnel {
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

export interface CreateTunnelInput {
  host_id: string;
  listen_port: number;
  dst_host: string;
  dst_port: number;
  bind_public?: boolean;
}

export const tunnelsApi = {
  list() {
    return request<{ data: Tunnel[] }>("/api/v1/tunnels");
  },
  create(input: CreateTunnelInput) {
    return request<Tunnel>("/api/v1/tunnels", { method: "POST", body: input });
  },
  remove(id: string) {
    return request<{ ok: boolean }>(`/api/v1/tunnels/${id}`, { method: "DELETE" });
  },
};
