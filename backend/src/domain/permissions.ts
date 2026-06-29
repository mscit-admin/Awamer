/**
 * Role-based access control (RBAC).
 *
 * PERMISSIONS is the fixed, code-defined catalog of capabilities the server
 * actually enforces — new permissions are added here when a feature needs one
 * (see CLAUDE.md). ROLES, by contrast, are dynamic: they live in the `roles`
 * table and an admin can create roles granting any subset of this catalog.
 *
 * `can()` / `permissionsFor()` resolve a role's permissions through a swappable
 * resolver. At startup the server installs a DB-backed resolver
 * (setPermissionResolver); until then (and in unit tests) a static fallback
 * built from the seeded built-in roles is used.
 */
import { BUILTIN_ROLE_KEYS } from "./index.js";

export const PERMISSIONS = [
  "resources:write",    // create / edit / delete hosts, credentials, folders, tags
  "sessions:connect",   // open SSH / SFTP sessions
  "credentials:reveal", // read a credential's decrypted secret
  "tunnels:manage",     // create / use SSH port-forwarding tunnels
  "backup:manage",      // export / restore backups of own data
  "users:manage",       // admin user management
  "audit:read",         // view audit logs
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/** Human-readable catalog, served to the UI so it can render the role editor. */
export const PERMISSION_META: Record<Permission, { label: string; description: string }> = {
  "resources:write":    { label: "Manage resources", description: "Create, edit and delete hosts, credentials, folders and tags" },
  "sessions:connect":   { label: "Open sessions", description: "Open SSH / SFTP / VNC sessions" },
  "credentials:reveal": { label: "Reveal secrets", description: "View a credential's decrypted secret" },
  "tunnels:manage":     { label: "Manage tunnels", description: "Create and use SSH port-forwarding tunnels" },
  "backup:manage":      { label: "Backup & restore", description: "Export and restore backups of own data" },
  "users:manage":       { label: "Manage users", description: "Create, edit and delete user accounts and roles" },
  "audit:read":         { label: "View audit log", description: "Read the audit log" },
};

const ALL: Permission[] = [...PERMISSIONS];

/** Seed definitions for the built-in roles (also the static fallback matrix). */
export const BUILTIN_ROLES: { key: string; name: string; description: string; permissions: Permission[] }[] = [
  { key: "super_admin", name: "Super admin", description: "Full access to everything.", permissions: ALL },
  { key: "admin",       name: "Admin",       description: "Full access to everything.", permissions: ALL },
  { key: "user",        name: "User",        description: "Self-service over own resources; no user administration.",
    permissions: ["resources:write", "sessions:connect", "credentials:reveal", "tunnels:manage", "backup:manage"] },
  { key: "readonly",    name: "Read-only",   description: "Browse the inventory; cannot modify, connect, or reveal secrets.", permissions: [] },
  { key: "auditor",     name: "Auditor",     description: "Read-only plus access to audit logs.", permissions: ["audit:read"] },
];

export function isPermission(s: string): s is Permission {
  return (PERMISSIONS as readonly string[]).includes(s);
}

// --- Swappable resolver -----------------------------------------------------

const staticMatrix: Record<string, Permission[]> = Object.fromEntries(
  BUILTIN_ROLES.map((r) => [r.key, r.permissions]),
);
void BUILTIN_ROLE_KEYS; // (kept for documentation/parity with domain)

let resolver: (roleKey: string) => readonly string[] = (key) => staticMatrix[key] ?? [];

/** Install a resolver (e.g. DB-backed). Pass null to revert to the static one. */
export function setPermissionResolver(fn: ((roleKey: string) => readonly string[]) | null): void {
  resolver = fn ?? ((key) => staticMatrix[key] ?? []);
}

export function permissionsFor(role: string): readonly string[] {
  return resolver(role);
}

export function can(role: string, perm: Permission): boolean {
  return resolver(role).includes(perm);
}
