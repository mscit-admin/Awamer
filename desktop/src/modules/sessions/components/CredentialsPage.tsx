import { type FormEvent, useEffect, useState } from "react";
import {
  KeyRound, Plus, Trash2, Edit3, Eye, EyeOff, ShieldCheck, X,
} from "lucide-react";
import {
  credentialsApi,
  type CredentialPublic, type CredentialType,
} from "../api/sessionsApi";
import { useCan } from "@/shared/lib/permissions";

const CREDENTIAL_TYPES: { value: CredentialType; label: string; description: string }[] = [
  { value: "password",    label: "Password",    description: "Username + password (SSH, RDP)" },
  { value: "private_key", label: "Private key", description: "SSH key (OpenSSH or PEM)" },
  { value: "certificate", label: "Certificate", description: "X.509 client cert + key" },
  { value: "agent",       label: "SSH Agent",   description: "Delegate to ssh-agent" },
  { value: "kerberos",    label: "Kerberos",    description: "GSSAPI / Kerberos ticket" },
  { value: "none",        label: "None",        description: "Interactive prompts only" },
];

export function CredentialsPage() {
  const canWrite = useCan("resources:write");
  const [credentials, setCredentials] = useState<CredentialPublic[]>([]);
  const [editing, setEditing] = useState<CredentialPublic | "new" | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { void load(); }, []);

  async function load() {
    setLoading(true);
    try {
      const r = await credentialsApi.list();
      setCredentials(r.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
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
        {canWrite && <button onClick={() => setEditing("new")} className="btn-primary">
          <Plus className="size-4" /> New credential
        </button>}
      </div>
      <p className="text-sm text-fg-muted mb-4">
        Authentication material for hosts. One credential can be reused across many hosts.
      </p>

      <div className="text-2xs bg-emerald-500/10 border border-emerald-500/30 text-emerald-200 px-3 py-2 rounded mb-6 flex items-start gap-2">
        <ShieldCheck className="size-3.5 mt-px shrink-0" />
        <div>
          <span className="font-semibold">Encrypted at rest:</span> secret material is sealed with
          AES-256-GCM authenticated encryption before it reaches PostgreSQL — only the envelope
          (IV, tag, ciphertext) is stored. The data key is held by the server
          (<span className="font-mono">CREDENTIAL_ENCRYPTION_KEY</span>); a dedicated KMS-backed
          master key and vault unlock are planned next.
        </div>
      </div>

      {error && (
        <div className="text-sm text-red-500 bg-red-500/10 border border-red-500/30 rounded p-3 mb-4">{error}</div>
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
      ) : (
        <div className="card divide-y divide-border">
          {credentials.map((c) => (
            <div key={c.id} className="px-4 py-3 flex items-center gap-3">
              <div className="size-9 rounded bg-bg-elevated grid place-items-center">
                <KeyRound className="size-4 text-fg-muted" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">{c.name}</div>
                <div className="text-xs text-fg-muted">
                  <span className="font-mono">{c.credentialType}</span>
                  {c.username && <> · <span className="font-mono">{c.username}</span></>}
                  {!c.hasSecret && <span className="text-amber-400 ml-2">no secret set</span>}
                </div>
              </div>
              {canWrite && <button onClick={() => setEditing(c)} className="btn-icon"><Edit3 className="size-4" /></button>}
              {canWrite && <button onClick={() => handleDelete(c)} className="btn-icon hover:text-red-500">
                <Trash2 className="size-4" />
              </button>}
            </div>
          ))}
        </div>
      )}

      {editing && (
        <CredentialForm
          existing={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); void load(); }}
        />
      )}
    </div>
  );
}

// =====================================================================
// Credential form modal
// =====================================================================

function CredentialForm({
  existing, onClose, onSaved,
}: {
  existing: CredentialPublic | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(existing?.name ?? "");
  const [credType, setCredType] = useState<CredentialType>(existing?.credentialType ?? "password");
  const [username, setUsername] = useState(existing?.username ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [secret, setSecret] = useState<Record<string, string>>({});
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // For editing: pre-fetch the existing secret_data only when user wants to change it.
  useEffect(() => {
    if (existing) {
      // Don't auto-fetch — let the user re-enter or click reveal.
      // We start with an empty form: if they don't touch the secret, we won't send it.
    }
  }, [existing]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const secret_data = Object.keys(secret).length ? secret : undefined;
      if (existing) {
        await credentialsApi.update(existing.id, {
          name: name.trim(),
          username: username.trim() || null,
          description: description.trim() || null,
          ...(secret_data ? { secret_data } : {}),
        });
      } else {
        await credentialsApi.create({
          name: name.trim(),
          credential_type: credType,
          username: username.trim() || null,
          description: description.trim() || null,
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

          <label className="block">
            <div className="text-xs text-fg-muted mb-1">Name <span className="text-red-500">*</span></div>
            <input value={name} onChange={(e) => setName(e.target.value)} required className="input" />
          </label>

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
            </div>
          )}

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
                Password {existing && <span className="text-2xs">Leave blank to keep existing</span>}
                <button type="button" onClick={() => setRevealed((b) => !b)} className="btn-icon">
                  {revealed ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                </button>
              </div>
              <input
                type={revealed ? "text" : "password"}
                value={(secret["password"] as string) ?? ""}
                onChange={(e) => setSecret({ password: e.target.value })}
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
              No secret data needed — your local <span className="font-mono">ssh-agent</span> will be used at connect time (Phase 3+).
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
