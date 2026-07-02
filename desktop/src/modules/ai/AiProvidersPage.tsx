/**
 * AI Providers — configure organization (shared) and personal AI subscriptions.
 *
 * Org providers require `ai:manage`; personal providers require `ai:use_personal`.
 * The server enforces both, and API keys are write-only (never returned).
 */
import { useEffect, useMemo, useState } from "react";
import { Bot, Loader2, AlertCircle, Plus, Trash2, Star, X, Check, Building2, User as UserIcon, Users, Lock } from "lucide-react";
import { aiApi, MODEL_HINTS, type AiProvider, type AiProviderKind } from "./aiApi";
import { rolesApi } from "@/modules/users/rolesApi";
import { authApi } from "@/modules/auth/api/authApi";
import { ApiError } from "@/shared/lib/api";

export function AiProvidersPage() {
  const [org, setOrg] = useState<AiProvider[]>([]);
  const [personal, setPersonal] = useState<AiProvider[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [canPersonal, setCanPersonal] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState<"org" | "user" | null>(null);
  const [accessOf, setAccessOf] = useState<AiProvider | null>(null);

  const say = (e: unknown) => setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : "error");

  async function load() {
    setLoading(true);
    try {
      const r = await aiApi.list();
      setOrg(r.org); setPersonal(r.personal); setCanManage(r.can_manage); setCanPersonal(r.can_personal);
      setError(null);
    } catch (e) { say(e); } finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);

  async function setDefault(p: AiProvider) {
    try { await aiApi.update(p.id, { is_default: true }); await load(); } catch (e) { say(e); }
  }
  async function toggleActive(p: AiProvider) {
    try { await aiApi.update(p.id, { is_active: !p.is_active }); await load(); } catch (e) { say(e); }
  }
  async function remove(p: AiProvider) {
    if (!window.confirm(`Delete AI provider "${p.label}"?`)) return;
    try { await aiApi.remove(p.id); await load(); } catch (e) { say(e); }
  }

  if (loading) return <div className="px-8 py-8 text-sm text-fg-muted flex items-center gap-2"><Loader2 className="size-4 animate-spin" /> Loading…</div>;

  return (
    <div className="max-w-2xl mx-auto py-6 px-4 animate-fade-in">
      <div className="flex items-center gap-3 mb-6">
        <div className="size-10 rounded-md bg-bg-elevated border border-border grid place-items-center"><Bot className="size-5 text-accent" /></div>
        <div>
          <h1 className="text-xl font-semibold leading-tight">AI Providers</h1>
          <p className="text-sm text-fg-muted mt-0.5">Connect AI subscriptions used by the terminal assistant. API keys are stored encrypted and never shown again.</p>
        </div>
      </div>

      {error && (
        <div className="mb-4 px-3 py-2 bg-red-500/10 border border-red-500/30 text-red-300 text-xs rounded flex items-center gap-2">
          <AlertCircle className="size-3.5" /> {error}
          <button onClick={() => setError(null)} className="ml-auto"><X className="size-3" /></button>
        </div>
      )}

      {canManage && (
        <Section title="Organization" icon={<Building2 className="size-4" />} onAdd={() => setAdding("org")}
          hint="Shared providers for your company. Use Access to allow specific roles/users.">
          <ProviderList items={org} onDefault={setDefault} onToggle={toggleActive} onDelete={remove} onAccess={setAccessOf} />
        </Section>
      )}

      {canPersonal ? (
        <Section title="Personal" icon={<UserIcon className="size-4" />} onAdd={() => setAdding("user")}
          hint="Your own AI subscriptions, used only by you.">
          <ProviderList items={personal} onDefault={setDefault} onToggle={toggleActive} onDelete={remove} />
        </Section>
      ) : (
        <div className="card p-4 text-sm text-fg-muted">Personal AI subscriptions aren't permitted for your role — the terminal assistant uses your organization's providers.</div>
      )}

      {adding && (
        <AddProviderModal scope={adding} onClose={() => setAdding(null)} onSaved={() => { setAdding(null); void load(); }} onError={say} />
      )}

      {accessOf && (
        <AccessModal provider={accessOf} onClose={() => setAccessOf(null)} onSaved={() => { setAccessOf(null); void load(); }} onError={say} />
      )}
    </div>
  );
}

function accessSummary(p: AiProvider): string {
  if (p.allow_roles.length === 0 && p.allow_users.length === 0) return "Everyone";
  const parts: string[] = [];
  if (p.allow_roles.length) parts.push(`${p.allow_roles.length} role${p.allow_roles.length > 1 ? "s" : ""}`);
  if (p.allow_users.length) parts.push(`${p.allow_users.length} user${p.allow_users.length > 1 ? "s" : ""}`);
  return `Only ${parts.join(" + ")}`;
}

function Section({ title, icon, hint, onAdd, children }: { title: string; icon: React.ReactNode; hint: string; onAdd: () => void; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <div className="flex items-center justify-between mb-2">
        <h2 className="flex items-center gap-2 text-xs font-medium uppercase tracking-widest text-fg-muted font-mono">{icon}{title}</h2>
        <button onClick={onAdd} className="btn-ghost text-xs"><Plus className="size-3.5" /> Add provider</button>
      </div>
      <p className="text-2xs text-fg-muted mb-2">{hint}</p>
      {children}
    </section>
  );
}

function ProviderList({ items, onDefault, onToggle, onDelete, onAccess }: {
  items: AiProvider[]; onDefault: (p: AiProvider) => void; onToggle: (p: AiProvider) => void; onDelete: (p: AiProvider) => void; onAccess?: (p: AiProvider) => void;
}) {
  if (items.length === 0) return <div className="card p-4 text-sm text-fg-muted">None yet.</div>;
  return (
    <div className="card divide-y divide-border">
      {items.map((p) => {
        const restricted = p.allow_roles.length > 0 || p.allow_users.length > 0;
        return (
        <div key={p.id} className="flex items-center gap-3 px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="font-medium truncate">{p.label}</span>
              {p.is_default && <span className="text-2xs px-1.5 py-0.5 rounded bg-accent/15 text-accent border border-accent/30">default</span>}
              {!p.is_active && <span className="text-2xs text-amber-400">off</span>}
            </div>
            <div className="text-xs text-fg-muted truncate font-mono">{p.provider} · {p.model}</div>
          </div>
          {onAccess && (
            <button onClick={() => onAccess(p)} title="Who can use this provider"
              className={"flex items-center gap-1 text-2xs px-2 py-1 rounded border hover:bg-bg-elevated " + (restricted ? "border-accent/40 text-accent" : "border-border text-fg-muted")}>
              {restricted ? <Lock className="size-3" /> : <Users className="size-3" />} {accessSummary(p)}
            </button>
          )}
          {!p.is_default && <button onClick={() => onDefault(p)} className="p-1 hover:bg-bg rounded text-fg-muted" title="Set as default"><Star className="size-3.5" /></button>}
          <button onClick={() => onToggle(p)} className="text-2xs px-2 py-0.5 rounded-full border border-border text-fg-muted hover:bg-bg-elevated" title="Enable / disable">{p.is_active ? "On" : "Off"}</button>
          <button onClick={() => onDelete(p)} className="p-1 hover:bg-bg rounded text-red-400" title="Delete"><Trash2 className="size-3.5" /></button>
        </div>
        );
      })}
    </div>
  );
}

function AccessModal({ provider, onClose, onSaved, onError }: { provider: AiProvider; onClose: () => void; onSaved: () => void; onError: (e: unknown) => void }) {
  const [roles, setRoles] = useState<{ key: string; name: string }[]>([]);
  const [users, setUsers] = useState<{ id: string; username: string; full_name: string | null }[]>([]);
  const [selRoles, setSelRoles] = useState<Set<string>>(new Set(provider.allow_roles));
  const [selUsers, setSelUsers] = useState<Set<string>>(new Set(provider.allow_users));
  const [restricted, setRestricted] = useState(provider.allow_roles.length > 0 || provider.allow_users.length > 0);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    rolesApi.list().then((r) => setRoles(r.data.filter((x) => x.key !== "super_admin").map((x) => ({ key: x.key, name: x.name })))).catch(() => {});
    authApi.directory().then((r) => setUsers(r.data)).catch(() => {});
  }, []);

  const shownUsers = useMemo(() => {
    const n = q.trim().toLowerCase();
    return n ? users.filter((u) => u.username.toLowerCase().includes(n) || (u.full_name ?? "").toLowerCase().includes(n)) : users;
  }, [users, q]);

  const toggle = (set: Set<string>, key: string, apply: (s: Set<string>) => void) => { const n = new Set(set); n.has(key) ? n.delete(key) : n.add(key); apply(n); };

  async function save() {
    setBusy(true);
    try {
      await aiApi.update(provider.id, {
        allow_roles: restricted ? [...selRoles] : [],
        allow_users: restricted ? [...selUsers] : [],
      });
      onSaved();
    } catch (e) { onError(e); } finally { setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="card p-5 w-full max-w-md max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 mb-1"><Users className="size-4 text-accent" /><h2 className="text-base font-semibold">Who can use “{provider.label}”</h2></div>
        <p className="text-xs text-fg-muted mb-3">Choose who in your company may use this AI provider.</p>

        <div className="space-y-1 mb-3">
          <label className="flex items-center gap-2 text-sm"><input type="radio" checked={!restricted} onChange={() => setRestricted(false)} /> Everyone in the company</label>
          <label className="flex items-center gap-2 text-sm"><input type="radio" checked={restricted} onChange={() => setRestricted(true)} /> Only selected roles / users</label>
        </div>

        {restricted && (
          <div className="overflow-y-auto flex-1 space-y-3">
            <div>
              <div className="text-2xs uppercase tracking-wide text-fg-muted mb-1">Roles</div>
              <div className="flex flex-wrap gap-1.5">
                {roles.map((r) => (
                  <button key={r.key} onClick={() => toggle(selRoles, r.key, setSelRoles)}
                    className={"text-xs px-2 py-1 rounded border " + (selRoles.has(r.key) ? "bg-accent/15 border-accent/40 text-accent" : "border-border text-fg-muted hover:bg-bg-elevated")}>
                    {selRoles.has(r.key) && <Check className="size-3 inline mr-0.5" />}{r.name}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <div className="text-2xs uppercase tracking-wide text-fg-muted mb-1">Users</div>
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search users…" className="input w-full text-sm mb-2" />
              <div className="border border-border rounded divide-y divide-border max-h-52 overflow-y-auto">
                {shownUsers.map((u) => (
                  <label key={u.id} className="flex items-center gap-2 px-2 py-1.5 text-sm hover:bg-bg-elevated cursor-pointer">
                    <input type="checkbox" checked={selUsers.has(u.id)} onChange={() => toggle(selUsers, u.id, setSelUsers)} />
                    <span className="truncate">{u.username}{u.full_name ? <span className="text-fg-muted"> · {u.full_name}</span> : null}</span>
                  </label>
                ))}
                {shownUsers.length === 0 && <div className="px-2 py-2 text-2xs text-fg-muted">No users.</div>}
              </div>
            </div>
          </div>
        )}

        <div className="flex justify-end gap-2 mt-4">
          <button onClick={onClose} className="btn-ghost text-sm">Cancel</button>
          <button onClick={save} disabled={busy} className="btn-primary text-sm inline-flex gap-1">{busy ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />} Save access</button>
        </div>
      </div>
    </div>
  );
}

function AddProviderModal({ scope, onClose, onSaved, onError }: { scope: "org" | "user"; onClose: () => void; onSaved: () => void; onError: (e: unknown) => void }) {
  const [provider, setProvider] = useState<AiProviderKind>("anthropic");
  const [label, setLabel] = useState("");
  const [model, setModel] = useState(MODEL_HINTS.anthropic);
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [isDefault, setIsDefault] = useState(false);
  const [busy, setBusy] = useState(false);

  function pickProvider(v: AiProviderKind) { setProvider(v); if (!model || Object.values(MODEL_HINTS).includes(model)) setModel(MODEL_HINTS[v]); }

  async function save() {
    if (!label.trim() || !model.trim() || !apiKey.trim()) return;
    setBusy(true);
    try {
      await aiApi.create({ scope, provider, label: label.trim(), model: model.trim(), api_key: apiKey.trim(), base_url: baseUrl.trim() || null, is_default: isDefault });
      onSaved();
    } catch (e) { onError(e); } finally { setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="card p-5 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 mb-4"><Bot className="size-4 text-accent" /><h2 className="text-base font-semibold">Add {scope === "org" ? "organization" : "personal"} AI provider</h2></div>
        <label className="block text-xs text-fg-muted mb-1">Provider</label>
        <select value={provider} onChange={(e) => pickProvider(e.target.value as AiProviderKind)} className="input w-full mb-3">
          <option value="anthropic">Anthropic (Claude)</option>
          <option value="openai">OpenAI</option>
          <option value="google">Google (Gemini)</option>
          <option value="azure">Azure OpenAI</option>
          <option value="custom">Custom (OpenAI-compatible)</option>
        </select>
        <label className="block text-xs text-fg-muted mb-1">Label</label>
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Company Claude" className="input w-full mb-3" />
        <label className="block text-xs text-fg-muted mb-1">Model</label>
        <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="model id" className="input w-full mb-3 font-mono" />
        <label className="block text-xs text-fg-muted mb-1">API key</label>
        <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} type="password" placeholder="sk-…" className="input w-full mb-3 font-mono" autoComplete="off" />
        {(provider === "azure" || provider === "custom") && (
          <>
            <label className="block text-xs text-fg-muted mb-1">Base URL</label>
            <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://…" className="input w-full mb-3 font-mono" />
          </>
        )}
        <label className="flex items-center gap-2 text-sm mb-4"><input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} /> Set as default</label>
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="btn-ghost text-sm">Cancel</button>
          <button onClick={save} disabled={busy || !label.trim() || !model.trim() || !apiKey.trim()} className="btn-primary text-sm inline-flex gap-1">
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />} Save
          </button>
        </div>
      </div>
    </div>
  );
}
