/** Network diagnostics API (requires sessions:connect). */
import { request } from "@/shared/lib/api";

export interface NetResult {
  ok: boolean;
  output: string;
  error?: string;
}

export const networkApi = {
  ping(host: string) {
    return request<NetResult>("/api/v1/network/ping", { method: "POST", body: { host } });
  },
  traceroute(host: string) {
    return request<NetResult>("/api/v1/network/traceroute", { method: "POST", body: { host } });
  },
  dns(host: string) {
    return request<NetResult>("/api/v1/network/dns", { method: "POST", body: { host } });
  },
  portCheck(host: string, port: number) {
    return request<NetResult>("/api/v1/network/port-check", { method: "POST", body: { host, port } });
  },
};
