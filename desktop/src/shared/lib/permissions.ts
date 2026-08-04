/**
 * Client-side permission checks.
 *
 * Roles are dynamic (admin-managed on the server), so the client no longer
 * hardcodes a role→permission matrix. Instead the server sends the current
 * user's *effective* permissions in the user payload, and the UI gates
 * affordances off that list. The server still enforces everything — this is
 * presentation only.
 */
import { useAuthStore } from "@/modules/auth/store/authStore";

export const PERMISSIONS = [
  "resources:write",
  "sessions:connect",
  "credentials:reveal",
  "tunnels:manage",
  "backup:manage",
  "command_history:read",
  "users:manage",
  "audit:read",
  "companies:manage",
  "org:manage",
  "ai:use",
  "ai:manage",
  "ai:use_personal",
  "vpn:manage",
  "vpn:reveal",
  "vpn_server:manage",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/** Does the current user hold a permission?
 *  If the server hasn't sent an effective-permissions list (older session or
 *  backend), we don't gate the UI — the server still enforces every action. */
export function useCan(perm: Permission): boolean {
  const perms = useAuthStore((s) => s.user?.permissions);
  if (!Array.isArray(perms)) return true;
  return perms.includes(perm);
}

/** Non-hook check against an explicit permission list (e.g. the current user's). */
export function hasPerm(perms: readonly string[] | undefined | null, perm: Permission): boolean {
  return Array.isArray(perms) && perms.includes(perm);
}
