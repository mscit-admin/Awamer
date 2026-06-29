/** Per-user notes API. */
import { request } from "@/shared/lib/api";

export interface Note {
  id: string;
  ownerId: string;
  ownerUsername: string;
  isOwner: boolean;
  isShared: boolean;
  hostId: string | null;
  hostLabel: string | null;
  title: string | null;
  body: string;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
}

interface RawNote {
  id: string; owner_id: string; owner_username: string; is_owner: boolean; is_shared: boolean;
  host_id: string | null; host_label: string | null;
  title: string | null; body: string; pinned: boolean;
  created_at: string; updated_at: string;
}

function map(r: RawNote): Note {
  return {
    id: r.id, ownerId: r.owner_id, ownerUsername: r.owner_username, isOwner: r.is_owner, isShared: r.is_shared,
    hostId: r.host_id, hostLabel: r.host_label,
    title: r.title, body: r.body, pinned: r.pinned,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export const notesApi = {
  async list(opts: { hostId?: string; search?: string } = {}): Promise<Note[]> {
    const q = new URLSearchParams();
    if (opts.hostId) q.set("host_id", opts.hostId);
    if (opts.search) q.set("search", opts.search);
    const qs = q.toString();
    const r = await request<{ data: RawNote[] }>("/api/v1/notes" + (qs ? `?${qs}` : ""));
    return r.data.map(map);
  },
  async create(input: { title?: string | null; body: string; hostId?: string | null; hostLabel?: string | null }): Promise<Note> {
    const r = await request<RawNote>("/api/v1/notes", {
      method: "POST",
      body: { title: input.title ?? null, body: input.body, host_id: input.hostId ?? null, host_label: input.hostLabel ?? null },
    });
    return map(r);
  },
  async update(id: string, patch: { title?: string | null; body?: string; pinned?: boolean; is_shared?: boolean }): Promise<Note> {
    return map(await request<RawNote>(`/api/v1/notes/${id}`, { method: "PATCH", body: patch }));
  },
  remove(id: string) {
    return request<{ ok: boolean }>(`/api/v1/notes/${id}`, { method: "DELETE" });
  },
  getShares(id: string) {
    return request<{ user_ids: string[] }>(`/api/v1/notes/${id}/shares`);
  },
  setShares(id: string, userIds: string[]) {
    return request<{ ok: boolean }>(`/api/v1/notes/${id}/shares`, { method: "PUT", body: { user_ids: userIds } });
  },
};
