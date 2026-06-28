import { type FormEvent, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Save, Trash2 } from "lucide-react";
import {
  hostsApi, foldersApi, tagsApi, credentialsApi,
  type Folder, type Tag, type CredentialPublic,
  type HostProtocol,
} from "../api/sessionsApi";

const PROTOCOLS: HostProtocol[] = ["ssh", "sftp", "rdp", "vnc", "telnet", "serial", "http", "https", "custom"];
const DEFAULT_PORTS: Record<HostProtocol, number> = {
  ssh: 22, sftp: 22, rdp: 3389, vnc: 5900,
  telnet: 23, serial: 0, http: 80, https: 443, custom: 0,
};

export function HostFormPage({ mode }: { mode: "create" | "edit" }) {
  const navigate = useNavigate();
  const params = useParams<{ id: string }>();
  const isEdit = mode === "edit";

  const [name, setName] = useState("");
  const [hostname, setHostname] = useState("");
  const [port, setPort] = useState<number | "">("");
  const [protocol, setProtocol] = useState<HostProtocol>("ssh");
  const [folderId, setFolderId] = useState<string>("");
  const [credentialId, setCredentialId] = useState<string>("");
  const [description, setDescription] = useState("");
  const [isShared, setIsShared] = useState(false);
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [credentials, setCredentials] = useState<CredentialPublic[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const [f, t, c] = await Promise.all([
        foldersApi.list(), tagsApi.list(), credentialsApi.list(),
      ]);
      setFolders(f.data);
      setTags(t.data);
      setCredentials(c.data);

      if (isEdit && params.id) {
        try {
          const host = await hostsApi.get(params.id);
          setName(host.name);
          setHostname(host.hostname);
          setPort(host.port);
          setProtocol(host.protocol);
          setFolderId(host.folder_id ?? "");
          setCredentialId(host.credential_id ?? "");
          setDescription(host.description ?? "");
          setIsShared(host.is_shared);
          setTagIds(host.tags.map((tg) => tg.id));
        } catch (e) {
          setError(e instanceof Error ? e.message : "Failed to load host");
        }
      }
    })();
  }, [isEdit, params.id]);

  function onProtocolChange(p: HostProtocol) {
    setProtocol(p);
    if (port === "" || !port) setPort(DEFAULT_PORTS[p] || "");
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const payload = {
        name: name.trim(),
        hostname: hostname.trim(),
        port: port === "" ? DEFAULT_PORTS[protocol] : Number(port),
        protocol,
        folder_id: folderId || null,
        credential_id: credentialId || null,
        description: description.trim() || null,
        is_shared: isShared,
        tag_ids: tagIds,
      };
      if (isEdit && params.id) {
        await hostsApi.update(params.id, payload);
      } else {
        await hostsApi.create(payload);
      }
      navigate("/hosts");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    if (!params.id || !confirm("Delete this host? This cannot be undone.")) return;
    try {
      await hostsApi.delete(params.id);
      navigate("/hosts");
    } catch (e) {
      alert(e instanceof Error ? e.message : "Delete failed");
    }
  }

  return (
    <div className="max-w-2xl mx-auto py-8 px-6 animate-slide-up">
      <button onClick={() => navigate("/hosts")} className="btn-ghost -ml-3 mb-4 text-xs">
        <ArrowLeft className="size-3.5" /> Back to hosts
      </button>

      <h1 className="text-xl font-semibold tracking-tight mb-1">
        {isEdit ? "Edit host" : "New host"}
      </h1>
      <p className="text-sm text-fg-muted mb-6">
        Hosts are remote endpoints. Phase 3+ protocol handlers (SSH, RDP, …) use this metadata to connect.
      </p>

      <form onSubmit={handleSubmit} className="space-y-4">
        {error && (
          <div className="text-sm text-red-500 bg-red-500/10 border border-red-500/30 rounded p-3">
            {error}
          </div>
        )}

        <Field label="Name" required>
          <input
            value={name} onChange={(e) => setName(e.target.value)}
            placeholder="e.g. web01"
            required maxLength={100}
            className="input"
          />
        </Field>

        <div className="grid grid-cols-12 gap-3">
          <Field label="Protocol" className="col-span-3" required>
            <select value={protocol} onChange={(e) => onProtocolChange(e.target.value as HostProtocol)} className="input">
              {PROTOCOLS.map((p) => <option key={p} value={p}>{p.toUpperCase()}</option>)}
            </select>
          </Field>
          <Field label="Hostname / IP" className="col-span-6" required>
            <input
              value={hostname} onChange={(e) => setHostname(e.target.value)}
              placeholder="e.g. 10.0.0.5 or web01.example.com"
              required maxLength={253}
              className="input font-mono"
            />
          </Field>
          <Field label="Port" className="col-span-3" required>
            <input
              type="number" min={1} max={65535}
              value={port} onChange={(e) => setPort(e.target.value === "" ? "" : Number(e.target.value))}
              placeholder={String(DEFAULT_PORTS[protocol])}
              required
              className="input"
            />
          </Field>
        </div>

        <Field label="Folder">
          <select value={folderId} onChange={(e) => setFolderId(e.target.value)} className="input">
            <option value="">— Unfiled —</option>
            {folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </Field>

        <Field label="Credential">
          <select value={credentialId} onChange={(e) => setCredentialId(e.target.value)} className="input">
            <option value="">— None —</option>
            {credentials.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.credentialType})
              </option>
            ))}
          </select>
        </Field>

        <Field label="Description">
          <textarea
            value={description} onChange={(e) => setDescription(e.target.value)}
            placeholder="Optional notes…"
            rows={2} maxLength={1000}
            className="input resize-y"
          />
        </Field>

        <Field label="Sharing">
          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={isShared}
              onChange={(e) => setIsShared(e.target.checked)}
              className="mt-0.5"
            />
            <span className="text-sm">
              Share with all users
              <span className="block text-xs text-fg-muted">
                Everyone can see and connect to this asset using its linked
                credential. Only you can edit or delete it.
              </span>
            </span>
          </label>
        </Field>

        <Field label="Tags">
          <div className="flex flex-wrap gap-1.5">
            {tags.length === 0 && <span className="text-xs text-fg-muted">No tags yet.</span>}
            {tags.map((t) => {
              const selected = tagIds.includes(t.id);
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setTagIds((arr) =>
                    arr.includes(t.id) ? arr.filter((x) => x !== t.id) : [...arr, t.id]
                  )}
                  className={
                    "text-xs px-2 py-1 rounded border flex items-center gap-1 " +
                    (selected
                      ? "bg-accent/10 border-accent/30 text-accent"
                      : "bg-bg-elevated border-border text-fg hover:border-accent/50")
                  }
                >
                  <span className="inline-block size-2 rounded-full" style={{ background: t.color ?? "#888" }} />
                  {t.name}
                </button>
              );
            })}
          </div>
        </Field>

        <div className="flex justify-between pt-2">
          {isEdit ? (
            <button type="button" onClick={handleDelete} className="btn-ghost text-red-500 hover:text-red-400">
              <Trash2 className="size-3.5" /> Delete
            </button>
          ) : <span />}
          <div className="flex gap-2">
            <button type="button" onClick={() => navigate("/hosts")} className="btn-ghost">
              Cancel
            </button>
            <button type="submit" disabled={busy || !name || !hostname} className="btn-primary">
              <Save className="size-4" /> {busy ? "Saving…" : isEdit ? "Save changes" : "Create host"}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}

function Field({ label, required, children, className }: { label: string; required?: boolean; children: React.ReactNode; className?: string }) {
  return (
    <label className={className ?? "block"}>
      <div className="text-xs text-fg-muted mb-1">
        {label} {required && <span className="text-red-500">*</span>}
      </div>
      {children}
    </label>
  );
}
