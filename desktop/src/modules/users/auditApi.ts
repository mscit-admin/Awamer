/** Audit-log read API (requires audit:read — admin / auditor). */
import { request } from "@/shared/lib/api";

export interface AuditEntry {
  id: number;
  timestamp: string;
  user_id: string | null;
  username: string | null;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  ip_address: string | null;
  success: boolean;
  details: Record<string, unknown>;
}

export interface AuditQuery {
  limit?: number;
  offset?: number;
  action?: string;
  success?: "true" | "false";
}

export const auditApi = {
  list(q: AuditQuery = {}) {
    const p = new URLSearchParams();
    if (q.limit !== undefined) p.set("limit", String(q.limit));
    if (q.offset !== undefined) p.set("offset", String(q.offset));
    if (q.action) p.set("action", q.action);
    if (q.success) p.set("success", q.success);
    const qs = p.toString();
    return request<{ data: AuditEntry[]; total: number; limit: number; offset: number }>(
      `/api/v1/audit${qs ? "?" + qs : ""}`,
    );
  },
};
