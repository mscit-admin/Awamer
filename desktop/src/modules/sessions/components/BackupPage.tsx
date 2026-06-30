/**
 * Backup & Restore — export the user's hosts, credentials, folders and tags to
 * a file, and restore them later. When secrets are included the file is
 * encrypted with a passphrase; restore is additive (never deletes existing data).
 */
import { useRef, useState } from "react";
import {
  DatabaseBackup, Download, Upload, Loader2, ShieldAlert, CheckCircle2, AlertCircle, Lock,
} from "lucide-react";
import { backupApi, type ImportSummary } from "../api/backupApi";
import { ApiError } from "@/shared/lib/api";

function timestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function BackupPage() {
  return (
    <div className="max-w-2xl mx-auto py-6 px-4 animate-fade-in">
      <div className="flex items-center gap-3 mb-6">
        <div className="size-10 rounded-md bg-bg-elevated border border-border grid place-items-center">
          <DatabaseBackup className="size-5 text-accent" />
        </div>
        <div>
          <h1 className="text-xl font-semibold leading-tight">Backup &amp; Restore</h1>
          <p className="text-sm text-fg-muted mt-0.5">Export your hosts, credentials, folders &amp; tags — and restore them.</p>
        </div>
      </div>
      <ExportCard />
      <RestoreCard />
    </div>
  );
}

function ExportCard() {
  const [includeSecrets, setIncludeSecrets] = useState(false);
  const [pass, setPass] = useState("");
  const [pass2, setPass2] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setError(null);
    if (includeSecrets) {
      if (pass.length < 8) { setError("Passphrase must be at least 8 characters."); return; }
      if (pass !== pass2) { setError("Passphrases do not match."); return; }
    }
    setBusy(true);
    try {
      const res = await backupApi.export({ include_secrets: includeSecrets, passphrase: includeSecrets ? pass : undefined });
      const blob = new Blob([JSON.stringify(res.payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `awamer-backup-${timestamp()}${res.encrypted ? ".enc" : ""}.json`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setPass(""); setPass2("");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : "export failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card p-5 mb-4">
      <h2 className="text-sm font-semibold mb-3 flex items-center gap-2"><Download className="size-4 text-accent" /> Export backup</h2>
      <label className="flex items-start gap-2 text-sm mb-3">
        <input type="checkbox" checked={includeSecrets} onChange={(e) => setIncludeSecrets(e.target.checked)} className="accent-accent mt-0.5" />
        <span>
          Include credential secrets (passwords &amp; keys)
          <span className="block text-2xs text-fg-muted">If off, the file holds only metadata and you'll re-enter secrets after restoring.</span>
        </span>
      </label>

      {includeSecrets && (
        <div className="space-y-2 mb-3">
          <div className="text-2xs text-amber-300/90 bg-amber-500/10 border border-amber-500/20 rounded px-3 py-2 flex items-start gap-1.5">
            <ShieldAlert className="size-3.5 shrink-0 mt-px" />
            The file will be encrypted with this passphrase. There is no recovery — if you lose it, the backup cannot be restored.
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <input type="password" value={pass} onChange={(e) => setPass(e.target.value)} placeholder="Passphrase (min 8 chars)" className="input w-full" />
            <input type="password" value={pass2} onChange={(e) => setPass2(e.target.value)} placeholder="Confirm passphrase" className="input w-full" />
          </div>
        </div>
      )}

      {error && <div className="mb-3 px-3 py-2 bg-red-500/10 border border-red-500/30 text-red-300 text-xs rounded flex items-center gap-2"><AlertCircle className="size-3.5" /> {error}</div>}

      <button onClick={run} disabled={busy} className="btn-primary">
        {busy ? <><Loader2 className="size-4 animate-spin" /> Exporting…</> : <><Download className="size-4" /> Download backup</>}
      </button>
    </div>
  );
}

function RestoreCard() {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [payload, setPayload] = useState<unknown | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [encrypted, setEncrypted] = useState(false);
  const [pass, setPass] = useState("");
  const [mode, setMode] = useState<"merge" | "skip">("merge");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<ImportSummary | null>(null);

  function pick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    setError(null); setSummary(null); setPayload(null); setFileName(null);
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result as string);
        const isEnc = parsed?.format === "awamer-backup-enc";
        const isPlain = parsed?.format === "awamer-backup";
        if (!isEnc && !isPlain) { setError("Not a valid Awamer backup file."); return; }
        setPayload(parsed);
        setEncrypted(isEnc);
        setFileName(file.name);
      } catch {
        setError("Could not read the file as JSON.");
      }
    };
    reader.readAsText(file);
  }

  async function run() {
    if (!payload) return;
    if (encrypted && !pass) { setError("This backup is encrypted — enter its passphrase."); return; }
    setBusy(true); setError(null); setSummary(null);
    try {
      const res = await backupApi.import({ payload, passphrase: encrypted ? pass : undefined, mode });
      setSummary(res.summary);
      setPass("");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : "restore failed");
    } finally {
      setBusy(false);
    }
  }

  const row = (label: string, c: { created: number; skipped: number }) => (
    <div className="flex justify-between text-xs py-0.5">
      <span className="text-fg-muted">{label}</span>
      <span><span className="text-emerald-400">{c.created} added</span>{c.skipped ? <span className="text-fg-muted">, {c.skipped} skipped</span> : null}</span>
    </div>
  );

  return (
    <div className="card p-5">
      <h2 className="text-sm font-semibold mb-3 flex items-center gap-2"><Upload className="size-4 text-accent" /> Restore backup</h2>

      <div className="flex items-center gap-2 mb-3">
        <button onClick={() => fileRef.current?.click()} className="btn-ghost text-xs"><Upload className="size-3.5" /> Choose file</button>
        <span className="text-xs text-fg-muted truncate">{fileName ?? "No file selected"}</span>
        {encrypted && <span className="text-2xs text-amber-300 flex items-center gap-1"><Lock className="size-3" /> encrypted</span>}
        <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={pick} />
      </div>

      {encrypted && (
        <input type="password" value={pass} onChange={(e) => setPass(e.target.value)} placeholder="Backup passphrase" className="input w-full mb-3" />
      )}

      <div className="mb-3">
        <label className="block text-xs text-fg-muted mb-1">On name conflict</label>
        <select value={mode} onChange={(e) => setMode(e.target.value as "merge" | "skip")} className="input w-full text-sm">
          <option value="merge">Merge — keep both (rename incoming)</option>
          <option value="skip">Skip — leave existing, link to it</option>
        </select>
        <p className="text-2xs text-fg-muted mt-1">Restore is additive — it never deletes or overwrites your current data.</p>
      </div>

      {error && <div className="mb-3 px-3 py-2 bg-red-500/10 border border-red-500/30 text-red-300 text-xs rounded flex items-center gap-2"><AlertCircle className="size-3.5" /> {error}</div>}

      {summary && (
        <div className="mb-3 px-3 py-2 bg-emerald-500/10 border border-emerald-500/30 rounded">
          <div className="text-xs text-emerald-300 font-medium flex items-center gap-1.5 mb-1"><CheckCircle2 className="size-3.5" /> Restore complete</div>
          {row("Folders", summary.folders)}
          {row("Tags", summary.tags)}
          {row("Credentials", summary.credentials)}
          {row("Hosts", summary.hosts)}
        </div>
      )}

      <button onClick={run} disabled={busy || !payload} className="btn-primary">
        {busy ? <><Loader2 className="size-4 animate-spin" /> Restoring…</> : <><Upload className="size-4" /> Restore</>}
      </button>
    </div>
  );
}
