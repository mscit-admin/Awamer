/**
 * Admin user-management API client (admin / super_admin only).
 * Wraps /api/v1/admin/users.
 */
import { request } from "@/shared/lib/api";

// Role keys are dynamic (admin-managed). These built-ins are only a fallback
// for the create form when the roles list hasn't loaded.
export const ROLES = ["super_admin", "admin", "user", "readonly", "auditor"] as const;
export type Role = string;

export interface AdminUser {
  id: string;
  username: string;
  email: string;
  full_name: string | null;
  role: string;
  is_active: boolean;
  is_locked: boolean;
  mfa_enabled: boolean;
  company_id: string | null;
  org_unit_id: string | null;
  last_login_at: string | null;
  created_at: string;
}

export interface CreateUserInput {
  username: string;
  email: string;
  password: string;
  full_name?: string;
  role: string;
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
  resetPassword(id: string, password: string) {
    return request<{ ok: true }>(`/api/v1/admin/users/${id}/reset-password`, { method: "POST", body: { password } });
  },
  /** ASVS V6.4.6: email the user a single-use reset link (the admin never picks the password). */
  sendResetLink(id: string) {
    return request<{ ok: boolean }>(`/api/v1/admin/users/${id}/send-reset-link`, { method: "POST" });
  },
  disableMfa(id: string) {
    return request<{ ok: true }>(`/api/v1/admin/users/${id}/disable-mfa`, { method: "POST" });
  },
};
