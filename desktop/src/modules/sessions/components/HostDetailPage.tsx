import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft, Edit3, Star, Trash2, Play, Clock,
  Server, KeyRound, FolderIcon, Tag as TagIconCmp, ShieldCheck, ShieldOff,
  HardDrive as HardDriveIcon,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import {
  hostsApi, credentialsApi, historyApi,
  type Host, type CredentialPublic, type ConnectionHistoryEntry,
  type HostProtocol,
} from "../api/sessionsApi";
import { useCan } from "@/shared/lib/permissions";
import { useAuthStore } from "@/modules/auth/store/authStore";
import { launchNativeRdp, rdpNativeAvailable } from "../api/rdpNative";

const PROTOCOL_ICONS: Record<HostProtocol, string> = {
  ssh: "🔒", sftp: "📁", rdp: "🖥️", vnc: "📺",
  telnet: "📡", serial: "🔌", http: "🌐", https: "🔐", custom: "❓",
};

const STATUS_COLORS: Record<string, string> = {
  closed: "text-fg-muted",
  authenticated: "text-emerald-400",
  connected: "text-emerald-400",
  started: "text-sky-400",
  failed: "text-red-400",
  timeout: "text-amber-400",
};

export function HostDetailPage() {
  const navigate = useNavigate();
  const myId = useAuthStore((s) => s.user?.id);
  const canWrite = useCan("resources:write");
  const canConnect = useCan("sessions:connect");
  const canReveal = useCan("credentials:reveal");
  const params = useParams<{ id: string }>();
  const [host, setHost] = useState<Host | null>(null);
  const [credential, setCredential] = useState<CredentialPublic | null>(null);
  const [history, setHistory] = useState<ConnectionHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Record<string, unknown> | null>(null);
  const [knownHostFp, setKnownHostFp] = useState<string | null>(null);

  useEffect(() => {
    if (!params.id) return;
    void load(params.id);
  }, [params.id]);

  async function load(id: string) {
    setLoading(true);
    setError(null);
    try {
      const h = await hostsApi.get(id);
      setHost(h);
      const [credP, histP] = await Promise.allSettled([
        h.credential_id ? credentialsApi.get(h.credential_id) : Promise.resolve(null),
        historyApi.list({ host_id: id, limit: 20 }),
      ]);
      if (credP.status === "fulfilled") setCredential(credP.value);
      if (histP.status === "fulfilled") setHistory(histP.value.data);

      // Phase 3b: also fetch the known-hosts fingerprint (SSH hosts only).
      if (h.protocol === "ssh") {
        try {
          const fp = await invoke<string | null>("ssh_get_known_host", {
            host: h.hostname, port: h.port,
          });
          setKnownHostFp(fp);
        } catch {
          // Not running in Tauri (e.g. plain browser) — just skip.
          setKnownHostFp(null);
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }

  async function handleForgetKnownHost() {
    if (!host) return;
    if (!confirm(`Forget the stored SSH host key for ${host.hostname}:${host.port}? The next connection will re-pin a new key.`)) return;
    try {
      await invoke("ssh_forget_known_host", { host: host.hostname, port: host.port });
      setKnownHostFp(null);
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to forget host key");
    }
  }

  async function toggleFavorite() {
    if (!host) return;
    try {
      const r = await hostsApi.toggleFavorite(host.id);
      setHost({ ...host, is_favorite: r.is_favorite });
    } catch { /* ignore */ }
  }

  async function handleDelete() {
    if (!host || !confirm(`Delete "${host.name}"?`)) return;
    await hostsApi.delete(host.id);
    navigate("/hosts");
  }

  async function revealSecret() {
    if (!credential) return;
    try {
      const full = await credentialsApi.get(credential.id, true);
      setRevealed(full.secret_data ?? {});
    } catch (e) {
      alert(e instanceof Error ? e.message : "Reveal failed");
    }
  }

  if (loading) {
    return <div className="px-8 py-8 text-sm text-fg-muted">Loading…</div>;
  }
  if (error || !host) {
    return (
      <div className="px-8 py-8 max-w-2xl">
        <button onClick={() => navigate("/hosts")} className="btn-ghost -ml-3 mb-4 text-xs">
          <ArrowLeft className="size-3.5" /> Back to hosts
        </button>
        <div className="text-sm text-red-500">{error ?? "Not found"}</div>
      </div>
    );
  }

  const isOwner = !host.owner_id || host.owner_id === myId;

  return (
    <div className="max-w-3xl mx-auto py-8 px-6 animate-fade-in">
      <button onClick={() => navigate("/hosts")} className="btn-ghost -ml-3 mb-4 text-xs">
        <ArrowLeft className="size-3.5" /> Back to hosts
      </button>

      {/* Header */}
      <div className="flex items-start gap-4 mb-6">
        <div className="size-14 rounded-lg bg-bg-elevated grid place-items-center text-2xl overflow-hidden shrink-0">
          {typeof host.options?.logo === "string"
            ? <img src={host.options.logo as string} alt="" className="size-full object-contain" />
            : PROTOCOL_ICONS[host.protocol]}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight">{host.name}</h1>
            {host.is_favorite && <Star className="size-4 text-yellow-400 fill-yellow-400" />}
            {host.is_shared && (
              <span className="text-[11px] px-2 py-0.5 rounded-full bg-accent/15 border border-accent/30 text-accent">
                {isOwner ? "Shared" : "Shared with you"}
              </span>
            )}
          </div>
          <div className="text-sm text-fg-muted font-mono">
            {host.protocol}://{host.hostname}:{host.port}
          </div>
          {host.description && (
            <div className="text-sm text-fg-muted mt-1">{host.description}</div>
          )}
        </div>
        {canWrite && isOwner && (
        <div className="flex gap-2">
          <button onClick={toggleFavorite} className="btn-ghost" title="Toggle favorite">
            <Star className={"size-4 " + (host.is_favorite ? "text-yellow-400 fill-yellow-400" : "")} />
          </button>
          <Link to={`/hosts/${host.id}/edit`} className="btn-ghost">
            <Edit3 className="size-4" /> Edit
          </Link>
          <button onClick={handleDelete} className="btn-ghost text-red-500 hover:text-red-400">
            <Trash2 className="size-4" /> Delete
          </button>
        </div>
        )}
      </div>

      {/* Connect buttons */}
      {canConnect && (
      <div className="card p-4 mb-6 flex items-center gap-3">
        <div className="size-9 rounded bg-accent/10 grid place-items-center">
          <Play className="size-4 text-accent" />
        </div>
        <div className="flex-1">
          <div className="text-sm font-medium">Connect to host</div>
          <div className="text-xs text-fg-muted">
            {host.protocol === "ssh"
              ? "Open an interactive SSH terminal, or browse files over SFTP."
              : host.protocol === "sftp"
                ? "Browse, upload and download files over SFTP."
                : host.protocol === "vnc"
                  ? "Open the remote desktop over VNC."
                  : host.protocol === "rdp"
                    ? "Open the remote desktop over RDP — in the app, or with your computer's own RDP client."
                  : host.protocol === "telnet"
                    ? "Open an interactive Telnet terminal."
                    : (host.protocol === "http" || host.protocol === "https")
                      ? "Open the web service in a new tab."
                      : `${host.protocol.toUpperCase()} is not supported yet.`}
          </div>
        </div>
        {host.protocol === "ssh" && (
          <>
            <button onClick={() => navigate(`/hosts/${host.id}/sftp`)} className="btn-ghost" title="Browse files via SFTP">
              <HardDriveIcon className="size-3.5" /> SFTP
            </button>
            <button onClick={() => navigate(`/hosts/${host.id}/terminal`)} className="btn-primary" title="Open SSH terminal">
              Connect
            </button>
          </>
        )}
        {host.protocol === "sftp" && (
          <button onClick={() => navigate(`/hosts/${host.id}/sftp`)} className="btn-primary" title="Browse files via SFTP">
            <HardDriveIcon className="size-3.5" /> Browse files
          </button>
        )}
        {host.protocol === "vnc" && (
          <button onClick={() => navigate(`/hosts/${host.id}/vnc`)} className="btn-primary" title="Open remote desktop">
            Open desktop
          </button>
        )}
        {host.protocol === "rdp" && (
          <>
            {rdpNativeAvailable && (
              <button
                onClick={() => {
                  launchNativeRdp({
                    host: host.hostname, port: host.port,
                    username: credential?.username ?? null, name: host.name,
                  }).catch((e) => alert(e instanceof Error ? e.message : "could not launch the RDP client"));
                }}
                className="btn-ghost" title="Open with your computer's RDP client"
              >
                RDP client
              </button>
            )}
            <button onClick={() => navigate(`/hosts/${host.id}/rdp`)} className="btn-primary" title="Open remote desktop in the app">
              Open desktop
            </button>
          </>
        )}
        {host.protocol === "telnet" && (
          <button onClick={() => navigate(`/hosts/${host.id}/telnet`)} className="btn-primary" title="Open Telnet terminal">
            Connect
          </button>
        )}
        {(host.protocol === "http" || host.protocol === "https") && (
          <a
            href={`${host.protocol}://${host.hostname}:${host.port}`}
            target="_blank" rel="noreferrer noopener"
            className="btn-primary" title="Open in browser"
          >
            Open
          </a>
        )}
        {!["ssh", "sftp", "vnc", "rdp", "telnet", "http", "https"].includes(host.protocol) && (
          <span className="text-xs text-fg-muted">Not supported yet</span>
        )}
      </div>
      )}

      {/* Metadata grid */}
      <div className="grid grid-cols-2 gap-3 mb-6">
        <InfoCell icon={<Server className="size-3.5" />} label="Hostname" value={host.hostname} mono />
        <InfoCell icon={<Server className="size-3.5" />} label="Port" value={String(host.port)} mono />
        <InfoCell
          icon={<FolderIcon className="size-3.5" />}
          label="Folder"
          value={host.folder_id ?? "— Unfiled —"}
          mono={!!host.folder_id}
        />
        <InfoCell
          icon={<Clock className="size-3.5" />}
          label="Last used"
          value={host.last_used_at ? new Date(host.last_used_at).toLocaleString() : "Never"}
        />
        <InfoCell
          icon={<TagIconCmp className="size-3.5" />}
          label="Tags"
          value={host.tags.length === 0 ? "—" : host.tags.map((t) => t.name).join(", ")}
        />
        <InfoCell
          icon={<Server className="size-3.5" />}
          label="Use count"
          value={String(host.use_count)}
        />
      </div>

      {/* Credential */}
      {credential && (
        <div className="card p-4 mb-6">
          <div className="text-xs uppercase tracking-wide text-fg-muted mb-2 flex items-center gap-1.5">
            <KeyRound className="size-3.5" /> Credential
          </div>
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-medium">{credential.name}</div>
              <div className="text-xs text-fg-muted">
                <span className="font-mono">{credential.credentialType}</span>
                {credential.username && <> · user <span className="font-mono">{credential.username}</span></>}
              </div>
            </div>
            {!revealed && credential.hasSecret && canReveal && (
              <button onClick={revealSecret} className="btn-ghost text-xs">Reveal secret</button>
            )}
          </div>
          {revealed && (
            <pre className="mt-3 bg-bg p-3 rounded font-mono text-2xs overflow-x-auto border border-border">
              {JSON.stringify(revealed, null, 2)}
            </pre>
          )}
        </div>
      )}

      {/* Known SSH host key (Phase 3b — TOFU) */}
      {host.protocol === "ssh" && (
        <div className="card p-4 mb-6">
          <div className="text-xs uppercase tracking-wide text-fg-muted mb-2 flex items-center gap-1.5">
            {knownHostFp ? <ShieldCheck className="size-3.5 text-emerald-400" /> : <ShieldOff className="size-3.5 text-fg-muted" />}
            Host key (TOFU)
          </div>
          {knownHostFp ? (
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">Trusted</div>
                <div className="text-2xs font-mono text-fg-muted break-all">{knownHostFp}</div>
              </div>
              <button onClick={handleForgetKnownHost} className="btn-ghost text-xs">
                Forget
              </button>
            </div>
          ) : (
            <div className="text-sm text-fg-muted">
              No host key stored yet. The first SSH connection will pin one
              automatically, and subsequent connections will verify against it.
            </div>
          )}
        </div>
      )}

      {/* Recent connections */}
      <div className="card p-4">
        <div className="text-xs uppercase tracking-wide text-fg-muted mb-2 flex items-center gap-1.5">
          <Clock className="size-3.5" /> Recent connections
        </div>
        {history.length === 0 ? (
          <div className="text-sm text-fg-muted py-2">
            No connection history yet. Phase 3+ will populate this when you connect.
          </div>
        ) : (
          <div className="divide-y divide-border -mx-4">
            {history.map((h) => (
              <div key={h.id} className="px-4 py-2 flex items-center justify-between text-sm">
                <div>
                  <div className={STATUS_COLORS[h.status] ?? ""}>
                    {h.status}
                  </div>
                  <div className="text-xs text-fg-muted">
                    {new Date(h.started_at).toLocaleString()}
                    {h.duration_ms !== null && <> · {formatDuration(h.duration_ms)}</>}
                  </div>
                </div>
                {h.error_message && (
                  <div className="text-xs text-red-400 max-w-xs truncate" title={h.error_message}>
                    {h.error_message}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function InfoCell({ icon, label, value, mono }: { icon: React.ReactNode; label: string; value: string; mono?: boolean }) {
  return (
    <div className="card p-3">
      <div className="text-2xs uppercase tracking-wider text-fg-muted flex items-center gap-1.5">
        {icon} {label}
      </div>
      <div className={"text-sm mt-1 " + (mono ? "font-mono truncate" : "")} title={value}>
        {value}
      </div>
    </div>
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}
