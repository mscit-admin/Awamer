/**
 * Client-side mirror of the backend RBAC matrix
 * (backend/src/domain/permissions.ts). Used to gate UI affordances so users
 * don't see actions their role can't perform. The server still enforces all
 * of this — this is presentation only.
 */
import { useAuthStore } from "@/modules/auth/store/authStore";

export const PERMISSIONS = [
  "resources:write",
  "sessions:connect",
  "credentials:reveal",
  "tunnels:manage",
  "backup:manage",
  "users:manage",
  "audit:read",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const ROLES = ["super_admin", "admin", "user", "readonly", "auditor"] as const;
export type Role = (typeof ROLES)[number];

const ALL: Permission[] = [...PERMISSIONS];

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  super_admin: ALL,
  admin: ALL,
  user: ["resources:write", "sessions:connect", "credentials:reveal", "tunnels:manage", "backup:manage"],
  readonly: [],
  auditor: ["audit:read"],
};

export const ROLE_LABEL: Record<Role, string> = {
  super_admin: "Super admin",
  admin: "Admin",
  user: "User",
  readonly: "Read-only",
  auditor: "Auditor",
};

export const PERMISSION_LABEL: Record<Permission, string> = {
  "resources:write": "Create / edit / delete hosts, credentials, folders, tags",
  "sessions:connect": "Open SSH / SFTP sessions",
  "credentials:reveal": "Reveal credential secrets",
  "tunnels:manage": "Create & use SSH port-forwarding tunnels",
  "backup:manage": "Export & restore backups",
  "users:manage": "Manage users",
  "audit:read": "View audit logs",
};

export function permissionsFor(role: string | undefined | null): Permission[] {
  if (!role) return [];
  return ROLE_PERMISSIONS[role as Role] ?? [];
}

export function roleCan(role: string | undefined | null, perm: Permission): boolean {
  return permissionsFor(role).includes(perm);
}

/** Hook: does the *current* user have a permission? */
export function useCan(perm: Permission): boolean {
  const role = useAuthStore((s) => s.user?.role);
  return roleCan(role, perm);
}
