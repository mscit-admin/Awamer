/**
 * SSH Tunnels — server-managed local port forwarding (ssh -L).
 *
 * Create a forward: the server listens on a local port and pipes traffic
 * through a host's SSH connection to a destination reachable from that host
 * (e.g. an internal database or web UI behind a bastion). Requires
 * sessions:connect. Binding to all interfaces is admin-only.
 */
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  Cable, Loader2, Plus, Trash2, AlertCircle, ArrowRight, Globe, Lock, RefreshCw,
} from "lucide-react";
import { tunnelsApi, type Tunnel } from "../api/tunnelsApi";
import { hostsApi, type Host } from "../api/sessionsApi";
import { useAuthStore } from "@/modules/auth/store/authStore";
import { ApiError } from "@/shared/lib/api";

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function TunnelsPage() {
  const user = useAuthStore((s) => s.user);
  const isAdmin = user?.role === "admin" || user?.role === "super_admin";

  const [hosts, setHosts] = useState<Host[]>([]);
  const [tunnels, setTunnels] = useState<Tunnel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [hostId, setHostId] = useState("");
  const [listenPort, setListenPort] = useState<number | "">("");
  const [dstHost, setDstHost] = useState("127.0.0.1");
  const [dstPort, setDstPort] = useState<number | "">("");
  const [bindPublic, setBindPublic] = useState(false);
  const [creating, setCreating] = useState(false);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function refresh() {
    try {
      const r = await tunnelsApi.list();
      setTunnels(r.data);
    } catch { /* keep last state */ }
  }

  useEffect(() => {
    Promise.all([hostsApi.list({ limit: 200 }), tunnelsApi.list()])
      .then(([h, t]) => { setHosts(h.data); setTunnels(t.data); })
      .catch((e) => setError(e instanceof Error ? e.message : "failed to load"))
      .finally(() => setLoading(false));
    pollRef.current = setInterval(refresh, 4000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  async function create(e: FormEvent) {
    e.preventDefault();
    if (!hostId || !listenPort || !dstHost.trim() || !dstPort) return;
    setCreating(true);
    setError(null);
    try {
      await tunnelsApi.create({
        host_id: hostId,
        listen_port: Number(listenPort),
        dst_host: dstHost.trim(),
        dst_port: Number(dstPort),
        bind_public: bindPublic,
      });
      setListenPort(""); setDstPort("");
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : "create failed");
    } finally {
      setCreating(false);
    }
  }

  async function stop(id: string) {
    setTunnels((ts) => ts.filter((t) => t.id !== id)); // optimistic
    try { await tunnelsApi.remove(id); } catch { await refresh(); }
  }

  return (
    <div className="max-w-4xl mx-auto py-6 px-4 animate-fade-in">
      <div className="flex items-center gap-3 mb-6">
        <div className="size-10 rounded-md bg-bg-elevated border border-border grid place-items-center">
          <Cable className="size-5 text-accent" />
        </div>
        <div>
          <h1 className="text-xl font-semibold leading-tight">SSH Tunnels</h1>
          <p className="text-sm text-fg-muted mt-0.5">Forward a local port through a host to a destination behind it.</p>
        </div>
      </div>

      {/* Create form */}
      <form onSubmit={create} className="card p-4 mb-4 space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="sm:col-span-2">
            <label className="block text-xs text-fg-muted mb-1">Via host (SSH)</label>
            <select value={hostId} onChange={(e) => setHostId(e.target.value)} className="input w-full">
              <option value="">Select a host…</option>
              {hosts.map((h) => (
                <option key={h.id} value={h.id}>{h.name} ({h.hostname}:{h.port})</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-fg-muted mb-1">Local listen port</label>
            <input type="number" min={1024} max={65535} value={listenPort}
              onChange={(e) => setListenPort(e.target.value === "" ? "" : Number(e.target.value))}
              placeholder="15432" className="input w-full" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-xs text-fg-muted mb-1">Destination host</label>
              <input value={dstHost} onChange={(e) => setDstHost(e.target.value)} placeholder="10.0.0.5" className="input w-full font-mono" />
            </div>
            <div>
              <label className="block text-xs text-fg-muted mb-1">Dest. port</label>
              <input type="number" min={1} max={65535} value={dstPort}
                onChange={(e) => setDstPort(e.target.value === "" ? "" : Number(e.target.value))}
                placeholder="5432" className="input w-full" />
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between flex-wrap gap-2">
          <label className={"flex items-center gap-2 text-xs " + (isAdmin ? "text-fg-muted" : "text-fg-subtle")}>
            <input type="checkbox" checked={bindPublic} disabled={!isAdmin}
              onChange={(e) => setBindPublic(e.target.checked)} className="accent-accent" />
            Bind to all interfaces (0.0.0.0){!isAdmin && " — admin only"}
            {bindPublic ? <Globe className="size-3.5 text-amber-400" /> : <Lock className="size-3.5" />}
          </label>
          <button type="submit" disabled={creating || !hostId || !listenPort || !dstPort} className="btn-primary">
            {creating ? <><Loader2 className="size-4 animate-spin" /> Starting…</> : <><Plus className="size-4" /> Create tunnel</>}
          </button>
        </div>
        <p className="text-2xs text-fg-muted">
          The port opens on the <span className="font-medium">server</span>
          {bindPublic ? " and is reachable from anywhere that can reach it (firewall permitting)." : ", reachable only from the server itself (127.0.0.1)."}
          {" "}Tunnels are in-memory and stop if the server restarts.
        </p>
      </form>

      {error && (
        <div className="mb-4 px-3 py-2 bg-red-500/10 border border-red-500/30 text-red-300 text-xs rounded flex items-center gap-2">
          <AlertCircle className="size-3.5" /> {error}
        </div>
      )}

      {/* Active tunnels */}
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-semibold text-fg-muted">Active tunnels</h2>
        <button onClick={refresh} className="btn-ghost text-2xs"><RefreshCw className="size-3" /> Refresh</button>
      </div>

      {loading ? (
        <div className="card p-8 text-center text-fg-muted text-sm flex items-center justify-center gap-2">
          <Loader2 className="size-4 animate-spin" /> Loading…
        </div>
      ) : tunnels.length === 0 ? (
        <div className="card p-8 text-center text-fg-muted text-sm">No active tunnels.</div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-2xs uppercase text-fg-muted border-b border-border">
              <tr>
                <th className="text-left font-medium px-3 py-2">Forward</th>
                <th className="text-left font-medium px-3 py-2">Via</th>
                <th className="text-left font-medium px-3 py-2">Status</th>
                <th className="text-left font-medium px-3 py-2">Conns</th>
                <th className="text-left font-medium px-3 py-2">Traffic</th>
                <th className="px-3 py-2 w-16"></th>
              </tr>
            </thead>
            <tbody>
              {tunnels.map((t) => (
                <tr key={t.id} className="border-b border-border/50 hover:bg-bg-elevated/40">
                  <td className="px-3 py-2 font-mono text-xs whitespace-nowrap">
                    <span className="inline-flex items-center gap-1">
                      {t.listen_host}:{t.listen_port}
                      <ArrowRight className="size-3 text-fg-subtle" />
                      {t.dst_host}:{t.dst_port}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-fg-muted truncate max-w-[140px]">{t.host_label}</td>
                  <td className="px-3 py-2">
                    <span className={
                      "text-2xs px-1.5 py-0.5 rounded border " +
                      (t.status === "active" ? "text-emerald-300 border-emerald-500/40 bg-emerald-500/10"
                        : t.status === "error" ? "text-red-300 border-red-500/40 bg-red-500/10"
                        : "text-fg-muted border-border")
                    } title={t.error ?? undefined}>
                      {t.status}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-xs text-fg-muted">{t.connections} <span className="text-fg-subtle">({t.active} live)</span></td>
                  <td className="px-3 py-2 text-xs text-fg-muted whitespace-nowrap">↓{fmtBytes(t.bytes_in)} ↑{fmtBytes(t.bytes_out)}</td>
                  <td className="px-3 py-2 text-right">
                    <button onClick={() => stop(t.id)} className="btn-ghost text-xs text-red-400" title="Stop tunnel">
                      <Trash2 className="size-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
