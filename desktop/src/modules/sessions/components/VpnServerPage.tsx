/**
 * VPN Server — Awamer as an OpenVPN hub (migration 019).
 *
 * Use this when a machine (a local Linux box behind NAT, a datacenter box, …)
 * needs to be reachable but has no public IP: run an OpenVPN *server* here,
 * add users to it, and hand each user a ready-to-install `.ovpn` (certs are
 * inlined, so it drops straight into OpenVPN Connect on Linux/Windows/macOS).
 *
 * Each server profile mints its own CA + server certificate on creation; each
 * user gets a CA-signed client certificate *and* a username/password. Starting
 * a server spawns the `openvpn` process on the backend host. Requires
 * `vpn_server:manage`.
 */
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  Radio, Loader2, Plus, Trash2, Pencil, Power, PowerOff, AlertCircle,
  RefreshCw, X, Users, Download, Ban, Undo2, Eye, Copy, ChevronRight, KeyRound, Globe,
} from "lucide-react";
import {
  vpnServerApi, type VpnServerProfile, type VpnServerInput,
  type VpnServerClient, type VpnServerState,
} from "../api/vpnServerApi";
import { ApiError } from "@/shared/lib/api";

const emptyForm: VpnServerInput & { name: string; public_host: string } = {
  name: "",
  description: "",
  public_host: "",
  port: undefined as number | undefined,
  auto_assign_port: true,
  proto: "udp" as "udp" | "tcp",
  subnet: "10.8.1.0/24",
  dns: "",
  client_to_client: true,
  internet_access: false,
  cipher: "AES-256-GCM",
};

/** Friendly, code-aware messages for the multi-VPN-server validation errors. */
function friendlyVpnError(e: unknown, fallback: string): string {
  const code = e instanceof ApiError
    ? ((e.payload as { error?: { code?: string } } | undefined)?.error?.code)
    : undefined;
  switch (code) {
    case "vpn_port_out_of_range": return "Port is outside the allowed range.";
    case "vpn_port_reserved": return "That port is reserved by the system.";
    case "vpn_port_in_use": return "That port is already assigned or in use.";
    case "vpn_subnet_overlap": return "Subnet overlaps another VPN server's subnet.";
    case "vpn_no_free_port": return "No free port available in the configured range.";
    case "vpn_bad_subnet": return "Subnet must be valid CIDR, e.g. 10.8.1.0/24.";
    default: return e instanceof ApiError ? e.message : e instanceof Error ? e.message : fallback;
  }
}

const errMsg = (e: unknown, fallback: string) =>
  e instanceof ApiError ? e.message : e instanceof Error ? e.message : fallback;

export function VpnServerPage() {
  const [servers, setServers] = useState<VpnServerProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Editor: null (closed), "new", or a server id.
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [form, setForm] = useState<typeof emptyForm>(emptyForm);
  const [saving, setSaving] = useState(false);

  // Which server's user panel is expanded.
  const [expanded, setExpanded] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Allowed VPN Server port range (from the backend policy), shown in the form.
  const [portRange, setPortRange] = useState<{ min: number; max: number } | null>(null);
  useEffect(() => { vpnServerApi.portPolicy().then(setPortRange).catch(() => {}); }, []);

  async function refresh() {
    try {
      const r = await vpnServerApi.list();
      setServers(r.data);
    } catch (e) {
      setError(errMsg(e, "failed to load"));
    }
  }

  useEffect(() => {
    refresh().finally(() => setLoading(false));
    pollRef.current = setInterval(refresh, 5000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  function openNew() {
    setForm({ ...emptyForm });
    setEditing("new");
  }

  function openEdit(s: VpnServerProfile) {
    setForm({
      name: s.name,
      description: s.description ?? "",
      public_host: s.public_host,
      port: s.port,
      auto_assign_port: false, // editing an existing server keeps/uses its port
      proto: s.proto,
      subnet: s.subnet,
      dns: s.dns ?? "",
      client_to_client: s.client_to_client,
      internet_access: s.internet_access,
      cipher: s.cipher,
    });
    setEditing(s.id);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!form.name.trim() || !form.public_host.trim()) return;
    setSaving(true);
    setError(null);
    const isEdit = editing !== "new" && editing !== null;
    // Auto-assign (create only) lets the backend pick the next free in-range port.
    const useAuto = !isEdit && form.auto_assign_port;
    const base: VpnServerInput = {
      description: form.description || null,
      public_host: form.public_host.trim(),
      port: useAuto ? undefined : (form.port ? Number(form.port) : undefined),
      auto_assign_port: useAuto ? true : undefined,
      proto: form.proto,
      subnet: form.subnet || undefined,
      dns: form.dns || null,
      client_to_client: form.client_to_client,
      internet_access: form.internet_access,
      cipher: form.cipher || undefined,
    };
    try {
      if (isEdit) {
        await vpnServerApi.update(editing as string, base);
      } else {
        await vpnServerApi.create({ ...base, name: form.name.trim(), public_host: form.public_host.trim() });
      }
      setEditing(null);
      await refresh();
    } catch (err) {
      setError(friendlyVpnError(err, "save failed"));
    } finally {
      setSaving(false);
    }
  }

  async function toggleRun(s: VpnServerProfile) {
    const running = s.status?.state === "running" || s.status?.state === "starting";
    setBusyId(s.id);
    setError(null);
    try {
      if (running) await vpnServerApi.stop(s.id);
      else await vpnServerApi.start(s.id);
      await refresh();
    } catch (e) {
      setError(errMsg(e, running ? "stop failed" : "start failed"));
    } finally {
      setBusyId(null);
    }
  }

  async function remove(s: VpnServerProfile) {
    if (!confirm(`Delete VPN server "${s.name}"? Its CA, certificates and all users are permanently removed, and any running process is stopped.`)) return;
    try {
      await vpnServerApi.remove(s.id);
      if (expanded === s.id) setExpanded(null);
      await refresh();
    } catch (e) {
      setError(errMsg(e, "delete failed"));
    }
  }

  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <div className="max-w-4xl mx-auto py-6 px-4 animate-fade-in">
      <div className="flex items-center gap-3 mb-6">
        <div className="size-10 rounded-md bg-bg-elevated border border-border grid place-items-center">
          <Radio className="size-5 text-accent" />
        </div>
        <div className="flex-1">
          <h1 className="text-xl font-semibold leading-tight">VPN Server</h1>
          <p className="text-sm text-fg-muted mt-0.5">
            Run Awamer as an OpenVPN hub. Create a server, add users, and hand each one a ready-to-install <span className="font-mono">.ovpn</span> — ideal for reaching a machine that has internet but no public IP.
          </p>
        </div>
        {editing === null && (
          <button onClick={openNew} className="btn-primary"><Plus className="size-4" /> New server</button>
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
            <h2 className="text-sm font-semibold">{editing === "new" ? "New VPN server" : "Edit VPN server"}</h2>
            <button type="button" onClick={() => setEditing(null)} className="btn-ghost text-xs"><X className="size-4" /></button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-fg-muted mb-1">Name</label>
              <input value={form.name} onChange={(e) => set("name", e.target.value)} disabled={editing !== "new"}
                className="input w-full disabled:opacity-60" placeholder="HQ hub" />
            </div>
            <div>
              <label className="block text-xs text-fg-muted mb-1">Public host / IP <span className="text-fg-subtle">(clients connect here)</span></label>
              <input value={form.public_host ?? ""} onChange={(e) => set("public_host", e.target.value)}
                className="input w-full font-mono" placeholder="vpn.example.com or 203.0.113.10" />
            </div>
            <div className="sm:col-span-2">
              <label className="block text-xs text-fg-muted mb-1">Description</label>
              <input value={form.description ?? ""} onChange={(e) => set("description", e.target.value)} className="input w-full" placeholder="Optional" />
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <div>
              <label className="block text-xs text-fg-muted mb-1">Port</label>
              <input
                type="number"
                min={portRange?.min ?? 20000}
                max={portRange?.max ?? 30000}
                value={form.auto_assign_port && editing === "new" ? "" : (form.port ?? "")}
                disabled={form.auto_assign_port && editing === "new"}
                placeholder={form.auto_assign_port && editing === "new" ? "auto" : ""}
                onChange={(e) => set("port", e.target.value === "" ? undefined : Number(e.target.value))}
                className="input w-full disabled:opacity-50"
              />
              <p className="text-2xs text-fg-subtle mt-1">
                Allowed range: {portRange ? `${portRange.min}-${portRange.max}` : "20000-30000"}
              </p>
              {editing === "new" && (
                <label className="mt-1 flex items-center gap-1 text-2xs text-fg-muted">
                  <input type="checkbox" checked={form.auto_assign_port} onChange={(e) => set("auto_assign_port", e.target.checked)} />
                  Auto-assign port
                </label>
              )}
            </div>
            <div>
              <label className="block text-xs text-fg-muted mb-1">Protocol</label>
              <select value={form.proto} onChange={(e) => set("proto", e.target.value as "udp" | "tcp")} className="input w-full">
                <option value="udp">UDP</option>
                <option value="tcp">TCP</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-fg-muted mb-1">VPN subnet</label>
              <input value={form.subnet ?? ""} onChange={(e) => set("subnet", e.target.value)} className="input w-full font-mono" placeholder="10.8.0.0/24" />
            </div>
            <div>
              <label className="block text-xs text-fg-muted mb-1">Push DNS <span className="text-fg-subtle">(optional)</span></label>
              <input value={form.dns ?? ""} onChange={(e) => set("dns", e.target.value)} className="input w-full font-mono" placeholder="1.1.1.1" />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 items-end">
            <div>
              <label className="block text-xs text-fg-muted mb-1">Data cipher</label>
              <select value={form.cipher} onChange={(e) => set("cipher", e.target.value)} className="input w-full">
                <option value="AES-256-GCM">AES-256-GCM</option>
                <option value="AES-128-GCM">AES-128-GCM</option>
              </select>
            </div>
            <label className="flex items-center gap-2 text-xs text-fg-muted h-9">
              <input type="checkbox" checked={form.client_to_client} onChange={(e) => set("client_to_client", e.target.checked)} className="accent-accent" />
              Allow clients to reach each other (client-to-client)
            </label>
          </div>

          <label className="flex items-start gap-2 text-xs text-fg-muted">
            <input type="checkbox" checked={form.internet_access} onChange={(e) => set("internet_access", e.target.checked)} className="accent-accent mt-0.5" />
            <span>
              Control internet access for this server (full tunnel)
              <span className="block text-2xs text-fg-subtle">When on, all users route through the server: users you allow (globe button) reach the internet through it; everyone else is <b>blocked from the internet</b> and reaches only the VPN. When off, users keep their own internet and the VPN carries VPN traffic only. Changes apply when the server is (re)started.</span>
            </span>
          </label>

          <div className="flex items-center justify-end">
            <button type="submit" disabled={saving || !form.name.trim() || !form.public_host.trim()} className="btn-primary">
              {saving ? <><Loader2 className="size-4 animate-spin" /> Saving…</> : editing === "new" ? "Create server" : "Save changes"}
            </button>
          </div>
          {editing === "new" && (
            <p className="text-2xs text-fg-subtle">A fresh Certificate Authority and server certificate are generated for this server on creation.</p>
          )}
        </form>
      )}

      {/* Server list */}
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-semibold text-fg-muted">Servers</h2>
        <button onClick={() => refresh()} className="btn-ghost text-2xs"><RefreshCw className="size-3" /> Refresh</button>
      </div>

      {loading ? (
        <div className="card p-8 text-center text-fg-muted text-sm flex items-center justify-center gap-2">
          <Loader2 className="size-4 animate-spin" /> Loading…
        </div>
      ) : servers.length === 0 ? (
        <div className="card p-8 text-center text-fg-muted text-sm">No VPN servers yet.</div>
      ) : (
        <div className="space-y-2">
          {servers.map((s) => {
            const st = s.status?.state ?? "stopped";
            const running = st === "running" || st === "starting";
            const isOpen = expanded === s.id;
            return (
              <div key={s.id} className="card overflow-hidden">
                <div className="p-3 flex items-center gap-3">
                  <button onClick={() => setExpanded(isOpen ? null : s.id)} className="size-9 rounded bg-bg-elevated border border-border grid place-items-center shrink-0 hover:border-accent transition-colors" title="Manage users">
                    <ChevronRight className={"size-4 text-fg-muted transition-transform " + (isOpen ? "rotate-90" : "")} />
                  </button>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium truncate">{s.name}</span>
                      <span className="text-2xs px-1.5 py-0.5 rounded border border-border text-fg-subtle uppercase">{s.proto}</span>
                      <span className="text-2xs text-fg-subtle flex items-center gap-1"><Users className="size-3" /> {s.client_count}</span>
                    </div>
                    <div className="text-2xs text-fg-subtle font-mono truncate">
                      {s.public_host}:{s.port} · {s.subnet}
                      {s.description ? ` · ${s.description}` : ""}
                    </div>
                  </div>
                  <StateBadge state={st} error={s.status?.error ?? null} />
                  <button onClick={() => toggleRun(s)} disabled={busyId === s.id}
                    className={"btn-ghost text-xs " + (running ? "text-amber-400" : "text-emerald-400")}
                    title={running ? "Stop server" : "Start server"}>
                    {busyId === s.id ? <Loader2 className="size-3.5 animate-spin" /> : running ? <PowerOff className="size-3.5" /> : <Power className="size-3.5" />}
                  </button>
                  <button onClick={() => openEdit(s)} className="btn-ghost text-xs" title="Edit"><Pencil className="size-3.5" /></button>
                  <button onClick={() => remove(s)} className="btn-ghost text-xs text-red-400" title="Delete"><Trash2 className="size-3.5" /></button>
                </div>

                {isOpen && <ClientPanel server={s} onError={setError} onChanged={refresh} />}
              </div>
            );
          })}
        </div>
      )}

      <p className="text-2xs text-fg-muted mt-4 flex items-start gap-1.5">
        <KeyRound className="size-3.5 mt-0.5 shrink-0" />
        The server process runs on the backend host (needs <span className="font-mono">openvpn</span> installed, the tun device, and the VPN port published). Each user authenticates with both a certificate and a username/password; revoking a user blocks their next connection. The internet policy needs <span className="font-mono">iptables</span> and IP forwarding on the host; with it on, users added or changed after the server started can connect only after a restart. Running servers are in-memory and must be re-started after a backend restart.
      </p>
    </div>
  );
}

/** Expandable per-server user manager: list, add, reveal, download, revoke, delete. */
function ClientPanel({ server, onError, onChanged }: {
  server: VpnServerProfile;
  onError: (m: string | null) => void;
  onChanged: () => void;
}) {
  const [clients, setClients] = useState<VpnServerClient[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [newCred, setNewCred] = useState<{ name: string; username: string; password: string } | null>(null);
  const [reveal, setReveal] = useState<Record<string, string>>({});

  async function load() {
    try {
      const r = await vpnServerApi.clients(server.id);
      setClients(r.data);
    } catch (e) {
      onError(errMsg(e, "failed to load users"));
    }
  }

  useEffect(() => { void load(); }, [server.id]);

  async function addClient(e: FormEvent) {
    e.preventDefault();
    if (!name.trim() || !username.trim()) return;
    setSaving(true);
    onError(null);
    try {
      const created = await vpnServerApi.addClient(server.id, {
        name: name.trim(), username: username.trim(),
        password: password.trim() ? password.trim() : undefined,
      });
      setNewCred({ name: created.name, username: created.username, password: created.password });
      setName(""); setUsername(""); setPassword(""); setAdding(false);
      await load();
      onChanged();
    } catch (err) {
      onError(errMsg(err, "could not add user"));
    } finally {
      setSaving(false);
    }
  }

  async function download(c: VpnServerClient) {
    setBusy(c.id);
    onError(null);
    try {
      const blob = await vpnServerApi.ovpn(server.id, c.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${c.name.replace(/[^a-zA-Z0-9._-]/g, "_")}.ovpn`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      onError(errMsg(e, "download failed"));
    } finally {
      setBusy(null);
    }
  }

  async function revealCred(c: VpnServerClient) {
    setBusy(c.id);
    try {
      const cred = await vpnServerApi.credentials(server.id, c.id);
      setReveal((r) => ({ ...r, [c.id]: cred.password }));
    } catch (e) {
      onError(errMsg(e, "reveal failed"));
    } finally {
      setBusy(null);
    }
  }

  async function toggleInternet(c: VpnServerClient) {
    setBusy(c.id);
    onError(null);
    try {
      await vpnServerApi.setInternet(server.id, c.id, !c.internet_access);
      await load();
      onChanged();
    } catch (e) {
      onError(errMsg(e, "could not change internet access"));
    } finally {
      setBusy(null);
    }
  }

  async function toggleRevoke(c: VpnServerClient) {
    setBusy(c.id);
    onError(null);
    try {
      await vpnServerApi.setRevoked(server.id, c.id, !c.revoked);
      await load();
      onChanged();
    } catch (e) {
      onError(errMsg(e, "revoke failed"));
    } finally {
      setBusy(null);
    }
  }

  async function removeClient(c: VpnServerClient) {
    if (!confirm(`Remove user "${c.name}" from "${server.name}"? Their certificate is deleted and they can no longer connect.`)) return;
    setBusy(c.id);
    onError(null);
    try {
      await vpnServerApi.removeClient(server.id, c.id);
      await load();
      onChanged();
    } catch (e) {
      onError(errMsg(e, "remove failed"));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="border-t border-border bg-bg-elevated/40 p-3 space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold text-fg-muted flex items-center gap-1.5"><Users className="size-3.5" /> Users</h3>
        {!adding && <button onClick={() => setAdding(true)} className="btn-ghost text-2xs"><Plus className="size-3" /> Add user</button>}
      </div>

      {/* One-time credential handoff */}
      {newCred && (
        <div className="px-3 py-2 bg-emerald-500/10 border border-emerald-500/30 rounded text-xs space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-emerald-300 font-medium">User “{newCred.name}” created</span>
            <button onClick={() => setNewCred(null)} className="btn-ghost text-2xs"><X className="size-3.5" /></button>
          </div>
          <p className="text-fg-muted">Save this password now — it won’t be shown again in full (you can still reveal it later).</p>
          <div className="flex items-center gap-2 font-mono">
            <span className="text-fg-subtle">{newCred.username}</span>
            <span className="text-fg">/</span>
            <span className="select-all">{newCred.password}</span>
            <CopyButton value={newCred.password} />
          </div>
        </div>
      )}

      {/* Add form */}
      {adding && (
        <form onSubmit={addClient} className="grid grid-cols-1 sm:grid-cols-4 gap-2 items-end p-2 rounded border border-border bg-bg">
          <div>
            <label className="block text-2xs text-fg-muted mb-1">Display name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} className="input w-full text-xs" placeholder="Alice laptop" />
          </div>
          <div>
            <label className="block text-2xs text-fg-muted mb-1">Username</label>
            <input value={username} onChange={(e) => setUsername(e.target.value)} className="input w-full text-xs font-mono" placeholder="alice" />
          </div>
          <div>
            <label className="block text-2xs text-fg-muted mb-1">Password <span className="text-fg-subtle">(blank = auto)</span></label>
            <input value={password} onChange={(e) => setPassword(e.target.value)} className="input w-full text-xs" placeholder="auto-generate" />
          </div>
          <div className="flex items-center gap-1">
            <button type="submit" disabled={saving || !name.trim() || !username.trim()} className="btn-primary text-xs flex-1">
              {saving ? <Loader2 className="size-3.5 animate-spin" /> : "Add"}
            </button>
            <button type="button" onClick={() => { setAdding(false); setName(""); setUsername(""); setPassword(""); }} className="btn-ghost text-xs"><X className="size-3.5" /></button>
          </div>
        </form>
      )}

      {/* Client list */}
      {clients === null ? (
        <div className="text-2xs text-fg-muted flex items-center gap-2 py-2"><Loader2 className="size-3 animate-spin" /> Loading users…</div>
      ) : clients.length === 0 ? (
        <div className="text-2xs text-fg-subtle py-2">No users yet — add one to issue a .ovpn.</div>
      ) : (
        <div className="space-y-1">
          {clients.map((c) => (
            <div key={c.id} className={"flex items-center gap-2 px-2 py-1.5 rounded border " + (c.revoked ? "border-red-500/30 bg-red-500/5" : "border-border bg-bg")}>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium truncate">{c.name}</span>
                  <span className="text-2xs text-fg-subtle font-mono">{c.username}</span>
                  {c.revoked && <span className="text-2xs text-red-300 border border-red-500/40 rounded px-1">revoked</span>}
                  {server.internet_access && (
                    c.internet_access ? (
                      <span className="text-2xs rounded px-1 flex items-center gap-0.5 border text-sky-300 border-sky-500/40" title="Internet allowed — routed through this server">
                        <Globe className="size-2.5" /> internet
                      </span>
                    ) : (
                      <span className="text-2xs rounded px-1 flex items-center gap-0.5 border text-amber-300 border-amber-500/40" title="Internet blocked — this user reaches only the VPN">
                        <Globe className="size-2.5" /> blocked
                      </span>
                    )
                  )}
                </div>
                {reveal[c.id] && (
                  <div className="text-2xs font-mono text-amber-300 flex items-center gap-1 mt-0.5">
                    <KeyRound className="size-3" /> <span className="select-all">{reveal[c.id]}</span>
                    <CopyButton value={reveal[c.id]} />
                  </div>
                )}
              </div>
              <button onClick={() => revealCred(c)} disabled={busy === c.id} className="btn-ghost text-2xs" title="Reveal password"><Eye className="size-3.5" /></button>
              <button onClick={() => download(c)} disabled={busy === c.id} className="btn-ghost text-2xs text-accent" title="Download .ovpn">
                {busy === c.id ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
              </button>
              <button onClick={() => toggleInternet(c)} disabled={busy === c.id}
                className={"btn-ghost text-2xs " + (c.internet_access ? "text-sky-400" : "text-fg-muted")}
                title={c.internet_access ? "Internet allowed — click to block (VPN only)" : "Internet blocked — click to allow (through the server). Applies when the server's internet switch is on, after a restart."}>
                <Globe className="size-3.5" />
              </button>
              <button onClick={() => toggleRevoke(c)} disabled={busy === c.id} className={"btn-ghost text-2xs " + (c.revoked ? "text-emerald-400" : "text-amber-400")} title={c.revoked ? "Un-revoke" : "Revoke"}>
                {c.revoked ? <Undo2 className="size-3.5" /> : <Ban className="size-3.5" />}
              </button>
              <button onClick={() => removeClient(c)} disabled={busy === c.id} className="btn-ghost text-2xs text-red-400" title="Remove user"><Trash2 className="size-3.5" /></button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CopyButton({ value }: { value: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => { try { await navigator.clipboard.writeText(value); setOk(true); setTimeout(() => setOk(false), 1200); } catch { /* ignore */ } }}
      className="btn-ghost text-2xs px-1" title="Copy"
    >
      {ok ? <span className="text-emerald-400 text-2xs">copied</span> : <Copy className="size-3" />}
    </button>
  );
}

function StateBadge({ state, error }: { state: VpnServerState; error: string | null }) {
  const cls =
    state === "running" ? "text-emerald-300 border-emerald-500/40 bg-emerald-500/10"
    : state === "starting" ? "text-amber-300 border-amber-500/40 bg-amber-500/10"
    : state === "error" ? "text-red-300 border-red-500/40 bg-red-500/10"
    : "text-fg-muted border-border";
  return (
    <span className={"text-2xs px-1.5 py-0.5 rounded border whitespace-nowrap " + cls} title={error ?? undefined}>
      {state}
    </span>
  );
}
