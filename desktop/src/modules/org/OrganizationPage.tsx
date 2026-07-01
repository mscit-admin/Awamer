/**
 * Organization admin page.
 *
 * Super Admin (companies:manage) manages companies (tenants) in the left rail;
 * anyone with org:manage edits the selected company's org hierarchy
 * (departments → sections → units → …) as a tree on the right.
 */
import { useEffect, useMemo, useState } from "react";
import {
  Building2, Loader2, Plus, Trash2, Pencil, ChevronRight, ChevronDown,
  AlertCircle, Check, X,
} from "lucide-react";
import { orgApi, type Company, type OrgUnit } from "./orgApi";
import { useCan } from "@/shared/lib/permissions";
import { ApiError } from "@/shared/lib/api";

const KINDS = ["department", "section", "unit", "team", "branch", "office", "other"];

export function OrganizationPage() {
  const canCompanies = useCan("companies:manage");
  const canOrg = useCan("org:manage");

  const [companies, setCompanies] = useState<Company[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [units, setUnits] = useState<OrgUnit[]>([]);
  const [loading, setLoading] = useState(true);
  const [unitsLoading, setUnitsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newCompany, setNewCompany] = useState("");

  const say = (e: unknown) => setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : "Something went wrong");

  useEffect(() => {
    orgApi.listCompanies()
      .then((cs) => { setCompanies(cs); setSelected((cur) => cur ?? cs[0]?.id ?? null); })
      .catch(say)
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!selected) { setUnits([]); return; }
    setUnitsLoading(true);
    orgApi.listUnits(selected).then(setUnits).catch(say).finally(() => setUnitsLoading(false));
  }, [selected]);

  async function reloadUnits() {
    if (!selected) return;
    setUnits(await orgApi.listUnits(selected).catch((e) => { say(e); return units; }));
  }

  async function addCompany() {
    const name = newCompany.trim();
    if (!name) return;
    setError(null);
    try {
      const c = await orgApi.createCompany(name);
      setCompanies((cs) => [...cs, c].sort((a, b) => a.name.localeCompare(b.name)));
      setSelected(c.id);
      setNewCompany("");
    } catch (e) { say(e); }
  }

  async function renameCompany(c: Company) {
    const name = window.prompt("Company name", c.name)?.trim();
    if (!name || name === c.name) return;
    try { const u = await orgApi.updateCompany(c.id, { name }); setCompanies((cs) => cs.map((x) => x.id === c.id ? u : x)); }
    catch (e) { say(e); }
  }

  async function toggleActive(c: Company) {
    try { const u = await orgApi.updateCompany(c.id, { is_active: !c.is_active }); setCompanies((cs) => cs.map((x) => x.id === c.id ? u : x)); }
    catch (e) { say(e); }
  }

  async function deleteCompany(c: Company) {
    if (!window.confirm(`Delete company "${c.name}"? This removes its whole org structure.`)) return;
    try {
      await orgApi.deleteCompany(c.id);
      setCompanies((cs) => cs.filter((x) => x.id !== c.id));
      if (selected === c.id) setSelected((cur) => (companies.find((x) => x.id !== c.id)?.id ?? null) && cur === c.id ? companies.find((x) => x.id !== c.id)!.id : cur);
    } catch (e) { say(e); }
  }

  const selectedCompany = companies.find((c) => c.id === selected) ?? null;

  if (loading) {
    return <div className="px-8 py-8 text-sm text-fg-muted flex items-center gap-2"><Loader2 className="size-4 animate-spin" /> Loading…</div>;
  }

  return (
    <div className="px-6 py-6 animate-fade-in">
      <div className="flex items-center gap-3 mb-6">
        <div className="size-10 rounded-md bg-bg-elevated border border-border grid place-items-center">
          <Building2 className="size-5 text-accent" />
        </div>
        <div>
          <h1 className="text-xl font-semibold leading-tight">Organization</h1>
          <p className="text-sm text-fg-muted mt-0.5">Companies and their departments, sections and units.</p>
        </div>
      </div>

      {error && (
        <div className="mb-4 px-3 py-2 bg-red-500/10 border border-red-500/30 text-red-300 text-xs rounded flex items-center gap-2">
          <AlertCircle className="size-3.5" /> {error}
          <button onClick={() => setError(null)} className="ml-auto text-red-300/70 hover:text-red-200"><X className="size-3.5" /></button>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-[280px_1fr] gap-6">
        {/* Companies rail */}
        <aside className="card p-3 h-max">
          <div className="flex items-center justify-between px-1 mb-2">
            <h2 className="text-xs font-medium uppercase tracking-widest text-fg-muted font-mono">Companies</h2>
          </div>
          <ul className="space-y-1">
            {companies.map((c) => (
              <li key={c.id}>
                <button
                  onClick={() => setSelected(c.id)}
                  className={"w-full flex items-center gap-2 px-2 py-2 rounded text-sm transition-colors " +
                    (selected === c.id ? "bg-accent/15 text-accent" : "hover:bg-bg-elevated text-fg")}
                >
                  <Building2 className="size-4 shrink-0" />
                  <span className="truncate flex-1 text-left">{c.name}</span>
                  {!c.is_active && <span className="text-2xs text-amber-400">off</span>}
                </button>
                {selected === c.id && canCompanies && (
                  <div className="flex items-center gap-1 px-2 py-1">
                    <button onClick={() => renameCompany(c)} className="btn-ghost text-2xs"><Pencil className="size-3" /> Rename</button>
                    <button onClick={() => toggleActive(c)} className="btn-ghost text-2xs">{c.is_active ? "Deactivate" : "Activate"}</button>
                    <button onClick={() => deleteCompany(c)} className="btn-ghost text-2xs text-red-400"><Trash2 className="size-3" /></button>
                  </div>
                )}
              </li>
            ))}
            {companies.length === 0 && <li className="text-2xs text-fg-muted px-2 py-2">No companies yet.</li>}
          </ul>

          {canCompanies && (
            <div className="mt-3 pt-3 border-t border-border flex items-center gap-1">
              <input value={newCompany} onChange={(e) => setNewCompany(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void addCompany(); }}
                placeholder="New company…" className="input text-sm flex-1" />
              <button onClick={() => void addCompany()} disabled={!newCompany.trim()} className="btn-primary text-sm px-2"><Plus className="size-4" /></button>
            </div>
          )}
        </aside>

        {/* Org tree */}
        <section className="card p-4 min-h-[300px]">
          {!selectedCompany ? (
            <div className="text-sm text-fg-muted">Select a company to manage its structure.</div>
          ) : (
            <OrgTree
              key={selectedCompany.id}
              company={selectedCompany}
              units={units}
              loading={unitsLoading}
              canEdit={canOrg}
              onChanged={reloadUnits}
              onError={say}
            />
          )}
        </section>
      </div>
    </div>
  );
}

interface TreeNode extends OrgUnit { children: TreeNode[] }

function buildTree(units: OrgUnit[]): TreeNode[] {
  const byId = new Map<string, TreeNode>();
  units.forEach((u) => byId.set(u.id, { ...u, children: [] }));
  const roots: TreeNode[] = [];
  byId.forEach((n) => {
    if (n.parentId && byId.has(n.parentId)) byId.get(n.parentId)!.children.push(n);
    else roots.push(n);
  });
  return roots;
}

function OrgTree({ company, units, loading, canEdit, onChanged, onError }: {
  company: Company; units: OrgUnit[]; loading: boolean; canEdit: boolean;
  onChanged: () => void | Promise<void>; onError: (e: unknown) => void;
}) {
  const tree = useMemo(() => buildTree(units), [units]);
  const [addingRoot, setAddingRoot] = useState(false);

  async function add(parentId: string | null, name: string, kind: string) {
    try { await orgApi.createUnit(company.id, { name, kind, parent_id: parentId }); await onChanged(); }
    catch (e) { onError(e); }
  }
  async function rename(u: OrgUnit) {
    const name = window.prompt("Name", u.name)?.trim();
    if (!name || name === u.name) return;
    try { await orgApi.updateUnit(u.id, { name }); await onChanged(); } catch (e) { onError(e); }
  }
  async function remove(u: OrgUnit) {
    if (!window.confirm(`Delete "${u.name}" and everything under it?`)) return;
    try { await orgApi.deleteUnit(u.id); await onChanged(); } catch (e) { onError(e); }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div className="text-sm font-medium">{company.name} — structure</div>
        {canEdit && (
          <button onClick={() => setAddingRoot((v) => !v)} className="btn-ghost text-xs"><Plus className="size-3.5" /> Add top-level</button>
        )}
      </div>

      {addingRoot && canEdit && (
        <AddForm onCancel={() => setAddingRoot(false)} defaultKind="department"
          onAdd={async (name, kind) => { await add(null, name, kind); setAddingRoot(false); }} />
      )}

      {loading ? (
        <div className="text-sm text-fg-muted flex items-center gap-2 py-6"><Loader2 className="size-4 animate-spin" /> Loading…</div>
      ) : tree.length === 0 && !addingRoot ? (
        <div className="text-sm text-fg-muted py-6">No structure yet. {canEdit && "Add a top-level department to begin."}</div>
      ) : (
        <ul className="space-y-0.5">
          {tree.map((n) => (
            <TreeRow key={n.id} node={n} depth={0} canEdit={canEdit} onAdd={add} onRename={rename} onRemove={remove} />
          ))}
        </ul>
      )}
    </div>
  );
}

function TreeRow({ node, depth, canEdit, onAdd, onRename, onRemove }: {
  node: TreeNode; depth: number; canEdit: boolean;
  onAdd: (parentId: string | null, name: string, kind: string) => Promise<void>;
  onRename: (u: OrgUnit) => void; onRemove: (u: OrgUnit) => void;
}) {
  const [open, setOpen] = useState(true);
  const [adding, setAdding] = useState(false);
  const hasKids = node.children.length > 0;

  return (
    <li>
      <div className="group flex items-center gap-1.5 rounded px-1.5 py-1 hover:bg-bg-elevated" style={{ paddingLeft: depth * 18 + 6 }}>
        <button onClick={() => setOpen((v) => !v)} className={"text-fg-subtle " + (hasKids ? "" : "invisible")}>
          {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </button>
        <span className="text-sm">{node.name}</span>
        <span className="text-2xs uppercase tracking-wide text-fg-subtle bg-bg-elevated border border-border rounded px-1 py-0.5">{node.kind}</span>
        {canEdit && (
          <div className="ml-auto flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <button onClick={() => setAdding((v) => !v)} title="Add child" className="btn-ghost text-2xs px-1"><Plus className="size-3" /></button>
            <button onClick={() => onRename(node)} title="Rename" className="btn-ghost text-2xs px-1"><Pencil className="size-3" /></button>
            <button onClick={() => onRemove(node)} title="Delete" className="btn-ghost text-2xs px-1 text-red-400"><Trash2 className="size-3" /></button>
          </div>
        )}
      </div>

      {adding && canEdit && (
        <div style={{ paddingLeft: (depth + 1) * 18 + 6 }}>
          <AddForm defaultKind="section" onCancel={() => setAdding(false)}
            onAdd={async (name, kind) => { await onAdd(node.id, name, kind); setAdding(false); setOpen(true); }} />
        </div>
      )}

      {open && hasKids && (
        <ul className="space-y-0.5">
          {node.children.map((c) => (
            <TreeRow key={c.id} node={c} depth={depth + 1} canEdit={canEdit} onAdd={onAdd} onRename={onRename} onRemove={onRemove} />
          ))}
        </ul>
      )}
    </li>
  );
}

function AddForm({ onAdd, onCancel, defaultKind }: { onAdd: (name: string, kind: string) => void | Promise<void>; onCancel: () => void; defaultKind: string }) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState(defaultKind);
  const [busy, setBusy] = useState(false);
  async function submit() {
    if (!name.trim()) return;
    setBusy(true);
    try { await onAdd(name.trim(), kind); setName(""); } finally { setBusy(false); }
  }
  return (
    <div className="flex items-center gap-1.5 my-1">
      <input autoFocus value={name} onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") void submit(); if (e.key === "Escape") onCancel(); }}
        placeholder="Name…" className="input text-sm flex-1 max-w-xs" />
      <select value={kind} onChange={(e) => setKind(e.target.value)} className="input text-sm w-32">
        {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
      </select>
      <button onClick={() => void submit()} disabled={busy || !name.trim()} className="btn-primary text-sm px-2"><Check className="size-4" /></button>
      <button onClick={onCancel} className="btn-ghost text-sm px-2"><X className="size-4" /></button>
    </div>
  );
}
