import { useEffect, useRef, useState, lazy, Suspense, Fragment, type FormEvent, type DragEvent } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  ArrowLeft, Folder, FileIcon, Link2, ChevronRight, Loader2, Download,
  AlertCircle, Lock, KeyRound, HardDrive, Home, Power,
  Upload, FolderPlus, RefreshCw, Trash2, Edit3, Pencil, X, Save,
  ShieldCheck,
} from "lucide-react";

// Monaco is heavy (~3 MB minified) — keep it out of the main bundle and
// only fetch it the first time the user opens a file for editing.
const MonacoEditor = lazy(() => import("@monaco-editor/react").then(m => ({ default: m.default })));
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

// The npm wrapper `@tauri-apps/plugin-dialog` has historically thrown
// "Cannot read properties of undefined (reading 'invoke')" when its
// internal `@tauri-apps/api/core` resolves to a duplicate copy. We call
// the dialog plugin's IPC commands directly via the single `invoke` we
// already import — same wire contract, one fewer way to drift.
interface SaveDialogOptions {
  defaultPath?: string;
  title?: string;
  filters?: { name: string; extensions: string[] }[];
}
interface OpenDialogOptions {
  multiple?: boolean;
  directory?: boolean;
  title?: string;
  defaultPath?: string;
  filters?: { name: string; extensions: string[] }[];
}
function save(options: SaveDialogOptions = {}): Promise<string | null> {
  return invoke<string | null>("plugin:dialog|save", { options });
}
function openDialog(
  options: OpenDialogOptions = {},
): Promise<string | string[] | null> {
  return invoke<string | string[] | null>("plugin:dialog|open", { options });
}

import { hostsApi, credentialsApi, type Host } from "../api/sessionsApi";
import { useAuthStore } from "@/modules/auth/store/authStore";

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "http://localhost:8081";

/** Soft limit for in-app text editing — files larger than this cannot be opened. */
const MAX_EDIT_BYTES = 1024 * 1024; // 1 MB

type Phase = "loading" | "credential_prompt" | "passphrase_prompt" | "connecting" | "connected" | "error";

interface RemoteEntry {
  name: string;
  path: string;
  kind: "file" | "dir" | "symlink" | "other";
  size: number;
  mtime: number;
  mode: number;
  uid: number | null;
  gid: number | null;
}

interface PermissionsState {
  entry: RemoteEntry;
  /** Octal string the user is editing — accepts up to 4 digits. */
  modeText: string;
  uidText: string;
  gidText: string;
  saving: boolean;
  error: string | null;
}

interface ProgressEvent {
  type: "start" | "progress" | "done" | "error";
  total_bytes?: number;
  bytes_done?: number;
  message?: string;
}

/** Represents both downloads and uploads — they have the same shape. */
interface TransferState {
  direction: "download" | "upload";
  remotePath: string;
  localPath: string;
  filename: string;
  totalBytes: number;
  bytesDone: number;
  done: boolean;
  error: string | null;
}

interface EditorState {
  path: string;
  filename: string;
  originalText: string;
  text: string;
  saving: boolean;
  saveError: string | null;
}

interface ContextMenuState {
  entry: RemoteEntry;
  x: number;
  y: number;
}

interface AppErrorBody {
  code: string;
  message: string;
}

export function SftpPage() {
  const { id: hostId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const accessToken = useAuthStore(s => s.accessToken);

  const [host, setHost] = useState<Host | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [cwd, setCwd] = useState<string>("/");
  const [entries, setEntries] = useState<RemoteEntry[]>([]);
  const [listing, setListing] = useState(false);
  const [transfers, setTransfers] = useState<TransferState[]>([]);
  // 1.6.0
  const [renaming, setRenaming] = useState<{ entry: RemoteEntry; value: string } | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [permissions, setPermissions] = useState<PermissionsState | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const renameInputRef = useRef<HTMLInputElement>(null);

  // ---------- 1. Load host metadata ---------------------------------
  useEffect(() => {
    if (!hostId) return;
    void (async () => {
      try {
        const h = await hostsApi.get(hostId);
        setHost(h);
        // Same auto-connect logic as the terminal
        if (h.credential_id) {
          const cred = await credentialsApi.get(h.credential_id);
          if (cred.credentialType === "password" || cred.credentialType === "private_key" || cred.credentialType === "agent") {
            await doConnect({});
          } else {
            setError(`credential type "${cred.credentialType}" not supported for SFTP`);
            setPhase("error");
          }
        } else {
          setPhase("credential_prompt");
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load host");
        setPhase("error");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostId]);

  // ---------- 2. Subscribe to progress events -----------------------
  useEffect(() => {
    if (!sessionId) return;
    let unlisten: UnlistenFn | null = null;
    let unlistenDrop: UnlistenFn | null = null;
    void (async () => {
      unlisten = await listen<ProgressEvent>(`sftp:progress:${sessionId}`, (evt) => {
        const p = evt.payload;
        setTransfers(prev => {
          const next = [...prev];
          const i = next.length - 1; // most-recent download
          if (i < 0) return prev;
          if (p.type === "start") {
            next[i] = { ...next[i], totalBytes: p.total_bytes ?? 0 };
          } else if (p.type === "progress") {
            next[i] = { ...next[i], bytesDone: p.bytes_done ?? 0 };
          } else if (p.type === "done") {
            next[i] = { ...next[i], bytesDone: p.bytes_done ?? 0, done: true };
          } else if (p.type === "error") {
            next[i] = { ...next[i], error: p.message ?? "download failed", done: true };
          }
          return next;
        });
      });
      // Tauri webview emits this when files are dropped onto the window.
      // We don't get HTML drag events on every platform, so listen for the
      // native channel as a belt-and-suspenders fallback.
      unlistenDrop = await listen<{ paths: string[] }>("tauri://drag-drop", async (evt) => {
        const paths = evt.payload?.paths ?? [];
        for (const p of paths) {
          await uploadFile(p);
        }
      });
    })();
    return () => {
      unlisten?.();
      unlistenDrop?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, cwd]);

  // ---------- 3. Connect --------------------------------------------
  async function doConnect(opts: { password?: string; passphrase?: string }) {
    if (!accessToken || !hostId) return;
    setPhase("connecting");
    setError(null);
    try {
      const result = await invoke<{ session_id: string; initial_path: string }>("sftp_connect", {
        args: {
          api_base_url: API_BASE_URL,
          access_token: accessToken,
          host_id: hostId,
          password_override: opts.password ?? null,
          passphrase: opts.passphrase ?? null,
        },
      });
      setSessionId(result.session_id);
      setCwd(result.initial_path);
      setPhase("connected");
      setPassword("");
      setPassphrase("");
      await listDirectory(result.session_id, result.initial_path);
    } catch (e) {
      const err = parseAppError(e);
      if (err.code === "key_passphrase_required" || err.code === "key_invalid_passphrase") {
        setPhase("passphrase_prompt");
        if (err.code === "key_invalid_passphrase") {
          setError("Wrong passphrase — try again");
        }
      } else if (err.code === "no_credential" && !opts.password) {
        setPhase("credential_prompt");
      } else {
        setError(err.message);
        setPhase("error");
      }
    }
  }

  // ---------- 4. List directory -------------------------------------
  async function listDirectory(sid: string, path: string) {
    setListing(true);
    try {
      const result = await invoke<RemoteEntry[]>("sftp_list", { sessionId: sid, path });
      setEntries(result);
      // sftp_list canonicalizes; reflect that
      setCwd((prev) => prev === path ? prev : path); // best-effort
    } catch (e) {
      const err = parseAppError(e);
      setError(`${err.code}: ${err.message}`);
    } finally {
      setListing(false);
    }
  }

  function handleEntryClick(entry: RemoteEntry) {
    if (!sessionId) return;
    if (entry.kind === "dir") {
      const newPath = entry.path;
      setCwd(newPath);
      void listDirectory(sessionId, newPath);
    } else if (entry.kind === "file") {
      void downloadFile(entry);
    }
    // symlinks: we treat them as files for now; clicking them downloads
    // whatever the link points to. Better follow logic comes in 1.6.0.
  }

  async function downloadFile(entry: RemoteEntry) {
    if (!sessionId) return;
    try {
      const localPath = await save({
        defaultPath: entry.name,
        title: `Save ${entry.name}`,
      });
      if (!localPath) return; // user cancelled
      setTransfers(prev => [...prev, {
        direction: "download",
        remotePath: entry.path,
        localPath: String(localPath),
        filename: entry.name,
        totalBytes: entry.size,
        bytesDone: 0,
        done: false,
        error: null,
      }]);
      await invoke("sftp_download", {
        sessionId,
        remotePath: entry.path,
        localPath: String(localPath),
      });
    } catch (e) {
      const err = parseAppError(e);
      setTransfers(prev => {
        const next = [...prev];
        const i = next.length - 1;
        if (i >= 0) next[i] = { ...next[i], error: err.message, done: true };
        return next;
      });
    }
  }

  // -----------------------------------------------------------------
  // 1.6.0 write operations
  // -----------------------------------------------------------------

  async function uploadFromPicker() {
    if (!sessionId) return;
    const localPath = await openDialog({
      multiple: false,
      title: "Choose file to upload",
    });
    if (!localPath) return;
    await uploadFile(String(localPath));
  }

  async function uploadFile(localPath: string) {
    if (!sessionId) return;
    const filename = localPath.split(/[/\\]/).pop() ?? localPath;
    const remotePath = `${cwd.replace(/\/$/, "")}/${filename}`;
    setTransfers(prev => [...prev, {
      direction: "upload",
      remotePath,
      localPath,
      filename,
      totalBytes: 0,
      bytesDone: 0,
      done: false,
      error: null,
    }]);
    try {
      await invoke("sftp_upload", { sessionId, localPath, remotePath });
      // Refresh listing after upload (the new file should appear)
      await listDirectory(sessionId, cwd);
    } catch (e) {
      const err = parseAppError(e);
      setTransfers(prev => {
        const next = [...prev];
        const i = next.length - 1;
        if (i >= 0) next[i] = { ...next[i], error: err.message, done: true };
        return next;
      });
    }
  }

  async function createFolder() {
    if (!sessionId) return;
    const name = prompt("New folder name:");
    if (!name) return;
    if (name.includes("/")) { alert("Folder name may not contain slashes."); return; }
    const path = `${cwd.replace(/\/$/, "")}/${name}`;
    try {
      await invoke("sftp_mkdir", { sessionId, path });
      await listDirectory(sessionId, cwd);
    } catch (e) {
      const err = parseAppError(e);
      alert(`Could not create folder: ${err.message}`);
    }
  }

  async function deleteEntry(entry: RemoteEntry) {
    if (!sessionId) return;
    const confirmText = entry.kind === "dir"
      ? `Delete folder "${entry.name}" AND ALL ITS CONTENTS? This cannot be undone.`
      : `Delete "${entry.name}"? This cannot be undone.`;
    if (!confirm(confirmText)) return;
    try {
      if (entry.kind === "dir") {
        await invoke("sftp_remove_dir", { sessionId, path: entry.path, recursive: true });
      } else {
        await invoke("sftp_remove_file", { sessionId, path: entry.path });
      }
      await listDirectory(sessionId, cwd);
    } catch (e) {
      const err = parseAppError(e);
      alert(`Could not delete: ${err.message}`);
    }
  }

  function startRename(entry: RemoteEntry) {
    setRenaming({ entry, value: entry.name });
    setContextMenu(null);
    // Focus after the input mounts (next paint)
    setTimeout(() => renameInputRef.current?.select(), 0);
  }

  async function commitRename() {
    if (!renaming || !sessionId) return;
    const newName = renaming.value.trim();
    if (!newName || newName === renaming.entry.name) {
      setRenaming(null);
      return;
    }
    if (newName.includes("/")) {
      alert("Name may not contain slashes.");
      return;
    }
    const newPath = `${cwd.replace(/\/$/, "")}/${newName}`;
    try {
      await invoke("sftp_rename", { sessionId, from: renaming.entry.path, to: newPath });
      setRenaming(null);
      await listDirectory(sessionId, cwd);
    } catch (e) {
      const err = parseAppError(e);
      alert(`Rename failed: ${err.message}`);
    }
  }

  async function openInEditor(entry: RemoteEntry) {
    if (!sessionId) return;
    if (entry.size > MAX_EDIT_BYTES) {
      alert(`File is ${formatBytes(entry.size)}; only files under ${formatBytes(MAX_EDIT_BYTES)} can be edited in-place. Download it instead.`);
      return;
    }
    try {
      const text = await invoke<string>("sftp_read_text", {
        sessionId,
        path: entry.path,
        maxBytes: MAX_EDIT_BYTES,
      });
      setEditor({
        path: entry.path,
        filename: entry.name,
        originalText: text,
        text,
        saving: false,
        saveError: null,
      });
      setContextMenu(null);
    } catch (e) {
      const err = parseAppError(e);
      alert(`Could not open: ${err.message}`);
    }
  }

  async function saveEditor() {
    if (!editor || !sessionId) return;
    setEditor(prev => prev ? { ...prev, saving: true, saveError: null } : null);
    try {
      await invoke<number>("sftp_write_text", {
        sessionId,
        path: editor.path,
        content: editor.text,
      });
      setEditor(prev => prev ? {
        ...prev,
        originalText: prev.text,
        saving: false,
      } : null);
    } catch (e) {
      const err = parseAppError(e);
      setEditor(prev => prev ? {
        ...prev,
        saving: false,
        saveError: err.message,
      } : null);
    }
  }

  // ---------- 1.7.0: permissions (chmod / chown) --------------------
  function openPermissions(entry: RemoteEntry) {
    setPermissions({
      entry,
      modeText: (entry.mode & 0o7777).toString(8).padStart(3, "0"),
      uidText: entry.uid !== null && entry.uid !== undefined ? String(entry.uid) : "",
      gidText: entry.gid !== null && entry.gid !== undefined ? String(entry.gid) : "",
      saving: false,
      error: null,
    });
    setContextMenu(null);
  }

  async function savePermissions() {
    if (!permissions || !sessionId) return;
    const { entry, modeText, uidText, gidText } = permissions;

    const parsedMode = /^[0-7]{3,4}$/.test(modeText) ? parseInt(modeText, 8) : NaN;
    if (Number.isNaN(parsedMode)) {
      setPermissions(prev => prev ? { ...prev, error: "Mode must be 3–4 octal digits (e.g. 0755 or 644)" } : null);
      return;
    }

    const parseId = (s: string): number | null | "invalid" => {
      const t = s.trim();
      if (t === "") return null;
      if (!/^\d+$/.test(t)) return "invalid";
      const n = Number(t);
      if (n < 0 || n > 0xFFFF_FFFF) return "invalid";
      return n;
    };
    const uid = parseId(uidText);
    const gid = parseId(gidText);
    if (uid === "invalid" || gid === "invalid") {
      setPermissions(prev => prev ? { ...prev, error: "uid / gid must be non-negative integers" } : null);
      return;
    }

    setPermissions(prev => prev ? { ...prev, saving: true, error: null } : null);
    try {
      const modeChanged = parsedMode !== (entry.mode & 0o7777);
      const uidChanged = uid !== (entry.uid ?? null);
      const gidChanged = gid !== (entry.gid ?? null);

      if (modeChanged) {
        await invoke("sftp_chmod", { sessionId, path: entry.path, mode: parsedMode });
      }
      if (uidChanged || gidChanged) {
        await invoke("sftp_chown", {
          sessionId,
          path: entry.path,
          uid: uidChanged ? uid : null,
          gid: gidChanged ? gid : null,
        });
      }
      await listDirectory(sessionId, cwd);
      setPermissions(null);
    } catch (e) {
      const err = parseAppError(e);
      setPermissions(prev => prev ? { ...prev, saving: false, error: err.message } : null);
    }
  }

  function refreshListing() {
    if (sessionId) void listDirectory(sessionId, cwd);
  }

  // -----------------------------------------------------------------
  // Drag-and-drop from desktop
  // -----------------------------------------------------------------

  // Tauri's webview fires native HTML drag events with `dataTransfer.files`
  // populated. We intercept them on the listing pane.
  function onDragOver(e: DragEvent) {
    e.preventDefault();
    setDragOver(true);
  }
  function onDragLeave() {
    setDragOver(false);
  }
  async function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragOver(false);
    // Tauri 2 passes File objects with a `path` property (extension on top
    // of the standard File API). Try the native path first; fall back to
    // tauri's own drop-event channel if needed.
    const files = Array.from(e.dataTransfer.files);
    for (const f of files) {
      const path = (f as File & { path?: string }).path;
      if (path) {
        await uploadFile(path);
      }
    }
  }

  function navigateUp() {
    if (!sessionId || cwd === "/") return;
    const parts = cwd.split("/").filter(Boolean);
    parts.pop();
    const parent = parts.length === 0 ? "/" : "/" + parts.join("/");
    setCwd(parent);
    void listDirectory(sessionId, parent);
  }

  async function handleDisconnect() {
    if (!sessionId) return;
    try {
      await invoke("sftp_disconnect", { sessionId });
    } catch { /* ignore */ }
    navigate(`/hosts/${hostId}`);
  }

  // -----------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------

  if (phase === "loading") {
    return <div className="p-6 text-sm text-fg-muted">Loading…</div>;
  }

  if (phase === "credential_prompt") {
    return (
      <PromptCard
        kind="password"
        host={host}
        busy={false}
        value={password}
        onChange={setPassword}
        onSubmit={() => doConnect({ password })}
      />
    );
  }

  if (phase === "passphrase_prompt") {
    return (
      <PromptCard
        kind="passphrase"
        host={host}
        busy={false}
        value={passphrase}
        onChange={setPassphrase}
        onSubmit={() => doConnect({ passphrase })}
        errorBelow={error}
      />
    );
  }

  if (phase === "connecting") {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-fg-muted">
        <Loader2 className="size-4 animate-spin mr-2" /> Connecting to SFTP…
      </div>
    );
  }

  if (phase === "error") {
    return (
      <div className="flex items-center justify-center h-full p-6">
        <div className="card p-6 max-w-md w-full">
          <div className="flex items-center gap-2 text-red-400 mb-2">
            <AlertCircle className="size-4" />
            <h2 className="text-base font-semibold">SFTP connection failed</h2>
          </div>
          <p className="text-sm text-fg-muted font-mono break-words">{error}</p>
          <div className="flex gap-2 mt-4">
            <button onClick={() => navigate(`/hosts/${hostId}`)} className="btn-ghost">Back</button>
          </div>
        </div>
      </div>
    );
  }

  // connected
  return (
    <div className="flex flex-col h-full bg-bg">
      {/* Header */}
      <header className="px-4 py-2 border-b border-border flex items-center gap-3 flex-shrink-0">
        <button onClick={() => navigate(`/hosts/${hostId}`)} className="btn-ghost text-xs">
          <ArrowLeft className="size-3.5" /> Back
        </button>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium truncate">
            <HardDrive className="size-3.5 inline mr-1.5 text-accent" />
            {host?.name ?? hostId}
            <span className="text-fg-muted text-xs font-mono ml-2">sftp://{host?.hostname}:{host?.port}</span>
          </div>
        </div>
        <span className="text-2xs px-1.5 py-0.5 rounded font-mono bg-emerald-500/15 text-emerald-300">connected</span>
        <button onClick={handleDisconnect} className="btn-ghost text-red-400 hover:text-red-300">
          <Power className="size-3.5" /> Disconnect
        </button>
      </header>

      {/* Path breadcrumb */}
      <div className="px-4 py-2 border-b border-border flex items-center gap-1.5 flex-shrink-0 text-xs">
        <button onClick={() => sessionId && listDirectory(sessionId, "/")} className="hover:text-accent" title="Root">
          <Home className="size-3.5" />
        </button>
        {cwd === "/" ? (
          <span className="text-fg-muted">/</span>
        ) : (
          <BreadcrumbPath path={cwd} onNavigate={(p) => sessionId && (setCwd(p), listDirectory(sessionId, p))} />
        )}
        <div className="flex-1" />
        {/* Toolbar (1.6.0) */}
        <button onClick={refreshListing} className="btn-ghost text-xs" title="Refresh listing">
          <RefreshCw className="size-3.5" />
        </button>
        <button onClick={createFolder} className="btn-ghost text-xs" title="Create new folder">
          <FolderPlus className="size-3.5" /> New folder
        </button>
        <button onClick={uploadFromPicker} className="btn-primary text-xs" title="Upload a file">
          <Upload className="size-3.5" /> Upload
        </button>
      </div>

      {/* Listing — drag-drop target for uploads */}
      <div
        className={
          "flex-1 min-h-0 overflow-y-auto relative " +
          (dragOver ? "outline outline-2 outline-accent outline-offset-[-4px] bg-accent/5" : "")
        }
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        {dragOver && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10">
            <div className="bg-bg-elevated border border-accent rounded-lg px-6 py-4 shadow-lg flex items-center gap-3">
              <Upload className="size-5 text-accent" />
              <div>
                <div className="text-sm font-medium">Drop to upload</div>
                <div className="text-xs text-fg-muted">to {cwd}</div>
              </div>
            </div>
          </div>
        )}
        {listing ? (
          <div className="flex items-center justify-center p-6 text-sm text-fg-muted">
            <Loader2 className="size-4 animate-spin mr-2" /> Loading…
          </div>
        ) : entries.length === 0 ? (
          <div className="p-8 text-center text-sm text-fg-muted">Empty directory</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-2xs uppercase text-fg-muted">
              <tr className="border-b border-border">
                <th className="text-left px-4 py-1.5 font-medium">Name</th>
                <th className="text-right px-4 py-1.5 font-medium w-24">Size</th>
                <th className="text-right px-4 py-1.5 font-medium w-32">Modified</th>
                <th className="text-right px-4 py-1.5 font-medium w-20">Mode</th>
                <th className="w-12"></th>
              </tr>
            </thead>
            <tbody>
              {cwd !== "/" && (
                <tr
                  onClick={navigateUp}
                  className="border-b border-border hover:bg-bg-elevated cursor-pointer"
                >
                  <td className="px-4 py-1.5 flex items-center gap-2">
                    <Folder className="size-3.5 text-fg-muted" />
                    <span className="text-fg-muted">..</span>
                  </td>
                  <td colSpan={4}></td>
                </tr>
              )}
              {entries.map((e) => (
                <tr
                  key={e.path}
                  onClick={() => renaming?.entry.path !== e.path && handleEntryClick(e)}
                  onContextMenu={(ev) => {
                    ev.preventDefault();
                    setContextMenu({ entry: e, x: ev.clientX, y: ev.clientY });
                  }}
                  className="border-b border-border hover:bg-bg-elevated cursor-pointer group"
                >
                  <td className="px-4 py-1.5 flex items-center gap-2">
                    <EntryIcon kind={e.kind} />
                    {renaming?.entry.path === e.path ? (
                      <input
                        ref={renameInputRef}
                        value={renaming.value}
                        onChange={(ev) => setRenaming({ entry: e, value: ev.target.value })}
                        onKeyDown={(ev) => {
                          if (ev.key === "Enter") { ev.preventDefault(); void commitRename(); }
                          if (ev.key === "Escape") { ev.preventDefault(); setRenaming(null); }
                        }}
                        onClick={(ev) => ev.stopPropagation()}
                        onBlur={() => void commitRename()}
                        autoFocus
                        className="input font-mono text-sm w-full py-0.5 px-2"
                      />
                    ) : (
                      <span className={e.kind === "dir" ? "font-medium" : ""}>{e.name}</span>
                    )}
                  </td>
                  <td className="px-4 py-1.5 text-right text-fg-muted font-mono text-xs">
                    {e.kind === "file" ? formatBytes(e.size) : ""}
                  </td>
                  <td className="px-4 py-1.5 text-right text-fg-muted text-xs">
                    {e.mtime > 0 ? formatTime(e.mtime) : ""}
                  </td>
                  <td className="px-4 py-1.5 text-right text-fg-muted font-mono text-xs">
                    {formatMode(e.mode)}
                  </td>
                  <td className="px-4 py-1.5 text-right whitespace-nowrap">
                    <div className="inline-flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      {e.kind === "file" && e.size <= MAX_EDIT_BYTES && (
                        <button
                          onClick={(ev) => { ev.stopPropagation(); void openInEditor(e); }}
                          className="text-fg-muted hover:text-accent p-0.5"
                          title="Edit"
                        >
                          <Pencil className="size-3.5" />
                        </button>
                      )}
                      {e.kind === "file" && (
                        <button
                          onClick={(ev) => { ev.stopPropagation(); void downloadFile(e); }}
                          className="text-fg-muted hover:text-accent p-0.5"
                          title="Download"
                        >
                          <Download className="size-3.5" />
                        </button>
                      )}
                      <button
                        onClick={(ev) => { ev.stopPropagation(); startRename(e); }}
                        className="text-fg-muted hover:text-accent p-0.5"
                        title="Rename"
                      >
                        <Edit3 className="size-3.5" />
                      </button>
                      <button
                        onClick={(ev) => { ev.stopPropagation(); openPermissions(e); }}
                        className="text-fg-muted hover:text-accent p-0.5"
                        title="Permissions"
                      >
                        <ShieldCheck className="size-3.5" />
                      </button>
                      <button
                        onClick={(ev) => { ev.stopPropagation(); void deleteEntry(e); }}
                        className="text-fg-muted hover:text-red-400 p-0.5"
                        title="Delete"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Downloads/uploads tray */}
      {transfers.length > 0 && (
        <div className="border-t border-border bg-bg-elevated/40 max-h-32 overflow-y-auto flex-shrink-0">
          {transfers.map((d, i) => (
            <TransferRow key={i} transfer={d} />
          ))}
        </div>
      )}

      {/* Context menu (right-click) */}
      {contextMenu && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setContextMenu(null)}
            onContextMenu={(e) => { e.preventDefault(); setContextMenu(null); }}
          />
          <div
            className="fixed z-50 card py-1 text-sm min-w-[160px] shadow-lg"
            style={{ left: contextMenu.x, top: contextMenu.y }}
          >
            {contextMenu.entry.kind === "file" && contextMenu.entry.size <= MAX_EDIT_BYTES && (
              <button
                onClick={() => void openInEditor(contextMenu.entry)}
                className="block w-full text-left px-3 py-1.5 hover:bg-bg-elevated flex items-center gap-2"
              >
                <Pencil className="size-3.5" /> Edit
              </button>
            )}
            {contextMenu.entry.kind === "file" && (
              <button
                onClick={() => { setContextMenu(null); void downloadFile(contextMenu.entry); }}
                className="block w-full text-left px-3 py-1.5 hover:bg-bg-elevated flex items-center gap-2"
              >
                <Download className="size-3.5" /> Download
              </button>
            )}
            <button
              onClick={() => startRename(contextMenu.entry)}
              className="block w-full text-left px-3 py-1.5 hover:bg-bg-elevated flex items-center gap-2"
            >
              <Edit3 className="size-3.5" /> Rename
            </button>
            <button
              onClick={() => openPermissions(contextMenu.entry)}
              className="block w-full text-left px-3 py-1.5 hover:bg-bg-elevated flex items-center gap-2"
            >
              <ShieldCheck className="size-3.5" /> Permissions…
            </button>
            <button
              onClick={() => { setContextMenu(null); void deleteEntry(contextMenu.entry); }}
              className="block w-full text-left px-3 py-1.5 hover:bg-bg-elevated text-red-400 flex items-center gap-2"
            >
              <Trash2 className="size-3.5" /> Delete
            </button>
          </div>
        </>
      )}

      {/* Text editor modal */}
      {editor && (
        <div className="fixed inset-0 z-50 bg-bg/80 flex items-center justify-center p-4">
          <div className="card w-full max-w-4xl h-[80vh] flex flex-col">
            <header className="px-4 py-2 border-b border-border flex items-center gap-3">
              <Pencil className="size-4 text-accent" />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">{editor.filename}</div>
                <div className="text-2xs text-fg-muted font-mono truncate">{editor.path}</div>
              </div>
              {editor.text !== editor.originalText && (
                <span className="text-2xs px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300">modified</span>
              )}
              <button onClick={() => void saveEditor()}
                disabled={editor.saving || editor.text === editor.originalText}
                className="btn-primary text-xs">
                {editor.saving ? <><Loader2 className="size-3.5 animate-spin" /> Saving</> : <><Save className="size-3.5" /> Save</>}
              </button>
              <button onClick={() => {
                if (editor.text !== editor.originalText && !confirm("Discard unsaved changes?")) return;
                setEditor(null);
              }} className="btn-ghost text-xs">
                <X className="size-3.5" /> Close
              </button>
            </header>
            <div className="flex-1 min-h-0">
              <Suspense
                fallback={
                  <div className="h-full flex items-center justify-center text-fg-muted text-xs gap-2">
                    <Loader2 className="size-3.5 animate-spin" /> Loading editor…
                  </div>
                }
              >
                <MonacoEditor
                  height="100%"
                  theme="vs-dark"
                  language={languageFromFilename(editor.filename)}
                  value={editor.text}
                  onChange={(value) => setEditor(prev => prev ? { ...prev, text: value ?? "" } : null)}
                  options={{
                    fontSize: 13,
                    minimap: { enabled: false },
                    automaticLayout: true,
                    wordWrap: "on",
                    scrollBeyondLastLine: false,
                    tabSize: 2,
                  }}
                />
              </Suspense>
            </div>
            {editor.saveError && (
              <div className="px-4 py-2 bg-red-500/10 border-t border-red-500/30 text-red-300 text-xs flex items-center gap-2">
                <AlertCircle className="size-3.5" /> {editor.saveError}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Permissions modal (1.7.0 — chmod / chown) */}
      {permissions && (
        <PermissionsDialog
          state={permissions}
          onChange={setPermissions}
          onSave={() => void savePermissions()}
          onClose={() => setPermissions(null)}
        />
      )}
    </div>
  );
}

/** Best-effort mapping from filename to a Monaco language id. Unknowns
 *  fall through to "plaintext" — Monaco still renders, just without
 *  syntax highlighting. */
function languageFromFilename(name: string): string {
  const lower = name.toLowerCase();
  // Filenames without extension that we still recognize
  if (lower === "dockerfile" || lower.startsWith("dockerfile.")) return "dockerfile";
  if (lower === "makefile") return "makefile";
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "";
  switch (ext) {
    case "ts": case "tsx": return "typescript";
    case "js": case "jsx": case "mjs": case "cjs": return "javascript";
    case "json": return "json";
    case "yml": case "yaml": return "yaml";
    case "toml": return "ini";
    case "md": case "markdown": return "markdown";
    case "py": return "python";
    case "rs": return "rust";
    case "go": return "go";
    case "rb": return "ruby";
    case "php": return "php";
    case "java": return "java";
    case "kt": case "kts": return "kotlin";
    case "swift": return "swift";
    case "c": case "h": return "c";
    case "cpp": case "cc": case "cxx": case "hpp": case "hh": return "cpp";
    case "cs": return "csharp";
    case "sh": case "bash": case "zsh": return "shell";
    case "sql": return "sql";
    case "xml": case "html": case "htm": return "html";
    case "css": return "css";
    case "scss": case "sass": return "scss";
    case "conf": case "cfg": case "ini": return "ini";
    case "log": return "log";
    case "dockerfile": return "dockerfile";
    default: return "plaintext";
  }
}

// =====================================================================
// Subcomponents
// =====================================================================

function BreadcrumbPath({ path, onNavigate }: { path: string; onNavigate: (p: string) => void }) {
  const parts = path.split("/").filter(Boolean);
  return (
    <>
      {parts.map((part, i) => {
        const fullPath = "/" + parts.slice(0, i + 1).join("/");
        const isLast = i === parts.length - 1;
        return (
          <span key={i} className="flex items-center gap-1">
            <ChevronRight className="size-3 text-fg-muted/60" />
            <button
              onClick={() => !isLast && onNavigate(fullPath)}
              className={isLast ? "text-fg" : "text-fg-muted hover:text-fg"}
              disabled={isLast}
            >
              {part}
            </button>
          </span>
        );
      })}
    </>
  );
}

function EntryIcon({ kind }: { kind: string }) {
  if (kind === "dir") return <Folder className="size-3.5 text-accent" />;
  if (kind === "symlink") return <Link2 className="size-3.5 text-amber-400" />;
  return <FileIcon className="size-3.5 text-fg-muted" />;
}

function TransferRow({ transfer }: { transfer: TransferState }) {
  const pct = transfer.totalBytes > 0 ? (transfer.bytesDone / transfer.totalBytes) * 100 : 0;
  const Icon = transfer.direction === "upload" ? Upload : Download;
  return (
    <div className="px-4 py-1.5 text-xs flex items-center gap-2 border-b border-border last:border-b-0">
      <Icon className="size-3 text-fg-muted flex-shrink-0" />
      <span className="truncate flex-1">{transfer.filename}</span>
      {transfer.error ? (
        <span className="text-red-400">{transfer.error}</span>
      ) : transfer.done ? (
        <span className="text-emerald-400">✓ {formatBytes(transfer.bytesDone)}</span>
      ) : (
        <>
          <div className="w-24 h-1 bg-bg rounded overflow-hidden">
            <div className="h-full bg-accent" style={{ width: `${pct}%` }} />
          </div>
          <span className="text-fg-muted font-mono">{formatBytes(transfer.bytesDone)} / {formatBytes(transfer.totalBytes)}</span>
        </>
      )}
    </div>
  );
}

function PromptCard({
  kind, host, busy, value, onChange, onSubmit, errorBelow,
}: {
  kind: "password" | "passphrase";
  host: Host | null;
  busy: boolean;
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  errorBelow?: string | null;
}) {
  const isPassphrase = kind === "passphrase";
  return (
    <div className="flex items-center justify-center h-full">
      <div className="card p-6 w-full max-w-sm m-4">
        <div className="flex items-center gap-2 mb-4">
          {isPassphrase ? <KeyRound className="size-4 text-accent" /> : <Lock className="size-4 text-accent" />}
          <h2 className="text-base font-semibold">
            {isPassphrase ? "Private key passphrase" : "SSH password"}
          </h2>
        </div>
        <p className="text-xs text-fg-muted mb-4">
          {isPassphrase
            ? <>The private key for <span className="font-mono">{host?.name}</span> is encrypted.</>
            : <>Enter the password for <span className="font-mono">{host?.name}</span> to open SFTP.</>}
        </p>
        <form onSubmit={(e: FormEvent) => { e.preventDefault(); onSubmit(); }}>
          <input
            type="password"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={isPassphrase ? "Passphrase" : "Password"}
            autoFocus
            className="input font-mono w-full"
          />
          {errorBelow && <div className="text-xs text-red-400 mt-1">{errorBelow}</div>}
          <button
            type="submit"
            disabled={busy || !value}
            className="btn-primary w-full mt-3"
          >
            {busy ? "Connecting…" : "Open SFTP"}
          </button>
        </form>
      </div>
    </div>
  );
}

// =====================================================================
// Formatting helpers
// =====================================================================

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatTime(unix: number): string {
  if (unix <= 0) return "";
  const d = new Date(unix * 1000);
  const now = new Date();
  const diffDays = (now.getTime() - d.getTime()) / 86400_000;
  if (diffDays < 1) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  if (diffDays < 365) {
    return d.toLocaleDateString([], { month: "short", day: "numeric" });
  }
  return d.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
}

function formatMode(mode: number): string {
  // Convert POSIX mode to rwxrwxrwx-style string
  const perms = ["---", "--x", "-w-", "-wx", "r--", "r-x", "rw-", "rwx"];
  const owner = perms[(mode >> 6) & 0b111];
  const group = perms[(mode >> 3) & 0b111];
  const other = perms[mode & 0b111];
  return `${owner}${group}${other}`;
}

function parseAppError(e: unknown): AppErrorBody {
  if (typeof e === "object" && e && "code" in e && "message" in e) {
    return e as AppErrorBody;
  }
  if (typeof e === "string") return { code: "unknown", message: e };
  return { code: "unknown", message: String(e) };
}

// =====================================================================
// Permissions dialog (1.7.0)
// =====================================================================
//
// Two ways to set the mode:
//   1. Octal text field (e.g. "0755" or "644")
//   2. Nine checkboxes for r/w/x × owner/group/other
// Both are bound to the same modeText state so editing either updates
// the other. uid/gid are simple numeric fields — blank means "leave
// this side unchanged" on submit.

function PermissionsDialog({
  state, onChange, onSave, onClose,
}: {
  state: PermissionsState;
  onChange: (next: PermissionsState | null) => void;
  onSave: () => void;
  onClose: () => void;
}) {
  const parsedMode = /^[0-7]{1,4}$/.test(state.modeText) ? parseInt(state.modeText, 8) : NaN;
  const modeValid = !Number.isNaN(parsedMode);
  const bits = modeValid ? parsedMode & 0o777 : 0;

  function setBit(idx: number, on: boolean) {
    // idx 0..8 maps to owner-r,w,x; group-r,w,x; other-r,w,x
    const mask = 1 << (8 - idx);
    const next = on ? bits | mask : bits & ~mask;
    const special = modeValid ? parsedMode & 0o7000 : 0;
    onChange({ ...state, modeText: (special | next).toString(8).padStart(3, "0"), error: null });
  }

  const labels = ["r", "w", "x"];
  const groups: { name: string; offset: number }[] = [
    { name: "Owner", offset: 0 },
    { name: "Group", offset: 3 },
    { name: "Other", offset: 6 },
  ];

  return (
    <div className="fixed inset-0 z-50 bg-bg/80 flex items-center justify-center p-4">
      <div className="card w-full max-w-md p-5">
        <div className="flex items-center gap-2 mb-1">
          <ShieldCheck className="size-4 text-accent" />
          <h2 className="text-base font-semibold">Permissions</h2>
        </div>
        <div className="text-2xs text-fg-muted font-mono truncate mb-4">{state.entry.path}</div>

        <label className="block text-xs text-fg-muted mb-1">Mode (octal)</label>
        <input
          value={state.modeText}
          onChange={(e) => onChange({ ...state, modeText: e.target.value, error: null })}
          className="input font-mono w-32 mb-3"
          placeholder="0755"
          spellCheck={false}
          autoFocus
        />

        <div className="grid grid-cols-[80px_repeat(3,1fr)] gap-y-1 text-xs items-center mb-4">
          <div></div>
          {labels.map(l => <div key={l} className="text-center text-fg-muted font-mono">{l}</div>)}
          {groups.map((g, gi) => (
            <Fragment key={g.name}>
              <div className="text-fg-muted">{g.name}</div>
              {[0, 1, 2].map(bi => {
                const idx = gi * 3 + bi;
                const mask = 1 << (8 - idx);
                const checked = (bits & mask) !== 0;
                return (
                  <label key={bi} className="flex items-center justify-center">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) => setBit(idx, e.target.checked)}
                      disabled={!modeValid}
                    />
                  </label>
                );
              })}
            </Fragment>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-3 mb-4">
          <div>
            <label className="block text-xs text-fg-muted mb-1">uid (blank = keep)</label>
            <input
              value={state.uidText}
              onChange={(e) => onChange({ ...state, uidText: e.target.value, error: null })}
              className="input font-mono w-full"
              placeholder={state.entry.uid !== null && state.entry.uid !== undefined ? String(state.entry.uid) : "—"}
              inputMode="numeric"
              spellCheck={false}
            />
          </div>
          <div>
            <label className="block text-xs text-fg-muted mb-1">gid (blank = keep)</label>
            <input
              value={state.gidText}
              onChange={(e) => onChange({ ...state, gidText: e.target.value, error: null })}
              className="input font-mono w-full"
              placeholder={state.entry.gid !== null && state.entry.gid !== undefined ? String(state.entry.gid) : "—"}
              inputMode="numeric"
              spellCheck={false}
            />
          </div>
        </div>

        {state.error && (
          <div className="mb-3 px-2 py-1.5 bg-red-500/10 border border-red-500/30 text-red-300 text-xs flex items-center gap-2 rounded">
            <AlertCircle className="size-3.5" /> {state.error}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="btn-ghost text-xs" disabled={state.saving}>
            <X className="size-3.5" /> Cancel
          </button>
          <button
            onClick={onSave}
            disabled={state.saving || !modeValid}
            className="btn-primary text-xs"
          >
            {state.saving ? <><Loader2 className="size-3.5 animate-spin" /> Saving</> : <><Save className="size-3.5" /> Apply</>}
          </button>
        </div>
      </div>
    </div>
  );
}
