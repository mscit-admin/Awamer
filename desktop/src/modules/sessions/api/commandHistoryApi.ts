/** Per-user command history API (requires sessions:connect). Opt-in. */
import { request } from "@/shared/lib/api";

export interface CommandHistoryEntry {
  id: string;
  host_id: string | null;
  host_label: string | null;
  command: string;
  created_at: string;
}

export const commandHistoryApi = {
  list(opts: { limit?: number; hostId?: string; search?: string } = {}) {
    const q = new URLSearchParams();
    if (opts.limit) q.set("limit", String(opts.limit));
    if (opts.hostId) q.set("host_id", opts.hostId);
    if (opts.search) q.set("search", opts.search);
    const qs = q.toString();
    return request<{ data: CommandHistoryEntry[]; total: number; limit: number }>(
      "/api/v1/command-history" + (qs ? `?${qs}` : ""),
    );
  },
  add(input: { command: string; hostId?: string | null; hostLabel?: string | null }) {
    return request<CommandHistoryEntry>("/api/v1/command-history", {
      method: "POST",
      body: { command: input.command, host_id: input.hostId ?? null, host_label: input.hostLabel ?? null },
    });
  },
  clear(opts: { hostId?: string } = {}) {
    const qs = opts.hostId ? `?host_id=${encodeURIComponent(opts.hostId)}` : "";
    return request<{ deleted: number }>("/api/v1/command-history" + qs, { method: "DELETE" });
  },
};
