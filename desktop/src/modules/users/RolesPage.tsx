/**
 * Roles & Permissions.
 *
 * Shows the role → permission matrix and lets admins (users:manage) create,
 * edit and delete custom roles. Built-in roles are shown locked. Permissions
 * come from the server's fixed catalog; the server enforces everything.
 */
import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  ShieldCheck, Check, Minus, Plus, Pencil, Trash2, Lock, Loader2, AlertCircle, X,
} from "lucide-react";
import { rolesApi, type RoleRecord, type PermissionCatalogItem } from "./rolesApi";
import { useAuthStore } from "@/modules/auth/store/authStore";
import { useCan } from "@/shared/lib/permissions";
import { ApiError } from "@/shared/lib/api";

export function RolesPage() {
  const myRole = useAuthStore((s) => s.user?.role) ?? "";
  const canManage = useCan("users:manage");

  const [roles, setRoles] = useState<RoleRecord[]>([]);
  const [catalog, setCatalog] = useState<PermissionCatalogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<RoleRecord | "new" | null>(null);

  async function load() {
    setLoading(true);
    try {
      const r = await rolesApi.list();
      setRoles(r.data);
      setCatalog(r.catalog);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void load(); }, []);

  async function remove(role: RoleRecord) {
    if (!window.confirm(`Delete role "${role.name}"? This cannot be undone.`)) return;
    try { await rolesApi.remove(role.id); await load(); }
    catch (e) { setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : "delete failed"); }
  }

  return (
    <div className="max-w-5xl mx-auto py-6 px-4 animate-fade-in">
      <div className="flex items-center justify-between mb-6 gap-3">
        <div className="flex items-center gap-3">
          <div className="size-10 rounded-md bg-bg-elevated border border-border grid place-items-center">
            <ShieldCheck className="size-5 text-accent" />
          </div>
          <div>
            <h1 className="text-xl font-semibold leading-tight">Roles &amp; Permissions</h1>
            <p className="text-sm text-fg-muted mt-0.5">What each role can do. Enforced by the server.</p>
          </div>
        </div>
        {canManage && (
          <button onClick={() => setEditing("new")} className="btn-primary"><Plus className="size-4" /> New role</button>
        )}
      </div>

      {error && (
        <div className="mb-4 px-3 py-2 bg-red-500/10 border border-red-500/30 text-red-300 text-xs rounded flex items-center gap-2">
          <AlertCircle className="size-3.5" /> {error}
          <button onClick={() => setError(null)} className="ml-auto"><X className="size-3" /></button>
        </div>
      )}

      {loading ? (
        <div className="card p-8 text-center text-fg-muted text-sm flex items-center justify-center gap-2">
          <Loader2 className="size-4 animate-spin" /> Loading…
        </div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-2xs uppercase text-fg-muted border-b border-border">
              <tr>
                <th className="text-left font-medium px-4 py-2 min-w-[240px]">Capability</th>
                {roles.map((r) => (
                  <th key={r.id} className={"font-medium px-3 py-2 text-center " + (r.key === myRole ? "text-accent" : "")}>
                    <div className="flex items-center justify-center gap-1">
                      {r.isBuiltin && <Lock className="size-3 text-fg-subtle" />}
                      {r.name}
                    </div>
                    {canManage && !r.isBuiltin && (
                      <div className="flex items-center justify-center gap-1 mt-1">
                        <button onClick={() => setEditing(r)} className="btn-ghost p-1" title="Edit"><Pencil className="size-3" /></button>
                        <button onClick={() => remove(r)} className="btn-ghost p-1 text-red-400" title="Delete"><Trash2 className="size-3" /></button>
                      </div>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-border/50">
                <td className="px-4 py-2">View inventory (hosts, folders, tags, history, credential metadata)</td>
                {roles.map((r) => (
                  <td key={r.id} className="px-3 py-2 text-center"><Check className="size-4 text-emerald-400 inline" /></td>
                ))}
              </tr>
              {catalog.map((p) => (
                <tr key={p.key} className="border-b border-border/50">
                  <td className="px-4 py-2" title={p.description}>{p.label}</td>
                  {roles.map((r) => (
                    <td key={r.id} className={"px-3 py-2 text-center " + (r.key === myRole ? "bg-accent/5" : "")}>
                      {r.permissions.includes(p.key)
                        ? <Check className="size-4 text-emerald-400 inline" />
                        : <Minus className="size-3.5 text-fg-subtle inline" />}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-fg-muted mt-4 leading-relaxed">
        Built-in roles (<Lock className="size-3 inline" />) are locked. Custom roles can be created and edited above;
        a role can't be deleted while users are still assigned to it. Roles are assigned per user on the{" "}
        <strong>Users</strong> page.
      </p>

      {editing && (
        <RoleEditor
          role={editing === "new" ? null : editing}
          catalog={catalog}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); void load(); }}
        />
      )}
    </div>
  );
}

function RoleEditor({
  role, catalog, onClose, onSaved,
}: {
  role: RoleRecord | null;
  catalog: PermissionCatalogItem[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(role?.name ?? "");
  const [description, setDescription] = useState(role?.description ?? "");
  const [perms, setPerms] = useState<Set<string>>(new Set(role?.permissions ?? []));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (key: string) => setPerms((s) => {
    const next = new Set(s);
    next.has(key) ? next.delete(key) : next.add(key);
    return next;
  });

  const previewKey = useMemo(() => name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, ""), [name]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const body = { name: name.trim(), description: description.trim() || null, permissions: [...perms] };
      if (role) await rolesApi.update(role.id, body);
      else await rolesApi.create(body);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : "save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4" onClick={onClose}>
      <form onClick={(e) => e.stopPropagation()} onSubmit={save} className="card p-5 w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold">{role ? `Edit role: ${role.name}` : "New role"}</h2>
          <button type="button" onClick={onClose} className="btn-ghost p-1"><X className="size-4" /></button>
        </div>

        <label className="block text-xs text-fg-muted mb-1">Name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={48} placeholder="e.g. Operator" className="input w-full mb-1" autoFocus />
        {!role && previewKey && <p className="text-2xs text-fg-subtle mb-3">key: <span className="font-mono">{previewKey}</span></p>}

        <label className="block text-xs text-fg-muted mb-1 mt-2">Description</label>
        <input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={200} placeholder="Optional" className="input w-full mb-4" />

        <div className="text-xs text-fg-muted mb-2">Permissions</div>
        <div className="space-y-1.5 mb-4">
          {catalog.map((p) => (
            <label key={p.key} className="flex items-start gap-2 text-sm p-2 rounded hover:bg-bg-elevated/50 cursor-pointer">
              <input type="checkbox" checked={perms.has(p.key)} onChange={() => toggle(p.key)} className="accent-accent mt-0.5" />
              <span>
                {p.label}
                <span className="block text-2xs text-fg-muted">{p.description}</span>
              </span>
            </label>
          ))}
        </div>

        {error && <div className="mb-3 px-3 py-2 bg-red-500/10 border border-red-500/30 text-red-300 text-xs rounded flex items-center gap-2"><AlertCircle className="size-3.5" /> {error}</div>}

        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
          <button type="submit" disabled={busy || !name.trim()} className="btn-primary">
            {busy ? <><Loader2 className="size-4 animate-spin" /> Saving…</> : (role ? "Save changes" : "Create role")}
          </button>
        </div>
      </form>
    </div>
  );
}
