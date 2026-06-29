/**
 * KeePass (.kdbx) import.
 *
 * The file is decrypted in the browser (kdbxweb + hash-wasm Argon2) — the master
 * password never leaves the device. Selected entries become credentials, and
 * optionally hosts (assets) for entries that carry a host/URL.
 */
import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  KeyRound, Upload, Loader2, AlertCircle, CheckCircle2, Lock, ArrowLeft, ShieldCheck,
} from "lucide-react";
import { parseKdbx, KeepassError, type KeepassEntry } from "./keepassImport";
import { credentialsApi, hostsApi, type HostProtocol } from "../sessions/api/sessionsApi";
import { ApiError } from "@/shared/lib/api";

type Phase = "pick" | "review" | "importing" | "done";

interface Summary { credentials: number; hosts: number; skipped: number; errors: string[] }

/** Parse "ssh://host:22", "host:22", "https://host", or "host" → {hostname, port, protocol}. */
function parseTarget(url: string): { hostname: string; port: number; protocol: HostProtocol } | null {
  const raw = url.trim();
  if (!raw) return null;
  let scheme = "", rest = raw;
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/(.+)$/.exec(raw);
  if (m) { scheme = m[1]!.toLowerCase(); rest = m[2]!; }
  rest = rest.split("/")[0]!.split("?")[0]!; // strip path/query
  const at = rest.lastIndexOf("@");
  if (at >= 0) rest = rest.slice(at + 1); // strip user@
  const hostPort = /^\[(.+)\]:(\d+)$/.exec(rest) // [ipv6]:port
    ?? /^([^:]+):(\d+)$/.exec(rest);             // host:port
  const hostname = hostPort ? hostPort[1]! : rest;
  if (!hostname || /\s/.test(hostname)) return null;
  const explicitPort = hostPort ? Number(hostPort[2]) : undefined;
  const map: Record<string, { protocol: HostProtocol; port: number }> = {
    ssh: { protocol: "ssh", port: 22 }, sftp: { protocol: "sftp", port: 22 },
    rdp: { protocol: "rdp", port: 3389 }, vnc: { protocol: "vnc", port: 5900 },
    telnet: { protocol: "telnet", port: 23 }, http: { protocol: "http", port: 80 },
    https: { protocol: "https", port: 443 },
  };
  const def = map[scheme] ?? { protocol: "ssh" as HostProtocol, port: 22 };
  return { hostname, port: explicitPort ?? def.port, protocol: def.protocol };
}

export function KeepassImportPage() {
  const navigate = useNavigate();
  const [phase, setPhase] = useState<Phase>("pick");
  const [error, setError] = useState<string | null>(null);

  const [fileBuf, setFileBuf] = useState<ArrayBuffer | null>(null);
  const [fileName, setFileName] = useState<string>("");
  const [keyBuf, setKeyBuf] = useState<ArrayBuffer | null>(null);
  const [password, setPassword] = useState("");
  const fileRef = useRef<HTMLInputElement | null>(null);
  const keyRef = useRef<HTMLInputElement | null>(null);

  const [entries, setEntries] = useState<KeepassEntry[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [createHosts, setCreateHosts] = useState(false);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [progress, setProgress] = useState(0);

  function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]; e.target.value = "";
    if (!f) return;
    setFileName(f.name);
    f.arrayBuffer().then(setFileBuf);
  }
  function onPickKey(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]; e.target.value = "";
    if (!f) { setKeyBuf(null); return; }
    f.arrayBuffer().then(setKeyBuf);
  }

  async function unlock() {
    if (!fileBuf) { setError("Choose a .kdbx file first."); return; }
    setError(null);
    setPhase("importing"); // reuse spinner state briefly
    try {
      const list = await parseKdbx(fileBuf, password, keyBuf ?? undefined);
      setEntries(list);
      setSelected(new Set(list.map((_, i) => i)));
      setPhase("review");
    } catch (e) {
      setError(e instanceof KeepassError ? e.message : e instanceof Error ? e.message : "could not read the file");
      setPhase("pick");
    }
  }

  function toggle(i: number) {
    setSelected((s) => { const n = new Set(s); n.has(i) ? n.delete(i) : n.add(i); return n; });
  }
  function toggleAll() {
    setSelected((s) => s.size === entries.length ? new Set() : new Set(entries.map((_, i) => i)));
  }

  async function createWithSuffix(baseName: string, run: (name: string) => Promise<{ id: string }>): Promise<string> {
    for (let attempt = 0; attempt < 50; attempt++) {
      const name = attempt === 0 ? baseName : `${baseName} (${attempt + 1})`;
      try { return (await run(name)).id; }
      catch (e) {
        const msg = e instanceof ApiError ? e.message : "";
        if (/taken|exists|duplicate|unique/i.test(msg)) continue;
        throw e;
      }
    }
    throw new Error(`could not find a free name for "${baseName}"`);
  }

  async function runImport() {
    setPhase("importing");
    setProgress(0);
    const sum: Summary = { credentials: 0, hosts: 0, skipped: 0, errors: [] };
    const chosen = entries.filter((_, i) => selected.has(i));
    for (let i = 0; i < chosen.length; i++) {
      const e = chosen[i]!;
      setProgress(Math.round(((i) / chosen.length) * 100));
      const name = (e.title || e.username || e.url || "imported").slice(0, 80);
      try {
        const credId = await createWithSuffix(name, (n) => credentialsApi.create({
          name: n,
          credential_type: e.password ? "password" : "none",
          username: e.username || null,
          secret_data: e.password ? { password: e.password } : undefined,
          description: e.notes ? e.notes.slice(0, 200) : (e.url || null),
        }));
        sum.credentials++;

        if (createHosts) {
          const t = parseTarget(e.url);
          if (t) {
            await createWithSuffix(name, (n) => hostsApi.create({
              name: n, hostname: t.hostname, port: t.port, protocol: t.protocol,
              credential_id: credId, description: e.group || null,
            }));
            sum.hosts++;
          }
        }
      } catch (err) {
        sum.skipped++;
        const m = err instanceof ApiError ? err.message : err instanceof Error ? err.message : "failed";
        if (sum.errors.length < 8) sum.errors.push(`${name}: ${m}`);
      }
    }
    setProgress(100);
    setSummary(sum);
    setPhase("done");
  }

  return (
    <div className="max-w-3xl mx-auto py-6 px-4 animate-fade-in">
      <div className="flex items-center gap-3 mb-6">
        <button onClick={() => navigate(-1)} className="btn-ghost text-xs"><ArrowLeft className="size-3.5" /></button>
        <div className="size-10 rounded-md bg-bg-elevated border border-border grid place-items-center"><KeyRound className="size-5 text-accent" /></div>
        <div>
          <h1 className="text-xl font-semibold leading-tight">Import from KeePass</h1>
          <p className="text-sm text-fg-muted mt-0.5">Decrypted in your browser — the master password never leaves this device.</p>
        </div>
      </div>

      {error && (
        <div className="mb-4 px-3 py-2 bg-red-500/10 border border-red-500/30 text-red-300 text-xs rounded flex items-center gap-2">
          <AlertCircle className="size-3.5" /> {error}
        </div>
      )}

      {(phase === "pick" || (phase === "importing" && entries.length === 0)) && (
        <div className="card p-5 space-y-4">
          <div>
            <label className="block text-xs text-fg-muted mb-2">KeePass database (.kdbx)</label>
            <button onClick={() => fileRef.current?.click()} className="btn-ghost text-xs"><Upload className="size-3.5" /> {fileName || "Choose .kdbx file"}</button>
            <input ref={fileRef} type="file" accept=".kdbx" hidden onChange={onPickFile} />
          </div>
          <div>
            <label className="block text-xs text-fg-muted mb-1">Master password</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Master password" className="input w-full"
              onKeyDown={(e) => { if (e.key === "Enter") void unlock(); }} />
          </div>
          <div>
            <label className="block text-xs text-fg-muted mb-2">Key file (optional)</label>
            <button onClick={() => keyRef.current?.click()} className="btn-ghost text-xs"><Upload className="size-3.5" /> {keyBuf ? "Key file selected" : "Choose key file"}</button>
            <input ref={keyRef} type="file" hidden onChange={onPickKey} />
          </div>
          <button onClick={() => void unlock()} disabled={!fileBuf || phase === "importing"} className="btn-primary">
            {phase === "importing" ? <><Loader2 className="size-4 animate-spin" /> Decrypting…</> : <><Lock className="size-4" /> Unlock &amp; preview</>}
          </button>
        </div>
      )}

      {phase === "review" && (
        <div className="card overflow-hidden">
          <div className="flex items-center justify-between px-4 py-2 border-b border-border flex-wrap gap-2">
            <div className="text-xs text-fg-muted">{selected.size} of {entries.length} selected</div>
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={createHosts} onChange={(e) => setCreateHosts(e.target.checked)} className="accent-accent" />
              Also create assets from entries with a URL
            </label>
          </div>
          <div className="max-h-[55vh] overflow-auto">
            <table className="w-full text-sm">
              <thead className="text-2xs uppercase text-fg-muted sticky top-0 bg-bg border-b border-border">
                <tr>
                  <th className="px-3 py-2 w-8"><input type="checkbox" checked={selected.size === entries.length && entries.length > 0} onChange={toggleAll} className="accent-accent" /></th>
                  <th className="text-left font-medium px-3 py-2">Title</th>
                  <th className="text-left font-medium px-3 py-2">Username</th>
                  <th className="text-left font-medium px-3 py-2">URL</th>
                  <th className="text-left font-medium px-3 py-2">Group</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e, i) => (
                  <tr key={i} className="border-b border-border/50 hover:bg-bg-elevated/40">
                    <td className="px-3 py-1.5"><input type="checkbox" checked={selected.has(i)} onChange={() => toggle(i)} className="accent-accent" /></td>
                    <td className="px-3 py-1.5 truncate max-w-[180px]">{e.title || <span className="text-fg-subtle">—</span>} {e.password && <Lock className="size-3 inline text-fg-subtle" />}</td>
                    <td className="px-3 py-1.5 truncate max-w-[140px] text-fg-muted">{e.username || "—"}</td>
                    <td className="px-3 py-1.5 truncate max-w-[160px] text-fg-muted font-mono text-xs">{e.url || "—"}</td>
                    <td className="px-3 py-1.5 truncate max-w-[120px] text-fg-subtle text-xs">{e.group || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex justify-end gap-2 px-4 py-3 border-t border-border">
            <button onClick={() => { setPhase("pick"); setEntries([]); }} className="btn-ghost">Back</button>
            <button onClick={() => void runImport()} disabled={selected.size === 0} className="btn-primary">
              Import {selected.size} {selected.size === 1 ? "entry" : "entries"}
            </button>
          </div>
        </div>
      )}

      {phase === "importing" && entries.length > 0 && (
        <div className="card p-8 text-center">
          <Loader2 className="size-6 animate-spin mx-auto mb-3 text-accent" />
          <div className="text-sm mb-2">Importing… {progress}%</div>
          <div className="h-1.5 bg-bg-elevated rounded-full overflow-hidden max-w-xs mx-auto">
            <div className="h-full bg-accent transition-all" style={{ width: `${progress}%` }} />
          </div>
        </div>
      )}

      {phase === "done" && summary && (
        <div className="card p-5">
          <div className="flex items-center gap-2 text-emerald-300 mb-3"><CheckCircle2 className="size-5" /> <span className="font-semibold">Import complete</span></div>
          <ul className="text-sm space-y-1 mb-4">
            <li>Credentials created: <span className="font-medium">{summary.credentials}</span></li>
            {createHosts && <li>Assets created: <span className="font-medium">{summary.hosts}</span></li>}
            {summary.skipped > 0 && <li className="text-amber-300">Skipped / failed: {summary.skipped}</li>}
          </ul>
          {summary.errors.length > 0 && (
            <div className="text-2xs text-fg-muted bg-bg-elevated/50 rounded p-2 mb-4 max-h-32 overflow-auto">
              {summary.errors.map((e, i) => <div key={i}>{e}</div>)}
            </div>
          )}
          <div className="flex gap-2">
            <button onClick={() => navigate("/credentials")} className="btn-primary"><ShieldCheck className="size-4" /> View credentials</button>
            <button onClick={() => { setPhase("pick"); setEntries([]); setSummary(null); setPassword(""); setFileBuf(null); setFileName(""); }} className="btn-ghost">Import another</button>
          </div>
        </div>
      )}
    </div>
  );
}
