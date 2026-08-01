/**
 * VPN — OpenVPN client profiles (migration 017).
 *
 * Create a profile by uploading an .ovpn file or entering settings manually,
 * attach it to assets/folders (on the host & folder editors), and bring the
 * tunnel up here. Each profile's tunnel runs either in this desktop app
 * (native openvpn) or on the backend, selectable per profile. Requires
 * `vpn:manage`.
 */
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  Network, Loader2, Plus, Trash2, Pencil, Power, PowerOff, Upload,
  AlertCircle, RefreshCw, Monitor, Server, Globe, X,
} from "lucide-react";
import {
  vpnApi, vpnNative, type VpnProfile, type VpnProfileInput,
  type VpnConnection, type VpnNativeStatus,
} from "../api/vpnApi";
import { isTauri } from "@/shared/lib/tauri";
import { ApiError } from "@/shared/lib/api";

type LiveState = "connecting" | "connected" | "error" | "closed";
interface Live { state: LiveState; error: string | null; connId?: string }

const emptyForm: VpnProfileInput & { name: string } = {
  name: "",
  description: "",
  runtime: "desktop",
  source: "config",
  remote_host: "",
  remote_port: 1194,
  proto: "udp",
  auth_mode: "none",
  auto_connect: true,
  config: "",
  ca: "",
  cert: "",
  key: "",
  tls_auth: "",
  username: "",
  password: "",
};

export function VpnPage() {
  const [profiles, setProfiles] = useState<VpnProfile[]>([]);
  const [connections, setConnections] = useState<VpnConnection[]>([]);
  const [native, setNative] = useState<VpnNativeStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Editor: null (closed), "new", or a profile id.
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [form, setForm] = useState<typeof emptyForm>(emptyForm);
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function refreshLive() {
    try {
      const [conns, nat] = await Promise.all([
        vpnApi.connections().then((r) => r.data).catch(() => [] as VpnConnection[]),
        isTauri ? vpnNative.list().catch(() => [] as VpnNativeStatus[]) : Promise.resolve([] as VpnNativeStatus[]),
      ]);
      setConnections(conns);
      setNative(nat);
    } catch { /* keep last */ }
  }

  async function refreshAll() {
    try {
      const r = await vpnApi.list();
      setProfiles(r.data);
      await refreshLive();
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load");
    }
  }

  useEffect(() => {
    refreshAll().finally(() => setLoading(false));
    pollRef.current = setInterval(refreshLive, 4000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function liveFor(p: VpnProfile): Live | null {
    if (p.runtime === "backend") {
      const c = connections.find((x) => x.profile_id === p.id && x.state !== "closed");
      return c ? { state: c.state, error: c.error, connId: c.id } : null;
    }
    const n = native.find((x) => x.profile_id === p.id && x.state !== "closed");
    return n ? { state: n.state, error: n.error } : null;
  }

  async function connect(p: VpnProfile) {
    setBusyId(p.id);
    setError(null);
    try {
      if (p.runtime === "backend") {
        await vpnApi.connectBackend(p.id);
      } else {
        if (!isTauri) throw new Error("Desktop VPN tunnels require the NetSphere desktop app.");
        const payload = await vpnApi.config(p.id);
        await vpnNative.connect(payload);
      }
      await refreshLive();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : "connect failed");
    } finally {
      setBusyId(null);
    }
  }

  async function disconnect(p: VpnProfile) {
    const live = liveFor(p);
    setBusyId(p.id);
    try {
      if (p.runtime === "backend") {
        if (live?.connId) await vpnApi.disconnectBackend(live.connId);
      } else if (isTauri) {
        await vpnNative.disconnect(p.id);
      }
      await refreshLive();
    } catch (e) {
      setError(e instanceof Error ? e.message : "disconnect failed");
    } finally {
      setBusyId(null);
    }
  }

  function openNew() {
    setForm({ ...emptyForm });
    setEditing("new");
  }

  function openEdit(p: VpnProfile) {
    // Secrets are write-only; prefill metadata only and leave secret fields
    // blank ("leave blank to keep").
    setForm({
      ...emptyForm,
      name: p.name,
      description: p.description ?? "",
      runtime: p.runtime,
      source: p.source,
      remote_host: p.remote_host ?? "",
      remote_port: p.remote_port ?? 1194,
      proto: p.proto,
      auth_mode: p.auth_mode,
      auto_connect: p.auto_connect,
      config: "", ca: "", cert: "", key: "", tls_auth: "", username: "", password: "",
    });
    setEditing(p.id);
  }

  async function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    setForm((f) => ({ ...f, config: text, source: "config" }));
    if (fileRef.current) fileRef.current.value = "";
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) return;
    setSaving(true);
    setError(null);
    // Only send secret fields that were actually filled, so an edit doesn't
    // wipe stored secrets. On create, empty fields are simply omitted.
    const isEdit = editing !== "new" && editing !== null;
    const body: VpnProfileInput & { name: string } = {
      name: form.name.trim(),
      description: form.description || null,
      runtime: form.runtime,
      source: form.source,
      proto: form.proto,
      auth_mode: form.auth_mode,
      auto_connect: form.auto_connect,
      remote_host: form.source === "manual" ? (form.remote_host || null) : (form.remote_host || null),
      remote_port: form.remote_port ? Number(form.remote_port) : null,
    };
    const putIf = (k: keyof VpnProfileInput, v: string | undefined) => {
      if (v && v.length > 0) (body as unknown as Record<string, unknown>)[k] = v;
    };
    putIf("config", form.config);
    putIf("ca", form.ca);
    putIf("cert", form.cert);
    putIf("key", form.key);
    putIf("tls_auth", form.tls_auth);
    if (form.auth_mode === "userpass") {
      putIf("username", form.username);
      putIf("password", form.password);
    }
    try {
      if (isEdit) await vpnApi.update(editing as string, body);
      else await vpnApi.create(body);
      setEditing(null);
      await refreshAll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : "save failed");
    } finally {
      setSaving(false);
    }
  }

  async function remove(p: VpnProfile) {
    if (!confirm(`Delete VPN profile "${p.name}"? Assets attached to it will be detached.`)) return;
    try {
      const live = liveFor(p);
      if (live) await disconnect(p);
      await vpnApi.remove(p.id);
      await refreshAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : "delete failed");
    }
  }

  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <div className="max-w-4xl mx-auto py-6 px-4 animate-fade-in">
      <div className="flex items-center gap-3 mb-6">
        <div className="size-10 rounded-md bg-bg-elevated border border-border grid place-items-center">
          <Network className="size-5 text-accent" />
        </div>
        <div className="flex-1">
          <h1 className="text-xl font-semibold leading-tight">VPN</h1>
          <p className="text-sm text-fg-muted mt-0.5">
            OpenVPN client profiles to reach assets behind a VPN. Attach a profile to a folder or asset to auto-connect before a session.
          </p>
        </div>
        {editing === null && (
          <button onClick={openNew} className="btn-primary"><Plus className="size-4" /> New profile</button>
        )}
      </div>

      {error && (
        <div className="mb-4 px-3 py-2 bg-red-500/10 border border-red-500/30 text-red-300 text-xs rounded flex items-center gap-2">
          <AlertCircle className="size-3.5" /> {error}
        </div>
      )}

      {/* Editor */}
      {editing !== null && (
        <form onSubmit={submit} className="card p-4 mb-4 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">{editing === "new" ? "New VPN profile" : "Edit VPN profile"}</h2>
            <button type="button" onClick={() => setEditing(null)} className="btn-ghost text-xs"><X className="size-4" /></button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-fg-muted mb-1">Name</label>
              <input value={form.name} onChange={(e) => set("name", e.target.value)} className="input w-full" placeholder="HQ datacenter" />
            </div>
            <div>
              <label className="block text-xs text-fg-muted mb-1">Runs on</label>
              <select value={form.runtime} onChange={(e) => set("runtime", e.target.value as "desktop" | "backend")} className="input w-full">
                <option value="desktop">This desktop (native client)</option>
                <option value="backend">Backend server</option>
              </select>
            </div>
            <div className="sm:col-span-2">
              <label className="block text-xs text-fg-muted mb-1">Description</label>
              <input value={form.description ?? ""} onChange={(e) => set("description", e.target.value)} className="input w-full" placeholder="Optional" />
            </div>
          </div>

          {/* Source */}
          <div className="flex items-center gap-2 text-xs">
            <span className="text-fg-muted">Configuration:</span>
            <label className="flex items-center gap-1"><input type="radio" checked={form.source === "config"} onChange={() => set("source", "config")} className="accent-accent" /> Upload .ovpn</label>
            <label className="flex items-center gap-1"><input type="radio" checked={form.source === "manual"} onChange={() => set("source", "manual")} className="accent-accent" /> Enter manually</label>
          </div>

          {form.source === "config" ? (
            <div>
              <div className="flex items-center gap-2 mb-1">
                <button type="button" onClick={() => fileRef.current?.click()} className="btn-ghost text-xs"><Upload className="size-3.5" /> Choose .ovpn file</button>
                {editing !== "new" && !form.config && <span className="text-2xs text-fg-subtle">a config is already stored — upload to replace</span>}
                <input ref={fileRef} type="file" accept=".ovpn,.conf,text/plain" className="hidden" onChange={onPickFile} />
              </div>
              <textarea value={form.config} onChange={(e) => set("config", e.target.value)} rows={5}
                className="input w-full font-mono text-2xs" placeholder="client&#10;dev tun&#10;remote vpn.example.com 1194 udp&#10;…" />
            </div>
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <div className="col-span-2">
                  <label className="block text-xs text-fg-muted mb-1">Remote host</label>
                  <input value={form.remote_host ?? ""} onChange={(e) => set("remote_host", e.target.value)} className="input w-full font-mono" placeholder="vpn.example.com" />
                </div>
                <div>
                  <label className="block text-xs text-fg-muted mb-1">Port</label>
                  <input type="number" min={1} max={65535} value={form.remote_port ?? ""} onChange={(e) => set("remote_port", e.target.value === "" ? null : Number(e.target.value))} className="input w-full" />
                </div>
                <div>
                  <label className="block text-xs text-fg-muted mb-1">Proto</label>
                  <select value={form.proto} onChange={(e) => set("proto", e.target.value as "udp" | "tcp")} className="input w-full">
                    <option value="udp">UDP</option>
                    <option value="tcp">TCP</option>
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <PemField label="CA certificate" value={form.ca ?? ""} onChange={(v) => set("ca", v)} stored={editing !== "new"} />
                <PemField label="Client certificate" value={form.cert ?? ""} onChange={(v) => set("cert", v)} stored={editing !== "new"} />
                <PemField label="Client key" value={form.key ?? ""} onChange={(v) => set("key", v)} stored={editing !== "new"} />
                <PemField label="TLS auth key" value={form.tls_auth ?? ""} onChange={(v) => set("tls_auth", v)} stored={editing !== "new"} />
              </div>
            </div>
          )}

          {/* Auth */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 items-end">
            <div>
              <label className="block text-xs text-fg-muted mb-1">Authentication</label>
              <select value={form.auth_mode} onChange={(e) => set("auth_mode", e.target.value as "none" | "userpass")} className="input w-full">
                <option value="none">Certificate only</option>
                <option value="userpass">Username &amp; password</option>
              </select>
            </div>
            {form.auth_mode === "userpass" && (
              <>
                <div>
                  <label className="block text-xs text-fg-muted mb-1">Username</label>
                  <input value={form.username ?? ""} onChange={(e) => set("username", e.target.value)} className="input w-full" placeholder={editing !== "new" ? "leave blank to keep" : ""} />
                </div>
                <div>
                  <label className="block text-xs text-fg-muted mb-1">Password</label>
                  <input type="password" value={form.password ?? ""} onChange={(e) => set("password", e.target.value)} className="input w-full" placeholder={editing !== "new" ? "leave blank to keep" : ""} />
                </div>
              </>
            )}
          </div>

          <div className="flex items-center justify-between flex-wrap gap-2">
            <label className="flex items-center gap-2 text-xs text-fg-muted">
              <input type="checkbox" checked={form.auto_connect} onChange={(e) => set("auto_connect", e.target.checked)} className="accent-accent" />
              Auto-connect before reaching an attached asset
            </label>
            <button type="submit" disabled={saving || !form.name.trim()} className="btn-primary">
              {saving ? <><Loader2 className="size-4 animate-spin" /> Saving…</> : <>Save profile</>}
            </button>
          </div>
        </form>
      )}

      {/* Profiles list */}
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-semibold text-fg-muted">Profiles</h2>
        <button onClick={() => refreshAll()} className="btn-ghost text-2xs"><RefreshCw className="size-3" /> Refresh</button>
      </div>

      {loading ? (
        <div className="card p-8 text-center text-fg-muted text-sm flex items-center justify-center gap-2">
          <Loader2 className="size-4 animate-spin" /> Loading…
        </div>
      ) : profiles.length === 0 ? (
        <div className="card p-8 text-center text-fg-muted text-sm">No VPN profiles yet.</div>
      ) : (
        <div className="space-y-2">
          {profiles.map((p) => {
            const live = liveFor(p);
            const on = live?.state === "connected";
            const connecting = live?.state === "connecting" || busyId === p.id;
            return (
              <div key={p.id} className="card p-3 flex items-center gap-3">
                <div className="size-9 rounded bg-bg-elevated border border-border grid place-items-center shrink-0">
                  {p.runtime === "desktop" ? <Monitor className="size-4 text-fg-muted" /> : <Server className="size-4 text-fg-muted" />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium truncate">{p.name}</span>
                    <span className="text-2xs px-1.5 py-0.5 rounded border border-border text-fg-subtle">{p.runtime}</span>
                    {p.auth_mode === "userpass" && <span className="text-2xs text-fg-subtle">user/pass</span>}
                  </div>
                  <div className="text-2xs text-fg-subtle font-mono truncate">
                    {p.source === "manual"
                      ? `${p.remote_host ?? "?"}:${p.remote_port ?? "?"} ${p.proto}`
                      : p.has_config ? ".ovpn config" : "no config"}
                    {p.description ? ` · ${p.description}` : ""}
                  </div>
                </div>
                <StateBadge state={live?.state ?? "disconnected"} error={live?.error ?? null} />
                {on || connecting ? (
                  <button onClick={() => disconnect(p)} disabled={busyId === p.id} className="btn-ghost text-xs text-amber-400" title="Disconnect">
                    {busyId === p.id ? <Loader2 className="size-3.5 animate-spin" /> : <PowerOff className="size-3.5" />}
                  </button>
                ) : (
                  <button onClick={() => connect(p)} disabled={busyId === p.id} className="btn-ghost text-xs text-emerald-400" title="Connect">
                    {busyId === p.id ? <Loader2 className="size-3.5 animate-spin" /> : <Power className="size-3.5" />}
                  </button>
                )}
                <button onClick={() => openEdit(p)} className="btn-ghost text-xs" title="Edit"><Pencil className="size-3.5" /></button>
                <button onClick={() => remove(p)} className="btn-ghost text-xs text-red-400" title="Delete"><Trash2 className="size-3.5" /></button>
              </div>
            );
          })}
        </div>
      )}

      <p className="text-2xs text-fg-muted mt-4 flex items-start gap-1.5">
        <Globe className="size-3.5 mt-0.5 shrink-0" />
        Desktop tunnels run the native <span className="font-mono">openvpn</span> client on this machine (needs it installed and elevated privileges); backend tunnels run on the server. Live tunnels are in-memory and stop on restart.
      </p>
    </div>
  );
}

function PemField({ label, value, onChange, stored }: { label: string; value: string; onChange: (v: string) => void; stored: boolean }) {
  return (
    <div>
      <label className="block text-xs text-fg-muted mb-1">{label}</label>
      <textarea value={value} onChange={(e) => onChange(e.target.value)} rows={2}
        className="input w-full font-mono text-2xs" placeholder={stored ? "leave blank to keep" : "-----BEGIN…"} />
    </div>
  );
}

function StateBadge({ state, error }: { state: LiveState | "disconnected"; error: string | null }) {
  const cls =
    state === "connected" ? "text-emerald-300 border-emerald-500/40 bg-emerald-500/10"
    : state === "connecting" ? "text-amber-300 border-amber-500/40 bg-amber-500/10"
    : state === "error" ? "text-red-300 border-red-500/40 bg-red-500/10"
    : "text-fg-muted border-border";
  return (
    <span className={"text-2xs px-1.5 py-0.5 rounded border whitespace-nowrap " + cls} title={error ?? undefined}>
      {state}
    </span>
  );
}
