/**
 * Admin user management (Phase 1 UI).
 *
 * List, create (with any role), change role / active state, and delete users.
 * Reachable only by admin / super_admin (route + sidebar are role-gated, and
 * the backend enforces it too).
 */
import { useEffect, useState, type FormEvent } from "react";
import { UserPlus, Loader2, AlertCircle, Trash2, ShieldCheck, X } from "lucide-react";

import { usersAdminApi, ROLES, type AdminUser, type Role } from "./usersAdminApi";
import { useAuthStore } from "@/modules/auth/store/authStore";
import { ApiError } from "@/shared/lib/api";

const ROLE_LABEL: Record<Role, string> = {
  super_admin: "Super admin",
  admin: "Admin",
  user: "User",
  readonly: "Read-only",
  auditor: "Auditor",
};

export function UsersPage() {
  const me = useAuthStore((s) => s.user);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const msg = (e: unknown) => (e instanceof ApiError ? humanize(e.message) : e instanceof Error ? e.message : "error");

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

  useEffect(() => { void load(); }, []);

  async function changeRole(u: AdminUser, role: Role) {
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
        <button onClick={() => setShowCreate(true)} className="btn-primary">
          <UserPlus className="size-4" /> Add user
        </button>
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
                        onChange={(e) => changeRole(u, e.target.value as Role)}
                        className="input text-xs py-1"
                        title={isSelf ? "You can't change your own role" : ""}
                      >
                        {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                      </select>
                    </td>
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
                <tr><td colSpan={4} className="px-4 py-8 text-center text-fg-muted text-sm">No users</td></tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {showCreate && (
        <CreateUserModal
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); void load(); }}
          onError={setError}
        />
      )}
    </div>
  );
}

function CreateUserModal({ onClose, onCreated, onError }: {
  onClose: () => void;
  onCreated: () => void;
  onError: (m: string) => void;
}) {
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>("user");
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
          <select value={role} onChange={(e) => setRole(e.target.value as Role)} className="input w-full">
            {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
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
