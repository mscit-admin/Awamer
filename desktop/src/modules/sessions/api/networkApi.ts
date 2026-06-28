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
  scan(cidr: string, ports?: number[]) {
    return request<ScanResult>("/api/v1/network/scan", { method: "POST", body: { cidr, ...(ports ? { ports } : {}) } });
  },
};

export interface ScanDevice {
  ip: string;
  open: number[];
  up: boolean;
  hostname: string | null;
}
export interface ScanResult {
  scanned: number;
  found: number;
  ports: number[];
  devices: ScanDevice[];
}
