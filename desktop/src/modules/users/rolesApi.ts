/** Roles API — list roles + permission catalog; admins can CRUD custom roles. */
import { request } from "@/shared/lib/api";

export interface RoleRecord {
  id: string;
  key: string;
  name: string;
  description: string | null;
  permissions: string[];
  isBuiltin: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PermissionCatalogItem {
  key: string;
  label: string;
  description: string;
}

export const rolesApi = {
  list() {
    return request<{ data: RoleRecord[]; catalog: PermissionCatalogItem[] }>("/api/v1/roles");
  },
  create(input: { name: string; description?: string | null; permissions: string[] }) {
    return request<RoleRecord>("/api/v1/roles", { method: "POST", body: input });
  },
  update(id: string, patch: { name?: string; description?: string | null; permissions?: string[] }) {
    return request<RoleRecord>(`/api/v1/roles/${id}`, { method: "PATCH", body: patch });
  },
  remove(id: string) {
    return request<{ ok: boolean }>(`/api/v1/roles/${id}`, { method: "DELETE" });
  },
};
