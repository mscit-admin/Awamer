/**
 * Admin user-management API client (admin / super_admin only).
 * Wraps /api/v1/admin/users.
 */
import { request } from "@/shared/lib/api";

export const ROLES = ["super_admin", "admin", "user", "readonly", "auditor"] as const;
export type Role = (typeof ROLES)[number];

export interface AdminUser {
  id: string;
  username: string;
  email: string;
  full_name: string | null;
  role: Role;
  is_active: boolean;
  is_locked: boolean;
  mfa_enabled: boolean;
  last_login_at: string | null;
  created_at: string;
}

export interface CreateUserInput {
  username: string;
  email: string;
  password: string;
  full_name?: string;
  role: Role;
}

export const usersAdminApi = {
  list() {
    return request<{ data: AdminUser[]; total: number }>("/api/v1/admin/users");
  },
  create(input: CreateUserInput) {
    return request<AdminUser>("/api/v1/admin/users", { method: "POST", body: input });
  },
  update(id: string, patch: Partial<Pick<AdminUser, "full_name" | "email" | "role" | "is_active" | "is_locked">>) {
    return request<AdminUser>(`/api/v1/admin/users/${id}`, { method: "PATCH", body: patch });
  },
  remove(id: string) {
    return request<void>(`/api/v1/admin/users/${id}`, { method: "DELETE" });
  },
};
