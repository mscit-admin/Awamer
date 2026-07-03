import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  KeyRound, Plus, Trash2, Eye, EyeOff, ShieldCheck, X, Import,
  Star, Folder as FolderIcon, Clock, RefreshCw, Copy, Check,
  Timer, Paperclip, Download, Upload,
} from "lucide-react";
import {
  credentialsApi, foldersApi,
  type CredentialPublic, type CredentialType, type CredentialFieldInput, type Folder,
  type CredentialTotpConfig, type CredentialAttachmentMeta, type TotpAlgorithm,
} from "../api/sessionsApi";
import { CredentialActions } from "./CredentialActions";
import {
  generatePassword, estimateEntropyBits, DEFAULT_PASSWORD_OPTIONS, type PasswordOptions,
} from "../lib/passwordGenerator";
import { computeTotp } from "../lib/totp";
import { useCan } from "@/shared/lib/permissions";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

const CREDENTIAL_TYPES: { value: CredentialType; label: string; description: string }[] = [
  { value: "password",    label: "Password",    description: "Username + password (SSH, RDP)" },
  { value: "private_key", label: "Private key", description: "SSH key (OpenSSH or PEM)" },
  { value: "certificate", label: "Certificate", description: "X.509 client cert + key" },
  { value: "agent",       label: "SSH Agent",   description: "Delegate to ssh-agent" },
  { value: "kerberos",    label: "Kerberos",    description: "GSSAPI / Kerberos ticket" },
  { value: "none",        label: "None",        description: "Interactive prompts only" },
];

/** A local, editable custom-field row. */
interface FieldRow { key: string; label: string; value: string; isSecret: boolean }

function isExpired(iso: string | null): boolean {
  return !!iso && new Date(iso).getTime() < Date.now();
}
function expiresSoon(iso: string | null): boolean {
  if (!iso) return false;
  const ms = new Date(iso).getTime() - Date.now();
  return ms > 0 && ms < 14 * 24 * 3600 * 1000;
}

let toastSeq = 0;

export function CredentialsPage() {
  const canWrite = useCan("resources:write");
  const canReveal = useCan("credentials:reveal");
  const [credentials, setCredentials] = useState<CredentialPublic[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [editing, setEditing] = useState<CredentialPublic | "new" | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [folderFilter, setFolderFilter] = useState<string>("all");
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [toasts, setToasts] = useState<{ id: number; text: string }[]>([]);

  function notify(text: string) {
    const id = ++toastSeq;
    setToasts((t) => [...t, { id, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 2500);
  }

  useEffect(() => { void load(); }, []);

  async function load() {
    setLoading(true);
    try {
      const [creds, folderRes] = await Promise.all([credentialsApi.list(), foldersApi.list()]);
      setCredentials(creds.data);
      setFolders(folderRes.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }

  const folderName = useMemo(() => {
    const m = new Map(folders.map((f) => [f.id, f.name]));
    return (id: string | null) => (id ? m.get(id) ?? "Unknown folder" : null);
  }, [folders]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return credentials.filter((c) => {
      if (favoritesOnly && !c.favorite) return false;
      if (folderFilter === "root" && c.folderId) return false;
      if (folderFilter !== "all" && folderFilter !== "root" && c.folderId !== folderFilter) return false;
      if (q && !(c.name.toLowerCase().includes(q) || (c.username ?? "").toLowerCase().includes(q))) return false;
      return true;
    });
  }, [credentials, favoritesOnly, folderFilter, query]);

  async function toggleFavorite(c: CredentialPublic) {
    try {
      const updated = await credentialsApi.update(c.id, { favorite: !c.favorite });
      setCredentials((arr) => arr.map((x) => (x.id === c.id ? { ...x, favorite: updated.favorite } : x)));
    } catch (e) {
      alert(e instanceof Error ? e.message : "Update failed");
    }
  }

  async function handleDelete(c: CredentialPublic) {
    if (!confirm(`Delete credential "${c.name}"? Hosts using it will lose their credential reference.`)) return;
    try {
      await credentialsApi.delete(c.id);
      setCredentials((arr) => arr.filter((x) => x.id !== c.id));
    } catch (e) {
      alert(e instanceof Error ? e.message : "Delete failed");
    }
  }

  return (
    <div className="max-w-4xl mx-auto py-8 px-6 animate-fade-in">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-xl font-semibold tracking-tight">Credentials</h1>
        {canWrite && (
          <div className="flex items-center gap-2">
            <Link to="/credentials/import/keepass" className="btn-ghost text-xs"><Import className="size-3.5" /> Import from KeePass</Link>
            <button onClick={() => setEditing("new")} className="btn-primary">
              <Plus className="size-4" /> New credential
            </button>
          </div>
        )}
      </div>
      <p className="text-sm text-fg-muted mb-4">
        A vault for authentication material — passwords, keys, custom fields and notes.
        One credential can be reused across many hosts.
      </p>

      <div className="text-2xs bg-emerald-500/10 border border-emerald-500/30 text-emerald-200 px-3 py-2 rounded mb-6 flex items-start gap-2">
        <ShieldCheck className="size-3.5 mt-px shrink-0" />
        <div>
          <span className="font-semibold">Encrypted at rest:</span> secret material and custom-field
          values are sealed with AES-256-GCM authenticated encryption before they reach PostgreSQL —
          only the envelope (IV, tag, ciphertext) is stored. The data key is held by the server
          (<span className="font-mono">CREDENTIAL_ENCRYPTION_KEY</span>).
        </div>
      </div>

      {error && (
        <div className="text-sm text-red-500 bg-red-500/10 border border-red-500/30 rounded p-3 mb-4">{error}</div>
      )}

      {/* Filters */}
      {credentials.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 mb-4">
          <input
            value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name or username…"
            className="input flex-1 min-w-[12rem] h-9"
          />
          <select value={folderFilter} onChange={(e) => setFolderFilter(e.target.value)} className="input h-9 w-auto">
            <option value="all">All folders</option>
            <option value="root">No folder</option>
            {folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
          <button
            onClick={() => setFavoritesOnly((b) => !b)}
            className={`btn-ghost h-9 ${favoritesOnly ? "text-amber-400" : ""}`}
            title="Show favorites only"
          >
            <Star className={`size-4 ${favoritesOnly ? "fill-amber-400" : ""}`} /> Favorites
          </button>
        </div>
      )}

      {loading ? (
        <div className="text-sm text-fg-muted">Loading…</div>
      ) : credentials.length === 0 ? (
        <div className="card p-8 text-center">
          <KeyRound className="size-8 mx-auto text-fg-muted mb-2" />
          <div className="font-medium text-sm mb-1">No credentials yet</div>
          <p className="text-xs text-fg-muted mb-4">Add a credential, then attach it to one or more hosts.</p>
          {canWrite && <button onClick={() => setEditing("new")} className="btn-primary inline-flex">
            <Plus className="size-4" /> New credential
          </button>}
        </div>
      ) : visible.length === 0 ? (
        <div className="card p-8 text-center text-sm text-fg-muted">No credentials match your filters.</div>
      ) : (
        <div className="card divide-y divide-border">
          {visible.map((c) => (
            <div key={c.id} className="px-4 py-3 flex items-center gap-3">
              {canWrite ? (
                <button onClick={() => toggleFavorite(c)} className="btn-icon" title={c.favorite ? "Unfavorite" : "Favorite"}>
                  <Star className={`size-4 ${c.favorite ? "fill-amber-400 text-amber-400" : "text-fg-muted"}`} />
                </button>
              ) : (
                <div className="size-9 rounded bg-bg-elevated grid place-items-center">
                  <KeyRound className="size-4 text-fg-muted" />
                </div>
              )}
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate flex items-center gap-2">
                  {c.name}
                  {isExpired(c.expiresAt) && <span className="text-2xs bg-red-500/15 text-red-400 px-1.5 py-0.5 rounded">expired</span>}
                  {!isExpired(c.expiresAt) && expiresSoon(c.expiresAt) && <span className="text-2xs bg-amber-500/15 text-amber-400 px-1.5 py-0.5 rounded">expiring soon</span>}
                </div>
                <div className="text-xs text-fg-muted flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <span className="font-mono">{c.credentialType}</span>
                  {c.username && <>· <span className="font-mono">{c.username}</span></>}
                  {folderName(c.folderId) && <>· <span className="inline-flex items-center gap-1"><FolderIcon className="size-3" />{folderName(c.folderId)}</span></>}
                  {c.fields.length > 0 && <>· {c.fields.length} field{c.fields.length === 1 ? "" : "s"}</>}
                  {c.hasTotp && <>· <span className="inline-flex items-center gap-1 text-sky-400"><Timer className="size-3" />OTP</span></>}
                  {c.attachmentCount > 0 && <>· <span className="inline-flex items-center gap-1"><Paperclip className="size-3" />{c.attachmentCount}</span></>}
                  {c.expiresAt && <>· <span className="inline-flex items-center gap-1"><Clock className="size-3" />{new Date(c.expiresAt).toLocaleDateString()}</span></>}
                  {!c.hasSecret && <span className="text-amber-400">no secret set</span>}
                </div>
              </div>
              {canWrite && (
                <CredentialActions
                  c={c}
                  canReveal={canReveal}
                  onEdit={() => setEditing(c)}
                  onDelete={() => handleDelete(c)}
                  notify={notify}
                />
              )}
            </div>
          ))}
        </div>
      )}

      {editing && (
        <CredentialForm
          existing={editing === "new" ? null : editing}
          folders={folders}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); void load(); }}
        />
      )}

      {/* Toasts (copy feedback) */}
      <div className="fixed bottom-4 right-4 z-[70] flex flex-col gap-2 items-end">
        {toasts.map((t) => (
          <div key={t.id} className="bg-bg-surface border border-border rounded-lg shadow-xl px-3 py-2 text-sm animate-fade-in flex items-center gap-2">
            <Check className="size-3.5 text-emerald-400" /> {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}

// =====================================================================
// Password generator popover
// =====================================================================

function GeneratorButton({ onPick }: { onPick: (pw: string) => void }) {
  const [open, setOpen] = useState(false);
  const [opts, setOpts] = useState<PasswordOptions>(DEFAULT_PASSWORD_OPTIONS);
  const [preview, setPreview] = useState(() => generatePassword(DEFAULT_PASSWORD_OPTIONS));
  const [copied, setCopied] = useState(false);

  function regen(next: PasswordOptions = opts) { setPreview(generatePassword(next)); }
  function set<K extends keyof PasswordOptions>(k: K, v: PasswordOptions[K]) {
    const next = { ...opts, [k]: v }; setOpts(next); regen(next);
  }

  return (
    <div className="relative">
      <button type="button" onClick={() => { setOpen((b) => !b); regen(); }} className="btn-icon" title="Generate password">
        <RefreshCw className="size-3.5" />
      </button>
      {open && (
        <div className="absolute right-0 z-10 mt-1 w-72 bg-bg-surface border border-border rounded-lg shadow-xl p-3 space-y-2">
          <div className="flex items-center gap-2">
            <code className="flex-1 text-2xs font-mono bg-bg-elevated rounded px-2 py-1.5 break-all">{preview}</code>
            <button type="button" onClick={() => { void navigator.clipboard?.writeText(preview); setCopied(true); setTimeout(() => setCopied(false), 1200); }} className="btn-icon" title="Copy">
              {copied ? <Check className="size-3.5 text-emerald-400" /> : <Copy className="size-3.5" />}
            </button>
            <button type="button" onClick={() => regen()} className="btn-icon" title="Regenerate"><RefreshCw className="size-3.5" /></button>
          </div>
          <label className="flex items-center justify-between text-xs text-fg-muted">
            Length: <span className="font-mono text-fg">{opts.length}</span>
          </label>
          <input type="range" min={8} max={64} value={opts.length} onChange={(e) => set("length", Number(e.target.value))} className="w-full" />
          <div className="grid grid-cols-2 gap-1 text-xs">
            {([["lowercase", "a-z"], ["uppercase", "A-Z"], ["digits", "0-9"], ["symbols", "!@#"], ["avoidAmbiguous", "No look-alikes"]] as const).map(([k, lbl]) => (
              <label key={k} className="flex items-center gap-1.5 cursor-pointer">
                <input type="checkbox" checked={opts[k]} onChange={(e) => set(k, e.target.checked)} />
                {lbl}
              </label>
            ))}
          </div>
          <div className="text-2xs text-fg-muted">≈ {estimateEntropyBits(opts)} bits of entropy</div>
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={() => setOpen(false)} className="btn-ghost text-xs">Close</button>
            <button type="button" onClick={() => { onPick(preview); setOpen(false); }} className="btn-primary text-xs">Use</button>
          </div>
        </div>
      )}
    </div>
  );
}

// =====================================================================
// Credential form modal
// =====================================================================

function CredentialForm({
  existing, folders, onClose, onSaved,
}: {
  existing: CredentialPublic | null;
  folders: Folder[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const canReveal = useCan("credentials:reveal");
  const [name, setName] = useState(existing?.name ?? "");
  const [credType, setCredType] = useState<CredentialType>(existing?.credentialType ?? "password");
  const [username, setUsername] = useState(existing?.username ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [folderId, setFolderId] = useState<string>(existing?.folderId ?? "");
  const [favorite, setFavorite] = useState(existing?.favorite ?? false);
  const [expiresAt, setExpiresAt] = useState<string>(existing?.expiresAt ? existing.expiresAt.slice(0, 10) : "");
  const [secret, setSecret] = useState<Record<string, string>>({});
  const [fields, setFields] = useState<FieldRow[]>([]);
  const [fieldsLoaded, setFieldsLoaded] = useState(!existing); // new creds start "loaded" (empty)
  const [secretLoaded, setSecretLoaded] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // For editing: pre-fetch existing secret + custom fields so they can be edited
  // without being wiped on save. Requires the reveal permission.
  useEffect(() => {
    if (!existing) return;
    if (!canReveal) {
      // Can still edit metadata + fields we already know the labels of (values masked).
      setFields(existing.fields.map((f, i) => ({ key: `${f.id}-${i}`, label: f.label, value: f.value ?? "", isSecret: f.isSecret })));
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const full = await credentialsApi.get(existing.id, true);
        if (cancelled) return;
        setSecret((full.secret_data as Record<string, string>) ?? {});
        setSecretLoaded(true);
        setFields((full.fields ?? []).map((f, i) => ({ key: `${f.id}-${i}`, label: f.label, value: f.value ?? "", isSecret: f.isSecret })));
        setFieldsLoaded(true);
      } catch {
        /* leave form editable with empty secret — behaves like the legacy "leave blank to keep" */
      }
    })();
    return () => { cancelled = true; };
  }, [existing, canReveal]);

  function addField() {
    setFields((f) => [...f, { key: `new-${Date.now()}-${f.length}`, label: "", value: "", isSecret: true }]);
  }
  function updateField(key: string, patch: Partial<FieldRow>) {
    setFields((f) => f.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }
  function removeField(key: string) {
    setFields((f) => f.filter((r) => r.key !== key));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const secret_data = Object.keys(secret).length ? secret : undefined;
      const fieldPayload: CredentialFieldInput[] | undefined =
        fieldsLoaded
          ? fields
              .filter((r) => r.label.trim())
              .map((r, i) => ({ label: r.label.trim(), value: r.value, is_secret: r.isSecret, sort_order: i }))
          : undefined; // couldn't load existing fields → don't touch them

      const base = {
        name: name.trim(),
        username: username.trim() || null,
        description: description.trim() || null,
        folder_id: folderId || null,
        favorite,
        expires_at: expiresAt ? new Date(expiresAt + "T00:00:00Z").toISOString() : null,
        ...(fieldPayload ? { fields: fieldPayload } : {}),
      };

      if (existing) {
        // If we loaded the secret, always resend it (may have been edited); else only if typed.
        const sendSecret = secretLoaded ? secret : secret_data;
        await credentialsApi.update(existing.id, {
          ...base,
          ...(sendSecret !== undefined ? { secret_data: sendSecret } : {}),
        });
      } else {
        await credentialsApi.create({
          ...base,
          credential_type: credType,
          secret_data: secret_data ?? {},
        });
      }
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 grid place-items-center z-50 animate-fade-in p-4">
      <div className="bg-bg-surface border border-border rounded-lg shadow-xl w-full max-w-lg max-h-full overflow-y-auto">
        <div className="px-5 py-4 border-b border-border flex items-center justify-between">
          <h2 className="text-base font-semibold">
            {existing ? "Edit credential" : "New credential"}
          </h2>
          <button onClick={onClose} className="btn-icon"><X className="size-4" /></button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          {error && (
            <div className="text-sm text-red-500 bg-red-500/10 border border-red-500/30 rounded p-2">{error}</div>
          )}

          <div className="flex items-end gap-2">
            <label className="block flex-1">
              <div className="text-xs text-fg-muted mb-1">Name <span className="text-red-500">*</span></div>
              <input value={name} onChange={(e) => setName(e.target.value)} required className="input" />
            </label>
            <button
              type="button" onClick={() => setFavorite((b) => !b)}
              className={`btn-ghost h-9 ${favorite ? "text-amber-400" : ""}`}
              title={favorite ? "Unfavorite" : "Mark as favorite"}
            >
              <Star className={`size-4 ${favorite ? "fill-amber-400" : ""}`} />
            </button>
          </div>

          {!existing && (
            <label className="block">
              <div className="text-xs text-fg-muted mb-1">Type <span className="text-red-500">*</span></div>
              <select value={credType} onChange={(e) => { setCredType(e.target.value as CredentialType); setSecret({}); }} className="input">
                {CREDENTIAL_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>{t.label} — {t.description}</option>
                ))}
              </select>
            </label>
          )}

          {existing && (
            <div className="text-xs text-fg-muted">
              Type: <span className="font-mono">{existing.credentialType}</span>
              {" "}(type cannot be changed; delete and recreate if needed)
              {!canReveal && <div className="text-amber-400 mt-1">You lack the reveal permission — existing secret values are hidden and will be preserved unless you type new ones.</div>}
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <div className="text-xs text-fg-muted mb-1">Folder</div>
              <select value={folderId} onChange={(e) => setFolderId(e.target.value)} className="input">
                <option value="">— No folder —</option>
                {folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
            </label>
            <label className="block">
              <div className="text-xs text-fg-muted mb-1 flex items-center gap-1"><Clock className="size-3" /> Expires</div>
              <input type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} className="input" />
            </label>
          </div>

          {(credType === "password" || credType === "private_key" || credType === "certificate" || credType === "kerberos") && (
            <label className="block">
              <div className="text-xs text-fg-muted mb-1">Username</div>
              <input value={username} onChange={(e) => setUsername(e.target.value)} className="input font-mono" />
            </label>
          )}

          {/* Type-specific secret fields */}
          {credType === "password" && (
            <label className="block">
              <div className="text-xs text-fg-muted mb-1 flex items-center justify-between">
                <span>Password {existing && !secretLoaded && <span className="text-2xs">Leave blank to keep existing</span>}</span>
                <span className="flex items-center gap-1">
                  <GeneratorButton onPick={(pw) => setSecret((s) => ({ ...s, password: pw }))} />
                  <button type="button" onClick={() => setRevealed((b) => !b)} className="btn-icon">
                    {revealed ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                  </button>
                </span>
              </div>
              <input
                type={revealed ? "text" : "password"}
                value={(secret["password"] as string) ?? ""}
                onChange={(e) => setSecret((s) => ({ ...s, password: e.target.value }))}
                className="input font-mono"
                autoComplete="new-password"
              />
            </label>
          )}
          {credType === "private_key" && (
            <>
              <label className="block">
                <div className="text-xs text-fg-muted mb-1">Private key (paste PEM/OpenSSH)</div>
                <textarea
                  value={(secret["private_key"] as string) ?? ""}
                  onChange={(e) => setSecret((s) => ({ ...s, private_key: e.target.value }))}
                  rows={6} className="input font-mono text-2xs resize-y"
                  placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                />
              </label>
              <label className="block">
                <div className="text-xs text-fg-muted mb-1">Passphrase (optional)</div>
                <input
                  type="password"
                  value={(secret["passphrase"] as string) ?? ""}
                  onChange={(e) => setSecret((s) => ({ ...s, passphrase: e.target.value }))}
                  className="input font-mono"
                />
              </label>
            </>
          )}
          {credType === "certificate" && (
            <>
              <label className="block">
                <div className="text-xs text-fg-muted mb-1">Certificate (PEM)</div>
                <textarea
                  value={(secret["certificate"] as string) ?? ""}
                  onChange={(e) => setSecret((s) => ({ ...s, certificate: e.target.value }))}
                  rows={4} className="input font-mono text-2xs resize-y"
                />
              </label>
              <label className="block">
                <div className="text-xs text-fg-muted mb-1">Private key (PEM)</div>
                <textarea
                  value={(secret["private_key"] as string) ?? ""}
                  onChange={(e) => setSecret((s) => ({ ...s, private_key: e.target.value }))}
                  rows={4} className="input font-mono text-2xs resize-y"
                />
              </label>
            </>
          )}
          {credType === "agent" && (
            <div className="text-xs text-fg-muted">
              No secret data needed — your local <span className="font-mono">ssh-agent</span> will be used at connect time.
            </div>
          )}
          {credType === "kerberos" && (
            <label className="block">
              <div className="text-xs text-fg-muted mb-1">Realm (optional)</div>
              <input
                value={(secret["realm"] as string) ?? ""}
                onChange={(e) => setSecret({ realm: e.target.value })}
                className="input font-mono"
                placeholder="EXAMPLE.COM"
              />
            </label>
          )}
          {credType === "none" && (
            <div className="text-xs text-fg-muted">
              No secret stored. The user will be prompted at connect time.
            </div>
          )}

          {/* Custom fields */}
          <div>
            <div className="text-xs text-fg-muted mb-1 flex items-center justify-between">
              <span>Custom fields</span>
              <button type="button" onClick={addField} className="btn-ghost text-2xs" disabled={!fieldsLoaded && !canReveal}>
                <Plus className="size-3" /> Add field
              </button>
            </div>
            {!fieldsLoaded && !canReveal ? (
              <div className="text-2xs text-fg-muted">Custom fields are hidden — the reveal permission is required to view or edit them.</div>
            ) : fields.length === 0 ? (
              <div className="text-2xs text-fg-muted">None. Use custom fields for OTP recovery codes, account IDs, URLs, PINs, etc.</div>
            ) : (
              <div className="space-y-2">
                {fields.map((r) => (
                  <div key={r.key} className="flex items-start gap-2">
                    <input
                      value={r.label} onChange={(e) => updateField(r.key, { label: e.target.value })}
                      placeholder="Label" className="input h-9 w-1/3"
                    />
                    <input
                      type={r.isSecret ? "password" : "text"}
                      value={r.value} onChange={(e) => updateField(r.key, { value: e.target.value })}
                      placeholder="Value" className="input h-9 flex-1 font-mono"
                    />
                    <button
                      type="button" onClick={() => updateField(r.key, { isSecret: !r.isSecret })}
                      className="btn-icon" title={r.isSecret ? "Secret (masked)" : "Plain (visible)"}
                    >
                      {r.isSecret ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                    </button>
                    {r.isSecret && <GeneratorButton onPick={(pw) => updateField(r.key, { value: pw })} />}
                    <button type="button" onClick={() => removeField(r.key)} className="btn-icon hover:text-red-500"><Trash2 className="size-3.5" /></button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* OTP + attachments live on a saved credential (they need its id). */}
          {existing ? (
            <>
              <TotpSection credentialId={existing.id} canReveal={canReveal} />
              <AttachmentsSection credentialId={existing.id} canReveal={canReveal} />
            </>
          ) : (
            <div className="text-2xs text-fg-muted border border-border rounded p-2">
              <span className="inline-flex items-center gap-1"><Timer className="size-3" /> One-time passwords</span> and{" "}
              <span className="inline-flex items-center gap-1"><Paperclip className="size-3" /> file attachments</span>{" "}
              become available after you create this credential.
            </div>
          )}

          <label className="block">
            <div className="text-xs text-fg-muted mb-1">Description</div>
            <textarea
              value={description} onChange={(e) => setDescription(e.target.value)}
              rows={2} className="input resize-y"
              placeholder="Optional notes…"
            />
          </label>

          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
            <button type="submit" disabled={busy || !name} className="btn-primary">
              {busy ? "Saving…" : existing ? "Save changes" : "Create"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// =====================================================================
// TOTP (one-time password) section — code computed client-side
// =====================================================================

function TotpSection({ credentialId, canReveal }: { credentialId: string; canReveal: boolean }) {
  const [cfg, setCfg] = useState<CredentialTotpConfig | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [live, setLive] = useState<{ code: string; secondsRemaining: number; period: number } | null>(null);
  const [editing, setEditing] = useState(false);
  const [input, setInput] = useState("");
  const [digits, setDigits] = useState(6);
  const [period, setPeriod] = useState(30);
  const [algorithm, setAlgorithm] = useState<TotpAlgorithm>("SHA1");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => { void load(); /* eslint-disable-next-line */ }, [credentialId]);
  async function load() {
    try {
      const c = await credentialsApi.getTotp(credentialId);
      setCfg(c);
      if (c.enabled && canReveal) {
        const full = await credentialsApi.revealTotp(credentialId);
        setSecret(full.secret ?? null);
      }
    } catch (e) { setErr(e instanceof Error ? e.message : "Failed to load OTP"); }
  }

  // Live rolling-code loop (only when we hold the revealed secret).
  useEffect(() => {
    if (!secret || !cfg?.enabled) { setLive(null); return; }
    let active = true;
    const tick = async () => {
      try {
        const r = await computeTotp(secret, { algorithm: cfg.algorithm, digits: cfg.digits, period: cfg.period });
        if (active) setLive(r);
      } catch { /* bad secret — ignore */ }
    };
    void tick();
    const iv = setInterval(tick, 1000);
    return () => { active = false; clearInterval(iv); };
  }, [secret, cfg]);

  async function save() {
    setBusy(true); setErr(null);
    try {
      const val = input.trim();
      const isUri = val.toLowerCase().startsWith("otpauth://");
      const body = isUri ? { otpauth_uri: val } : { secret: val, digits, period, algorithm };
      const c = await credentialsApi.setTotp(credentialId, body);
      setCfg(c); setEditing(false); setInput("");
      if (canReveal) {
        const full = await credentialsApi.revealTotp(credentialId);
        setSecret(full.secret ?? null);
      }
    } catch (e) { setErr(e instanceof Error ? e.message : "Failed to save OTP"); }
    finally { setBusy(false); }
  }

  async function remove() {
    if (!confirm("Remove the one-time password from this credential?")) return;
    try {
      await credentialsApi.deleteTotp(credentialId);
      setCfg({ enabled: false }); setSecret(null); setLive(null); setEditing(false);
    } catch (e) { setErr(e instanceof Error ? e.message : "Failed to remove OTP"); }
  }

  const showForm = editing || !cfg?.enabled;
  const isUriInput = input.trim().toLowerCase().startsWith("otpauth://");

  return (
    <div className="border border-border rounded p-3">
      <div className="text-xs text-fg-muted mb-2 flex items-center justify-between">
        <span className="inline-flex items-center gap-1.5 font-medium text-fg"><Timer className="size-3.5" /> One-time password (OTP)</span>
        {cfg?.enabled && !editing && (
          <span className="flex items-center gap-1">
            <button type="button" onClick={() => setEditing(true)} className="btn-ghost text-2xs">Replace</button>
            <button type="button" onClick={remove} className="btn-ghost text-2xs hover:text-red-500">Remove</button>
          </span>
        )}
      </div>
      {err && <div className="text-2xs text-red-500 mb-2">{err}</div>}

      {/* Live code */}
      {cfg?.enabled && !editing && (
        live ? (
          <div className="flex items-center gap-3">
            <code className="text-lg font-mono tracking-widest">
              {live.code.length === 6 ? `${live.code.slice(0, 3)} ${live.code.slice(3)}` : live.code}
            </code>
            <button type="button" onClick={() => { void navigator.clipboard?.writeText(live.code); setCopied(true); setTimeout(() => setCopied(false), 1200); }} className="btn-icon" title="Copy code">
              {copied ? <Check className="size-3.5 text-emerald-400" /> : <Copy className="size-3.5" />}
            </button>
            <div className="flex-1">
              <div className="h-1 bg-bg-elevated rounded overflow-hidden">
                <div className="h-full bg-sky-400 transition-all" style={{ width: `${(live.secondsRemaining / live.period) * 100}%` }} />
              </div>
            </div>
            <span className="text-2xs text-fg-muted tabular-nums w-6 text-right">{live.secondsRemaining}s</span>
          </div>
        ) : (
          <div className="text-2xs text-fg-muted">
            OTP configured{!canReveal && " — the reveal permission is required to view codes"}.
          </div>
        )
      )}

      {/* Setup / replace form */}
      {showForm && (
        <div className="space-y-2">
          <input
            value={input} onChange={(e) => setInput(e.target.value)}
            placeholder="Paste secret (base32) or otpauth:// URI"
            className="input h-9 font-mono text-2xs"
          />
          {!isUriInput && (
            <div className="grid grid-cols-3 gap-2">
              <label className="text-2xs text-fg-muted">Digits
                <select value={digits} onChange={(e) => setDigits(Number(e.target.value))} className="input h-8 mt-0.5">
                  <option value={6}>6</option><option value={7}>7</option><option value={8}>8</option>
                </select>
              </label>
              <label className="text-2xs text-fg-muted">Period
                <select value={period} onChange={(e) => setPeriod(Number(e.target.value))} className="input h-8 mt-0.5">
                  <option value={30}>30s</option><option value={60}>60s</option>
                </select>
              </label>
              <label className="text-2xs text-fg-muted">Algorithm
                <select value={algorithm} onChange={(e) => setAlgorithm(e.target.value as TotpAlgorithm)} className="input h-8 mt-0.5">
                  <option value="SHA1">SHA1</option><option value="SHA256">SHA256</option><option value="SHA512">SHA512</option>
                </select>
              </label>
            </div>
          )}
          {isUriInput && <div className="text-2xs text-fg-muted">Settings are read from the otpauth URI.</div>}
          <div className="flex justify-end gap-2">
            {editing && <button type="button" onClick={() => { setEditing(false); setInput(""); }} className="btn-ghost text-xs">Cancel</button>}
            <button type="button" onClick={save} disabled={busy || !input.trim()} className="btn-primary text-xs">
              {busy ? "Saving…" : "Save OTP"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// =====================================================================
// Attachments section — encrypted files stored server-side
// =====================================================================

function AttachmentsSection({ credentialId, canReveal }: { credentialId: string; canReveal: boolean }) {
  const [items, setItems] = useState<CredentialAttachmentMeta[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => { void load(); /* eslint-disable-next-line */ }, [credentialId]);
  async function load() {
    try { const r = await credentialsApi.listAttachments(credentialId); setItems(r.data); }
    catch (e) { setErr(e instanceof Error ? e.message : "Failed to load attachments"); }
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.size > MAX_ATTACHMENT_BYTES) { setErr(`"${f.name}" is ${formatBytes(f.size)} — the limit is 5 MB.`); if (fileRef.current) fileRef.current.value = ""; return; }
    setBusy(true); setErr(null);
    try { await credentialsApi.uploadAttachment(credentialId, f); await load(); }
    catch (e) { setErr(e instanceof Error ? e.message : "Upload failed"); }
    finally { setBusy(false); if (fileRef.current) fileRef.current.value = ""; }
  }

  async function download(a: CredentialAttachmentMeta) {
    try {
      const blob = await credentialsApi.downloadAttachment(credentialId, a.id);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url; link.download = a.filename;
      document.body.appendChild(link); link.click(); link.remove();
      URL.revokeObjectURL(url);
    } catch (e) { setErr(e instanceof Error ? e.message : "Download failed"); }
  }

  async function remove(a: CredentialAttachmentMeta) {
    if (!confirm(`Delete attachment "${a.filename}"?`)) return;
    try { await credentialsApi.deleteAttachment(credentialId, a.id); setItems((x) => x.filter((y) => y.id !== a.id)); }
    catch (e) { setErr(e instanceof Error ? e.message : "Delete failed"); }
  }

  return (
    <div className="border border-border rounded p-3">
      <div className="text-xs text-fg-muted mb-2 flex items-center justify-between">
        <span className="inline-flex items-center gap-1.5 font-medium text-fg"><Paperclip className="size-3.5" /> Attachments</span>
        <label className="btn-ghost text-2xs cursor-pointer">
          <Upload className="size-3" /> {busy ? "Uploading…" : "Upload"}
          <input ref={fileRef} type="file" className="hidden" onChange={onFile} disabled={busy} />
        </label>
      </div>
      {err && <div className="text-2xs text-red-500 mb-2">{err}</div>}
      {items.length === 0 ? (
        <div className="text-2xs text-fg-muted">None. Attach keys, certs, or recovery-code files (≤ 5 MB, encrypted at rest).</div>
      ) : (
        <div className="space-y-1">
          {items.map((a) => (
            <div key={a.id} className="flex items-center gap-2 text-xs">
              <Paperclip className="size-3.5 text-fg-muted shrink-0" />
              <span className="flex-1 truncate font-mono">{a.filename}</span>
              <span className="text-2xs text-fg-muted tabular-nums">{formatBytes(a.size_bytes)}</span>
              {canReveal && <button type="button" onClick={() => download(a)} className="btn-icon" title="Download"><Download className="size-3.5" /></button>}
              <button type="button" onClick={() => remove(a)} className="btn-icon hover:text-red-500" title="Delete"><Trash2 className="size-3.5" /></button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
