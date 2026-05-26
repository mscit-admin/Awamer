/**
 * Phase 2 — Session Management API client.
 * Thin wrappers over the backend's /api/v1/{hosts,folders,tags,credentials,history} endpoints.
 */
import { request } from "@/shared/lib/api";

// =====================================================================
// Shared types (mirror the backend's snake_case wire format exactly)
// =====================================================================

export type HostProtocol =
  | "ssh" | "sftp" | "rdp" | "vnc"
  | "telnet" | "serial" | "http" | "https" | "custom";

export type CredentialType =
  | "password" | "private_key" | "certificate"
  | "agent" | "kerberos" | "none";

export type ConnectionStatus =
  | "started" | "connected" | "authenticated"
  | "closed" | "failed" | "timeout";

export interface Folder {
  id: string;
  parent_id: string | null;
  name: string;
  color: string | null;
  icon: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface FolderTreeNode extends Folder {
  children: FolderTreeNode[];
}

export interface Tag {
  id: string;
  name: string;
  color: string | null;
  created_at?: string;
}

export interface CredentialPublic {
  id: string;
  name: string;
  credentialType: CredentialType;
  username: string | null;
  description: string | null;
  hasSecret: boolean;
  createdAt: string;
  updatedAt: string;
  /** Only present on GET /credentials/:id?reveal=true */
  secret_data?: Record<string, unknown>;
}

export interface Host {
  id: string;
  name: string;
  hostname: string;
  port: number;
  protocol: HostProtocol;
  folder_id: string | null;
  credential_id: string | null;
  description: string | null;
  is_favorite: boolean;
  options: Record<string, unknown>;
  last_used_at: string | null;
  use_count: number;
  created_at: string;
  updated_at: string;
  tags: Tag[];
}

export interface ConnectionHistoryEntry {
  id: number;
  host_id: string | null;
  host_name: string;
  hostname: string;
  port: number;
  protocol: HostProtocol;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  status: ConnectionStatus;
  error_message: string | null;
  client_ip: string | null;
  bytes_in: number;
  bytes_out: number;
}

export interface PaginatedResult<T> {
  data: T[];
  total: number;
  limit: number;
  offset: number;
}

// =====================================================================
// Folders
// =====================================================================

export const foldersApi = {
  list() {
    return request<{ data: Folder[]; tree: FolderTreeNode[] }>("/api/v1/folders");
  },
  create(input: Partial<Pick<Folder, "name" | "parent_id" | "color" | "icon" | "sort_order">> & { name: string }) {
    return request<Folder>("/api/v1/folders", { method: "POST", body: input });
  },
  update(id: string, patch: Partial<Pick<Folder, "name" | "parent_id" | "color" | "icon" | "sort_order">>) {
    return request<Folder>(`/api/v1/folders/${id}`, { method: "PATCH", body: patch });
  },
  delete(id: string) {
    return request<void>(`/api/v1/folders/${id}`, { method: "DELETE" });
  },
};

// =====================================================================
// Tags
// =====================================================================

export const tagsApi = {
  list() {
    return request<{ data: Tag[] }>("/api/v1/tags");
  },
  create(input: { name: string; color?: string | null }) {
    return request<Tag>("/api/v1/tags", { method: "POST", body: input });
  },
  update(id: string, patch: { name?: string; color?: string | null }) {
    return request<Tag>(`/api/v1/tags/${id}`, { method: "PATCH", body: patch });
  },
  delete(id: string) {
    return request<void>(`/api/v1/tags/${id}`, { method: "DELETE" });
  },
};

// =====================================================================
// Credentials
// =====================================================================

export const credentialsApi = {
  list() {
    return request<{ data: CredentialPublic[] }>("/api/v1/credentials");
  },
  get(id: string, reveal = false) {
    return request<CredentialPublic>(`/api/v1/credentials/${id}${reveal ? "?reveal=true" : ""}`);
  },
  create(input: {
    name: string;
    credential_type: CredentialType;
    username?: string | null;
    secret_data?: Record<string, unknown>;
    description?: string | null;
  }) {
    return request<CredentialPublic>("/api/v1/credentials", { method: "POST", body: input });
  },
  update(id: string, patch: {
    name?: string;
    username?: string | null;
    secret_data?: Record<string, unknown>;
    description?: string | null;
  }) {
    return request<CredentialPublic>(`/api/v1/credentials/${id}`, { method: "PATCH", body: patch });
  },
  delete(id: string) {
    return request<void>(`/api/v1/credentials/${id}`, { method: "DELETE" });
  },
};

// =====================================================================
// Hosts
// =====================================================================

export interface HostListFilters {
  folder_id?: string | "root";
  tag_ids?: string[];
  protocol?: HostProtocol;
  q?: string;
  favorites_only?: boolean;
  limit?: number;
  offset?: number;
}

export const hostsApi = {
  list(filters: HostListFilters = {}) {
    const params = new URLSearchParams();
    if (filters.folder_id) params.set("folder_id", filters.folder_id);
    if (filters.tag_ids?.length) params.set("tag_ids", filters.tag_ids.join(","));
    if (filters.protocol) params.set("protocol", filters.protocol);
    if (filters.q) params.set("q", filters.q);
    if (filters.favorites_only) params.set("favorites_only", "true");
    if (filters.limit !== undefined) params.set("limit", String(filters.limit));
    if (filters.offset !== undefined) params.set("offset", String(filters.offset));
    const qs = params.toString();
    return request<PaginatedResult<Host>>(`/api/v1/hosts${qs ? "?" + qs : ""}`);
  },
  get(id: string) {
    return request<Host>(`/api/v1/hosts/${id}`);
  },
  create(input: {
    name: string;
    hostname: string;
    port?: number;
    protocol: HostProtocol;
    folder_id?: string | null;
    credential_id?: string | null;
    description?: string | null;
    options?: Record<string, unknown>;
    tag_ids?: string[];
  }) {
    return request<Host>("/api/v1/hosts", { method: "POST", body: input });
  },
  update(id: string, patch: {
    name?: string;
    hostname?: string;
    port?: number;
    protocol?: HostProtocol;
    folder_id?: string | null;
    credential_id?: string | null;
    description?: string | null;
    options?: Record<string, unknown>;
    is_favorite?: boolean;
    tag_ids?: string[];
  }) {
    return request<Host>(`/api/v1/hosts/${id}`, { method: "PATCH", body: patch });
  },
  delete(id: string) {
    return request<void>(`/api/v1/hosts/${id}`, { method: "DELETE" });
  },
  toggleFavorite(id: string) {
    return request<{ is_favorite: boolean }>(`/api/v1/hosts/${id}/favorite`, { method: "POST" });
  },
  touch(id: string) {
    return request<void>(`/api/v1/hosts/${id}/touch`, { method: "POST" });
  },
};

// =====================================================================
// Connection history
// =====================================================================

export const historyApi = {
  list(opts: { host_id?: string; limit?: number; offset?: number } = {}) {
    const params = new URLSearchParams();
    if (opts.host_id) params.set("host_id", opts.host_id);
    if (opts.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts.offset !== undefined) params.set("offset", String(opts.offset));
    const qs = params.toString();
    return request<PaginatedResult<ConnectionHistoryEntry>>(`/api/v1/history${qs ? "?" + qs : ""}`);
  },
  start(host_id: string) {
    return request<{ id: number }>(`/api/v1/history/start`, { method: "POST", body: { host_id } });
  },
  end(id: number, status: ConnectionStatus, opts: { error_message?: string; bytes_in?: number; bytes_out?: number } = {}) {
    return request<void>(`/api/v1/history/${id}/end`, { method: "POST", body: { status, ...opts } });
  },
  deleteOlderThan(isoDate: string) {
    return request<{ removed: number }>(`/api/v1/history?older_than=${encodeURIComponent(isoDate)}`, { method: "DELETE" });
  },
};
