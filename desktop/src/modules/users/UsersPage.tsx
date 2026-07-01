/**
 * Admin user management (Phase 1 UI).
 *
 * List, create (with any role), change role / active state, and delete users.
 * Reachable only by admin / super_admin (route + sidebar are role-gated, and
 * the backend enforces it too).
 */
import { useEffect, useState, type FormEvent } from "react";
import { UserPlus, Loader2, AlertCircle, Trash2, ShieldCheck, X, Download, Building2, Check } from "lucide-react";

import { usersAdminApi, type AdminUser } from "./usersAdminApi";
import { rolesApi } from "./rolesApi";
import { exportUsersCsv, exportUsersJson } from "./exportUsers";
import { orgApi, type Company, type OrgUnit } from "@/modules/org/orgApi";
import { useAuthStore } from "@/modules/auth/store/authStore";
import { useCan } from "@/shared/lib/permissions";
import { ApiError } from "@/shared/lib/api";

export interface RoleOption { key: string; name: string }

export function UsersPage() {
  const me = useAuthStore((s) => s.user);
  const canOrg = useCan("org:manage");
  const canCompanies = useCan("companies:manage");
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [roleOpts, setRoleOpts] = useState<RoleOption[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [assigning, setAssigning] = useState<AdminUser | null>(null);
  const companyName = (id: string | null) => companies.find((c) => c.id === id)?.name ?? (id ? "—" : "Unassigned");

  const msg = (e: unknown) => (e instanceof ApiError ? humanize(e.message) : e instanceof Error ? e.message : "error");
  const roleLabel = (key: string) => roleOpts.find((o) => o.key === key)?.name ?? key;

  async function load() {
    setLoading(true);
    try {
      const res = await usersAdminApi.list();
      setUsers(res.data);
      setError(null);
    } catch (e) {
      setError(msg(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    rolesApi.list().then((r) => setRoleOpts(r.data.map((x) => ({ key: x.key, name: x.name })))).catch(() => {});
    if (canOrg) orgApi.listCompanies().then(setCompanies).catch(() => {});
  }, [canOrg]);

  async function changeRole(u: AdminUser, role: string) {
    try { await usersAdminApi.update(u.id, { role }); await load(); }
    catch (e) { setError(msg(e)); }
  }

  async function toggleActive(u: AdminUser) {
    try { await usersAdminApi.update(u.id, { is_active: !u.is_active }); await load(); }
    catch (e) { setError(msg(e)); }
  }

  async function remove(u: AdminUser) {
    if (!window.confirm(`Delete user "${u.username}"? This cannot be undone.`)) return;
    try { await usersAdminApi.remove(u.id); await load(); }
    catch (e) { setError(msg(e)); }
  }

  return (
    <div className="max-w-4xl mx-auto py-6 px-4 animate-fade-in">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold">Users</h1>
          <p className="text-sm text-fg-muted mt-0.5">Manage accounts and roles.</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => exportUsersCsv(users)}
            disabled={users.length === 0}
            className="btn-ghost text-xs"
            title="Export the user list as CSV"
          >
            <Download className="size-3.5" /> CSV
          </button>
          <button
            onClick={() => exportUsersJson(users)}
            disabled={users.length === 0}
            className="btn-ghost text-xs"
            title="Export the user list as JSON"
          >
            <Download className="size-3.5" /> JSON
          </button>
          <button onClick={() => setShowCreate(true)} className="btn-primary">
            <UserPlus className="size-4" /> Add user
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-4 px-3 py-2 bg-red-500/10 border border-red-500/30 text-red-300 text-xs rounded flex items-center gap-2">
          <AlertCircle className="size-3.5" /> {error}
          <button onClick={() => setError(null)} className="ml-auto"><X className="size-3" /></button>
        </div>
      )}

      <div className="card overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-fg-muted text-sm flex items-center justify-center gap-2">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-2xs uppercase text-fg-muted border-b border-border">
              <tr>
                <th className="text-left font-medium px-4 py-2">User</th>
                <th className="text-left font-medium px-4 py-2 w-40">Role</th>
                {canOrg && <th className="text-left font-medium px-4 py-2 w-48">Organization</th>}
                <th className="text-left font-medium px-4 py-2 w-24">Status</th>
                <th className="px-4 py-2 w-20"></th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const isSelf = u.id === me?.id;
                return (
                  <tr key={u.id} className="border-b border-border/50 hover:bg-bg-elevated/40">
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-2">
                        <div className="size-7 rounded-full bg-accent/20 border border-accent/30 grid place-items-center text-xs font-mono text-accent">
                          {u.username[0]?.toUpperCase()}
                        </div>
                        <div className="min-w-0">
                          <div className="font-medium truncate">{u.username}{isSelf && <span className="text-fg-subtle font-normal"> (you)</span>}</div>
                          <div className="text-xs text-fg-muted truncate">{u.email}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-2">
                      <select
                        value={u.role}
                        disabled={isSelf}
                        onChange={(e) => changeRole(u, e.target.value)}
                        className="input text-xs py-1"
                        title={isSelf ? "You can't change your own role" : ""}
                      >
                        {roleOpts.length === 0 && <option value={u.role}>{roleLabel(u.role)}</option>}
                        {roleOpts.map((r) => <option key={r.key} value={r.key}>{r.name}</option>)}
                      </select>
                    </td>
                    {canOrg && (
                      <td className="px-4 py-2">
                        <button
                          onClick={() => setAssigning(u)}
                          className="flex items-center gap-1.5 text-xs px-2 py-1 rounded border border-border hover:bg-bg-elevated text-fg-muted max-w-full"
                          title="Assign to a company / org unit"
                        >
                          <Building2 className="size-3.5 shrink-0" />
                          <span className="truncate">{companyName(u.company_id)}</span>
                        </button>
                      </td>
                    )}
                    <td className="px-4 py-2">
                      <button
                        onClick={() => !isSelf && toggleActive(u)}
                        disabled={isSelf}
                        className={"text-xs px-2 py-0.5 rounded-full border " + (u.is_active
                          ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-300"
                          : "bg-fg-subtle/10 border-border text-fg-muted")}
                      >
                        {u.is_active ? "Active" : "Disabled"}
                      </button>
                    </td>
                    <td className="px-4 py-2 text-right">
                      {!isSelf && (
                        <button onClick={() => remove(u)} className="p-1 hover:bg-bg rounded text-red-400" title="Delete">
                          <Trash2 className="size-3.5" />
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {users.length === 0 && (
                <tr><td colSpan={canOrg ? 5 : 4} className="px-4 py-8 text-center text-fg-muted text-sm">No users</td></tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {showCreate && (
        <CreateUserModal
          roleOpts={roleOpts}
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); void load(); }}
          onError={setError}
        />
      )}

      {assigning && (
        <AssignOrgModal
          user={assigning}
          companies={companies}
          canPickCompany={canCompanies}
          onClose={() => setAssigning(null)}
          onSaved={() => { setAssigning(null); void load(); }}
          onError={setError}
        />
      )}
    </div>
  );
}

/** Flatten an org-unit tree into indented options (depth-first) for a <select>. */
function flattenUnits(units: OrgUnit[]): { unit: OrgUnit; depth: number }[] {
  const kids = new Map<string | null, OrgUnit[]>();
  for (const u of units) {
    const k = u.parentId ?? null;
    (kids.get(k) ?? kids.set(k, []).get(k)!).push(u);
  }
  const out: { unit: OrgUnit; depth: number }[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const u of (kids.get(parent) ?? []).sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name))) {
      out.push({ unit: u, depth });
      walk(u.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

function AssignOrgModal({ user, companies, canPickCompany, onClose, onSaved, onError }: {
  user: AdminUser;
  companies: Company[];
  canPickCompany: boolean;
  onClose: () => void;
  onSaved: () => void;
  onError: (m: string) => void;
}) {
  const [companyId, setCompanyId] = useState<string>(user.company_id ?? companies[0]?.id ?? "");
  const [unitId, setUnitId] = useState<string>(user.org_unit_id ?? "");
  const [units, setUnits] = useState<OrgUnit[]>([]);
  const [loadingUnits, setLoadingUnits] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!companyId) { setUnits([]); return; }
    setLoadingUnits(true);
    orgApi.listUnits(companyId)
      .then((us) => { setUnits(us); if (!us.some((u) => u.id === unitId)) setUnitId(""); })
      .catch((e) => onError(e instanceof ApiError ? e.message : "failed to load units"))
      .finally(() => setLoadingUnits(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId]);

  async function save() {
    setBusy(true);
    try {
      await orgApi.assignUser(user.id, {
        company_id: canPickCompany ? (companyId || null) : undefined,
        org_unit_id: unitId || null,
      });
      onSaved();
    } catch (e) {
      onError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : "assign failed");
    } finally {
      setBusy(false);
    }
  }

  const flat = flattenUnits(units);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="card p-5 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 mb-1">
          <Building2 className="size-4 text-accent" />
          <h2 className="text-base font-semibold">Assign to organization</h2>
        </div>
        <p className="text-xs text-fg-muted mb-4">Set the company and org unit for <span className="font-medium">{user.username}</span>.</p>

        <label className="block text-xs text-fg-muted mb-1">Company</label>
        {canPickCompany ? (
          <select value={companyId} onChange={(e) => setCompanyId(e.target.value)} className="input w-full mb-3">
            <option value="">— Unassigned —</option>
            {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        ) : (
          <div className="input w-full mb-3 opacity-70">{companies.find((c) => c.id === companyId)?.name ?? "your company"}</div>
        )}

        <label className="block text-xs text-fg-muted mb-1">Org unit</label>
        <select value={unitId} onChange={(e) => setUnitId(e.target.value)} disabled={!companyId || loadingUnits} className="input w-full">
          <option value="">— None (company only) —</option>
          {flat.map(({ unit, depth }) => (
            <option key={unit.id} value={unit.id}>{`${"  ".repeat(depth)}${depth ? "└ " : ""}${unit.name} (${unit.kind})`}</option>
          ))}
        </select>
        {loadingUnits && <div className="text-2xs text-fg-muted mt-1 flex items-center gap-1"><Loader2 className="size-3 animate-spin" /> loading units…</div>}

        <div className="flex justify-end gap-2 mt-5">
          <button onClick={onClose} className="btn-ghost text-sm">Cancel</button>
          <button onClick={save} disabled={busy} className="btn-primary text-sm inline-flex gap-1">
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />} Save
          </button>
        </div>
      </div>
    </div>
  );
}

function CreateUserModal({ roleOpts, onClose, onCreated, onError }: {
  roleOpts: RoleOption[];
  onClose: () => void;
  onCreated: () => void;
  onError: (m: string) => void;
}) {
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<string>("user");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    if (password.length < 12) { setErr("Password must be at least 12 characters (with upper, lower, digit, symbol)."); return; }
    setBusy(true);
    try {
      await usersAdminApi.create({ username, email, password, full_name: fullName || undefined, role });
      onCreated();
    } catch (e2) {
      const m = e2 instanceof ApiError ? humanize(e2.message) : e2 instanceof Error ? e2.message : "Could not create user";
      setErr(m);
      onError(m);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-bg/80 flex items-center justify-center p-4">
      <form onSubmit={submit} className="card p-5 w-full max-w-md space-y-3">
        <div className="flex items-center gap-2 mb-1">
          <ShieldCheck className="size-4 text-accent" />
          <h2 className="text-base font-semibold">Add user</h2>
        </div>
        <div>
          <label className="block text-xs text-fg-muted mb-1">Username</label>
          <input value={username} onChange={(e) => setUsername(e.target.value)} className="input w-full" required minLength={3} />
        </div>
        <div>
          <label className="block text-xs text-fg-muted mb-1">Email</label>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="input w-full" required />
        </div>
        <div>
          <label className="block text-xs text-fg-muted mb-1">Full name (optional)</label>
          <input value={fullName} onChange={(e) => setFullName(e.target.value)} className="input w-full" />
        </div>
        <div>
          <label className="block text-xs text-fg-muted mb-1">Temporary password</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} className="input w-full" required
            placeholder="≥12 chars, mixed classes" autoComplete="new-password" />
        </div>
        <div>
          <label className="block text-xs text-fg-muted mb-1">Role</label>
          <select value={role} onChange={(e) => setRole(e.target.value)} className="input w-full">
            {(roleOpts.length ? roleOpts : [{ key: "user", name: "User" }]).map((r) => <option key={r.key} value={r.key}>{r.name}</option>)}
          </select>
        </div>

        {err && <div className="px-3 py-2 bg-red-500/10 border border-red-500/30 text-red-300 text-xs rounded">{err}</div>}

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="btn-ghost text-xs">Cancel</button>
          <button type="submit" disabled={busy} className="btn-primary text-xs">
            {busy ? <><Loader2 className="size-3.5 animate-spin" /> Creating…</> : "Create user"}
          </button>
        </div>
      </form>
    </div>
  );
}

function humanize(code: string): string {
  switch (code) {
    case "username_taken": return "That username is already taken.";
    case "email_taken": return "That email is already in use.";
    case "weak_password": return "Password must be ≥12 chars with upper, lower, digit, and symbol.";
    case "invalid_role": return "Invalid role.";
    case "forbidden": return "You don't have permission to manage users.";
    default: return code || "Request failed.";
  }
}
