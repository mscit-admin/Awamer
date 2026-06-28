/**
 * Role-based access control (RBAC).
 *
 * Every authenticated user can *view* their own inventory (hosts, folders,
 * tags, credential metadata, history). The capabilities below are the extra
 * powers granted on top of that baseline, mapped per role. The same matrix is
 * mirrored in the desktop/web client (shared/lib/permissions.ts) for UI
 * gating, but the server is the source of truth and enforces it.
 */
import type { Role } from "./index.js";

export const PERMISSIONS = [
  "resources:write",    // create / edit / delete hosts, credentials, folders, tags
  "sessions:connect",   // open SSH / SFTP sessions
  "credentials:reveal", // read a credential's decrypted secret
  "users:manage",       // admin user management
  "audit:read",         // view audit logs
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const ALL: Permission[] = [...PERMISSIONS];

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  super_admin: ALL,
  admin: ALL,
  // Full self-service over own resources, but no user administration.
  user: ["resources:write", "sessions:connect", "credentials:reveal"],
  // Browse-only: can view the inventory, cannot modify, connect, or reveal secrets.
  readonly: [],
  // Like read-only, plus access to audit logs.
  auditor: ["audit:read"],
};

export function permissionsFor(role: string): Permission[] {
  return ROLE_PERMISSIONS[role as Role] ?? [];
}

export function can(role: string, perm: Permission): boolean {
  return permissionsFor(role).includes(perm);
}
