/**
 * Browser SFTP file browser.
 *
 * Used when the app runs as a web page (no Tauri). Talks to the backend SFTP
 * gateway via webSftpApi. Supports browse/navigate, view & edit text files,
 * download, upload, mkdir, rename, and delete.
 *
 * Live terminals and advanced ops (chmod/chown, recursive folder download)
 * remain desktop-only for now.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  ArrowLeft, Folder, FileIcon, Loader2, AlertCircle, Home, RefreshCw,
  FolderPlus, Upload, Download, Trash2, Pencil, X, Save, ChevronRight, Lock,
} from "lucide-react";

import { useAuthStore } from "@/modules/auth/store/authStore";
import { webSftpApi } from "../api/webSftpApi";
import { hostsApi } from "../api/sessionsApi";
import { sortAndFilterEntries, formatBytes, type RemoteEntry } from "../lib/sftpFiles";
import { ApiError } from "@/shared/lib/api";

const MAX_EDIT_BYTES = 1024 * 1024;

function parentOf(path: string): string {
  if (path === "/" || path === "") return "/";
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx <= 0 ? "/" : trimmed.slice(0, idx);
}

export function WebSftpPage({ hostId: hostIdProp }: { hostId?: string } = {}) {
  const params = useParams<{ id: string }>();
  const hostId = hostIdProp ?? params.id;
  const navigate = useNavigate();
  const accessToken = useAuthStore((s) => s.accessToken);

  const [hostName, setHostName] = useState("");
  const [phase, setPhase] = useState<"connecting" | "ready" | "error" | "need_password">("connecting");
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState("");

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [cwd, setCwd] = useState("/");
  const [entries, setEntries] = useState<RemoteEntry[]>([]);
  const [listing, setListing] = useState(false);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  // Inline text editor.
  const [editor, setEditor] = useState<{ path: string; text: string; saving: boolean; error: string | null } | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const msg = (e: unknown) => (e instanceof ApiError ? e.message : e instanceof Error ? e.message : "error");

  const listDir = useCallback(async (sid: string, path: string) => {
    setListing(true);
    try {
      const res = await webSftpApi.list(sid, path);
      setEntries(res.entries);
      setCwd(path);
    } catch (e) {
      setError(msg(e));
    } finally {
      setListing(false);
    }
  }, []);

  // Connect on mount (and whenever a password attempt is made).
  const connect = useCallback(async (pw?: string) => {
    if (!hostId) return;
    setPhase("connecting");
    setError(null);
    try {
      const res = await webSftpApi.connect(hostId, pw);
      setSessionId(res.session_id);
      setPhase("ready");
      await listDir(res.session_id, res.initial_path);
    } catch (e) {
      if (e instanceof ApiError && e.message === "no_credential") {
        setPhase("need_password");
      } else {
        setPhase("error");
        setError(msg(e));
      }
    }
  }, [hostId, listDir]);

  useEffect(() => {
    void (async () => {
      if (hostId) {
        try { const h = await hostsApi.get(hostId); setHostName(h.name); } catch { /* ignore */ }
      }
      await connect();
    })();
    // Disconnect on unmount.
    return () => { if (sessionId) void webSftpApi.disconnect(sessionId); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostId]);

  async function withBusy(label: string, fn: () => Promise<void>) {
    setBusy(label);
    try { await fn(); } catch (e) { setError(msg(e)); } finally { setBusy(null); }
  }

  function refresh() { if (sessionId) void listDir(sessionId, cwd); }

  async function openEntry(e: RemoteEntry) {
    if (!sessionId) return;
    if (e.kind === "dir") { void listDir(sessionId, e.path); return; }
    if (e.kind === "file") {
      if (e.size > MAX_EDIT_BYTES) { void download(e); return; }
      await withBusy("open", async () => {
        const res = await webSftpApi.read(sessionId, e.path);
        setEditor({ path: e.path, text: res.content, saving: false, error: null });
      });
    }
  }

  async function download(e: RemoteEntry) {
    if (!sessionId || !accessToken) return;
    await withBusy("download:" + e.path, () => webSftpApi.download(sessionId, e.path, accessToken));
  }

  async function saveEditor() {
    if (!sessionId || !editor) return;
    setEditor({ ...editor, saving: true, error: null });
    try {
      await webSftpApi.write(sessionId, editor.path, editor.text);
      setEditor(null);
      refresh();
    } catch (e) {
      setEditor({ ...editor, saving: false, error: msg(e) });
    }
  }

  async function doMkdir() {
    if (!sessionId) return;
    const name = window.prompt("New folder name:");
    if (!name) return;
    await withBusy("mkdir", async () => {
      await webSftpApi.mkdir(sessionId, cwd.replace(/\/$/, "") + "/" + name);
      refresh();
    });
  }

  async function doRename(e: RemoteEntry) {
    if (!sessionId) return;
    const name = window.prompt("Rename to:", e.name);
    if (!name || name === e.name) return;
    await withBusy("rename", async () => {
      await webSftpApi.rename(sessionId, e.path, parentOf(e.path).replace(/\/$/, "") + "/" + name);
      refresh();
    });
  }

  async function doDelete(e: RemoteEntry) {
    if (!sessionId) return;
    if (!window.confirm(`Delete ${e.kind === "dir" ? "folder" : "file"} "${e.name}"?`)) return;
    await withBusy("delete", async () => {
      await webSftpApi.remove(sessionId, e.path, e.kind === "dir");
      refresh();
    });
  }

  async function onUpload(ev: React.ChangeEvent<HTMLInputElement>) {
    const file = ev.target.files?.[0];
    ev.target.value = "";
    if (!file || !sessionId) return;
    await withBusy("upload", async () => {
      const buf = await file.arrayBuffer();
      let bin = "";
      const bytes = new Uint8Array(buf);
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
      const b64 = btoa(bin);
      await webSftpApi.upload(sessionId, cwd.replace(/\/$/, "") + "/" + file.name, b64);
      refresh();
    });
  }

  const visible = sortAndFilterEntries(entries, filter, { key: "name", dir: "asc" });

  // ---- render ----
  if (phase === "connecting") {
    return <Centered><Loader2 className="size-4 animate-spin" /> Connecting to {hostName || "host"}…</Centered>;
  }
  if (phase === "need_password") {
    return (
      <Centered>
        <form
          onSubmit={(e) => { e.preventDefault(); if (password) void connect(password); }}
          className="card p-6 w-full max-w-sm"
        >
          <div className="flex items-center gap-2 mb-4"><Lock className="size-4 text-accent" /><h2 className="text-base font-semibold">SSH password</h2></div>
          <p className="text-xs text-fg-muted mb-4">No stored credential for <span className="font-mono">{hostName}</span>.</p>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" autoFocus className="input w-full" />
          <button type="submit" disabled={!password} className="btn-primary w-full mt-3">Connect</button>
        </form>
      </Centered>
    );
  }
  if (phase === "error") {
    return (
      <Centered>
        <div className="card p-6 w-full max-w-sm text-center">
          <AlertCircle className="size-6 text-red-400 mx-auto mb-2" />
          <div className="text-sm font-medium mb-1">Connection failed</div>
          <p className="text-xs text-fg-muted mb-4 break-words">{error}</p>
          <button onClick={() => void connect()} className="btn-ghost text-xs">Retry</button>
        </div>
      </Centered>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border bg-bg-elevated/40">
        <button onClick={() => navigate(-1)} className="btn-ghost text-xs"><ArrowLeft className="size-3.5" /></button>
        <button onClick={() => sessionId && listDir(sessionId, "/")} className="btn-ghost text-xs" title="Root"><Home className="size-3.5" /></button>
        <button onClick={() => sessionId && listDir(sessionId, parentOf(cwd))} className="btn-ghost text-xs" disabled={cwd === "/"}>Up</button>
        <div className="flex-1 font-mono text-xs text-fg-muted truncate flex items-center gap-1">
          <span className="font-medium text-fg">{hostName}</span><ChevronRight className="size-3" />{cwd}
        </div>
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter…" className="input text-xs py-1 w-32" />
        <button onClick={refresh} className="btn-ghost text-xs" title="Refresh"><RefreshCw className={"size-3.5 " + (listing ? "animate-spin" : "")} /></button>
        <button onClick={doMkdir} className="btn-ghost text-xs" title="New folder"><FolderPlus className="size-3.5" /></button>
        <button onClick={() => fileInputRef.current?.click()} className="btn-ghost text-xs" title="Upload"><Upload className="size-3.5" /></button>
        <input ref={fileInputRef} type="file" hidden onChange={onUpload} />
      </div>

      {error && (
        <div className="px-4 py-1.5 bg-red-500/10 border-b border-red-500/30 text-red-300 text-xs flex items-center gap-2">
          <AlertCircle className="size-3.5" /> {error}
          <button onClick={() => setError(null)} className="ml-auto"><X className="size-3" /></button>
        </div>
      )}

      {/* Listing */}
      <div className="flex-1 overflow-auto">
        <table className="w-full text-sm">
          <thead className="text-2xs uppercase text-fg-muted sticky top-0 bg-bg">
            <tr className="border-b border-border">
              <th className="text-left font-medium px-4 py-2">Name</th>
              <th className="text-right font-medium px-4 py-2 w-28">Size</th>
              <th className="px-4 py-2 w-32"></th>
            </tr>
          </thead>
          <tbody>
            {visible.map((e) => (
              <tr key={e.path} className="border-b border-border/50 hover:bg-bg-elevated/40 group">
                <td className="px-4 py-1.5">
                  <button onClick={() => openEntry(e)} className="flex items-center gap-2 text-left w-full">
                    {e.kind === "dir" ? <Folder className="size-4 text-accent shrink-0" /> : <FileIcon className="size-4 text-fg-muted shrink-0" />}
                    <span className="truncate">{e.name}</span>
                  </button>
                </td>
                <td className="px-4 py-1.5 text-right text-fg-muted font-mono text-xs">{e.kind === "file" ? formatBytes(e.size) : ""}</td>
                <td className="px-4 py-1.5">
                  <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100">
                    {e.kind === "file" && <button onClick={() => download(e)} className="p-1 hover:bg-bg rounded" title="Download"><Download className="size-3.5" /></button>}
                    <button onClick={() => doRename(e)} className="p-1 hover:bg-bg rounded" title="Rename"><Pencil className="size-3.5" /></button>
                    <button onClick={() => doDelete(e)} className="p-1 hover:bg-bg rounded text-red-400" title="Delete"><Trash2 className="size-3.5" /></button>
                  </div>
                </td>
              </tr>
            ))}
            {visible.length === 0 && !listing && (
              <tr><td colSpan={3} className="px-4 py-8 text-center text-fg-muted text-sm">Empty folder</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {busy && (
        <div className="px-4 py-1.5 border-t border-border text-xs text-fg-muted flex items-center gap-2">
          <Loader2 className="size-3.5 animate-spin" /> Working…
        </div>
      )}

      {/* Inline editor */}
      {editor && (
        <div className="fixed inset-0 z-50 bg-bg/80 flex items-center justify-center p-4">
          <div className="card w-full max-w-3xl h-[70vh] flex flex-col">
            <div className="flex items-center gap-2 px-4 py-2 border-b border-border">
              <FileIcon className="size-4 text-fg-muted" />
              <span className="font-mono text-xs truncate flex-1">{editor.path}</span>
              <button onClick={() => setEditor(null)} className="btn-ghost text-xs"><X className="size-3.5" /> Close</button>
              <button onClick={() => void saveEditor()} disabled={editor.saving} className="btn-primary text-xs">
                {editor.saving ? <><Loader2 className="size-3.5 animate-spin" /> Saving</> : <><Save className="size-3.5" /> Save</>}
              </button>
            </div>
            {editor.error && <div className="px-4 py-1.5 bg-red-500/10 text-red-300 text-xs">{editor.error}</div>}
            <textarea
              value={editor.text}
              onChange={(e) => setEditor({ ...editor, text: e.target.value })}
              spellCheck={false}
              className="flex-1 w-full bg-[#0b0e14] text-fg font-mono text-xs p-4 resize-none outline-none"
            />
          </div>
        </div>
      )}
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex-1 h-full grid place-items-center p-4">
      <div className="flex items-center gap-2 text-sm text-fg-muted">{children}</div>
    </div>
  );
}
