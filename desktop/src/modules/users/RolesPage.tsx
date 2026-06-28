/**
 * Roles & Permissions reference.
 *
 * Shows the RBAC matrix (which role grants which capability) and highlights
 * the current user's role + effective permissions. Roles are fixed (built-in)
 * for now, so this is a read-only reference rather than an editor.
 */
import { ShieldCheck, Check, Minus } from "lucide-react";
import {
  PERMISSIONS, ROLES, ROLE_LABEL, PERMISSION_LABEL, roleCan, permissionsFor,
} from "@/shared/lib/permissions";
import { useAuthStore } from "@/modules/auth/store/authStore";

export function RolesPage() {
  const myRole = useAuthStore((s) => s.user?.role) ?? "";
  const myPerms = permissionsFor(myRole);

  return (
    <div className="max-w-4xl mx-auto py-6 px-4 animate-fade-in">
      <div className="flex items-center gap-3 mb-6">
        <div className="size-10 rounded-md bg-bg-elevated border border-border grid place-items-center">
          <ShieldCheck className="size-5 text-accent" />
        </div>
        <div>
          <h1 className="text-xl font-semibold leading-tight">Roles &amp; Permissions</h1>
          <p className="text-sm text-fg-muted mt-0.5">What each role is allowed to do. Enforced by the server.</p>
        </div>
      </div>

      <div className="card p-4 mb-6">
        <div className="text-xs text-fg-muted mb-1">Your role</div>
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium px-2 py-0.5 rounded-full bg-accent/15 border border-accent/30 text-accent">
            {ROLE_LABEL[(myRole as keyof typeof ROLE_LABEL)] ?? (myRole || "—")}
          </span>
          <span className="text-xs text-fg-muted">
            {myPerms.length === 0 ? "view-only access" : `${myPerms.length} extra capabilit${myPerms.length === 1 ? "y" : "ies"}`}
          </span>
        </div>
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-2xs uppercase text-fg-muted border-b border-border">
            <tr>
              <th className="text-left font-medium px-4 py-2 min-w-[260px]">Capability</th>
              {ROLES.map((r) => (
                <th key={r} className={"font-medium px-3 py-2 text-center " + (r === myRole ? "text-accent" : "")}>
                  {ROLE_LABEL[r]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {/* Baseline row: everyone can view. */}
            <tr className="border-b border-border/50">
              <td className="px-4 py-2">View inventory (hosts, folders, tags, history, credential metadata)</td>
              {ROLES.map((r) => (
                <td key={r} className="px-3 py-2 text-center"><Check className="size-4 text-emerald-400 inline" /></td>
              ))}
            </tr>
            {PERMISSIONS.map((p) => (
              <tr key={p} className="border-b border-border/50">
                <td className="px-4 py-2">{PERMISSION_LABEL[p]}</td>
                {ROLES.map((r) => (
                  <td key={r} className={"px-3 py-2 text-center " + (r === myRole ? "bg-accent/5" : "")}>
                    {roleCan(r, p)
                      ? <Check className="size-4 text-emerald-400 inline" />
                      : <Minus className="size-3.5 text-fg-subtle inline" />}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-fg-muted mt-4 leading-relaxed">
        Roles are assigned per user on the <strong>Users</strong> page. The set of
        roles is built-in; custom roles and finer-grained permissions are a future
        enhancement.
      </p>
    </div>
  );
}
