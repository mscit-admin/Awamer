/**
 * Notes list + editor. Reused by the full Notes page and the in-terminal
 * slide-over. When `hostId` is set, the list is scoped to that host and new
 * notes are attached to it.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  Plus, Search, Pin, PinOff, Pencil, Trash2, Loader2, X, StickyNote, Server, Share2, Users2, Globe,
} from "lucide-react";
import { notesApi, type Note } from "./notesApi";
import { authApi } from "@/modules/auth/api/authApi";

export function NotesView({ hostId, hostLabel, compact }: { hostId?: string; hostLabel?: string; compact?: boolean }) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<Note | "new" | null>(null);
  const [sharing, setSharing] = useState<Note | null>(null);

  const load = useCallback(async (q: string) => {
    setLoading(true);
    try {
      setNotes(await notesApi.list({ hostId, search: q.trim() || undefined }));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load");
    } finally {
      setLoading(false);
    }
  }, [hostId]);

  useEffect(() => { void load(""); }, [load]);
  useEffect(() => {
    const t = setTimeout(() => void load(search), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  async function togglePin(n: Note) {
    setNotes((arr) => arr.map((x) => x.id === n.id ? { ...x, pinned: !x.pinned } : x));
    try { await notesApi.update(n.id, { pinned: !n.pinned }); await load(search); } catch { await load(search); }
  }
  async function remove(n: Note) {
    if (!window.confirm("Delete this note?")) return;
    setNotes((arr) => arr.filter((x) => x.id !== n.id));
    try { await notesApi.remove(n.id); } catch { await load(search); }
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-2 mb-3">
        <div className="relative flex-1">
          <Search className="size-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-fg-subtle" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search notes…" className="input w-full pl-7 text-sm" />
        </div>
        <button onClick={() => setEditing("new")} className="btn-primary text-sm whitespace-nowrap"><Plus className="size-4" /> New</button>
      </div>

      {error && <div className="mb-2 px-3 py-2 bg-red-500/10 border border-red-500/30 text-red-300 text-xs rounded">{error}</div>}

      <div className="flex-1 overflow-y-auto -mx-1 px-1 space-y-2">
        {loading ? (
          <div className="p-6 text-center text-fg-muted text-sm flex items-center justify-center gap-2"><Loader2 className="size-4 animate-spin" /> Loading…</div>
        ) : notes.length === 0 ? (
          <div className="p-8 text-center text-fg-muted text-sm">
            <StickyNote className="size-6 mx-auto mb-2 text-fg-subtle" />
            No notes{search ? " match your search" : hostId ? " for this host yet" : " yet"}.
          </div>
        ) : (
          notes.map((n) => (
            <div key={n.id} className={"card p-3 " + (n.pinned ? "border-accent/40" : "")}>
              <div className="flex items-start gap-2">
                <div className="flex-1 min-w-0">
                  {n.title && <div className="font-medium text-sm truncate">{n.title}</div>}
                  <div className={"text-sm text-fg-muted whitespace-pre-wrap break-words " + (compact ? "line-clamp-6" : "")}>{n.body}</div>
                  <div className="flex items-center gap-2 mt-1.5 text-2xs text-fg-subtle flex-wrap">
                    <span>{new Date(n.updatedAt).toLocaleString()}</span>
                    {!hostId && n.hostLabel && <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-bg-elevated border border-border"><Server className="size-2.5" /> {n.hostLabel}</span>}
                    {!n.isOwner && <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-accent/10 border border-accent/30 text-accent"><Users2 className="size-2.5" /> shared by {n.ownerUsername}</span>}
                    {n.isOwner && n.isShared && <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-accent/10 border border-accent/30 text-accent"><Globe className="size-2.5" /> shared with everyone</span>}
                  </div>
                </div>
                <div className="flex items-center gap-0.5 shrink-0">
                  {n.isOwner ? (
                    <>
                      <button onClick={() => togglePin(n)} className="btn-ghost p-1" title={n.pinned ? "Unpin" : "Pin"}>
                        {n.pinned ? <Pin className="size-3.5 text-accent" /> : <PinOff className="size-3.5" />}
                      </button>
                      <button onClick={() => setSharing(n)} className="btn-ghost p-1" title="Share"><Share2 className="size-3.5" /></button>
                      <button onClick={() => setEditing(n)} className="btn-ghost p-1" title="Edit"><Pencil className="size-3.5" /></button>
                      <button onClick={() => remove(n)} className="btn-ghost p-1 text-red-400" title="Delete"><Trash2 className="size-3.5" /></button>
                    </>
                  ) : (
                    <span className="text-2xs text-fg-subtle px-1">read-only</span>
                  )}
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      {editing && (
        <NoteEditor
          note={editing === "new" ? null : editing}
          hostId={hostId}
          hostLabel={hostLabel}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); void load(search); }}
        />
      )}

      {sharing && (
        <ShareNoteDialog
          note={sharing}
          onClose={() => setSharing(null)}
          onSaved={() => { setSharing(null); void load(search); }}
        />
      )}
    </div>
  );
}

function ShareNoteDialog({ note, onClose, onSaved }: { note: Note; onClose: () => void; onSaved: () => void }) {
  const [everyone, setEveryone] = useState(note.isShared);
  const [userIds, setUserIds] = useState<string[]>([]);
  const [directory, setDirectory] = useState<{ id: string; username: string; full_name: string | null }[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([authApi.directory(), notesApi.getShares(note.id)])
      .then(([dir, sh]) => { setDirectory(dir.data.filter((u) => u.id !== note.ownerId)); setUserIds(sh.user_ids); })
      .catch((e) => setError(e instanceof Error ? e.message : "failed to load"))
      .finally(() => setLoading(false));
  }, [note.id, note.ownerId]);

  function toggle(id: string) {
    setUserIds((arr) => arr.includes(id) ? arr.filter((x) => x !== id) : [...arr, id]);
  }

  async function save() {
    setBusy(true); setError(null);
    try {
      await notesApi.update(note.id, { is_shared: everyone });
      await notesApi.setShares(note.id, userIds);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] grid place-items-center bg-black/50 p-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="card p-4 w-full max-w-md max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-base font-semibold flex items-center gap-1.5"><Share2 className="size-4 text-accent" /> Share note</h2>
          <button onClick={onClose} className="btn-ghost p-1"><X className="size-4" /></button>
        </div>

        <label className="flex items-center gap-2 text-sm mb-3">
          <input type="checkbox" checked={everyone} onChange={(e) => setEveryone(e.target.checked)} className="accent-accent" />
          <Globe className="size-3.5 text-fg-muted" /> Share with everyone (all users can read)
        </label>

        <div className="text-xs text-fg-muted mb-1">Or share with specific users:</div>
        <div className="flex-1 overflow-y-auto border border-border rounded p-1 min-h-0">
          {loading ? (
            <div className="p-4 text-center text-fg-muted text-sm flex items-center justify-center gap-2"><Loader2 className="size-4 animate-spin" /> Loading…</div>
          ) : directory.length === 0 ? (
            <div className="p-4 text-center text-fg-muted text-sm">No other users.</div>
          ) : (
            directory.map((u) => (
              <label key={u.id} className="flex items-center gap-2 text-sm px-2 py-1.5 rounded hover:bg-bg-elevated cursor-pointer">
                <input type="checkbox" checked={userIds.includes(u.id)} onChange={() => toggle(u.id)} className="accent-accent" />
                <span className="truncate">{u.username}{u.full_name ? <span className="text-fg-muted"> · {u.full_name}</span> : null}</span>
              </label>
            ))
          )}
        </div>

        {error && <div className="mt-2 px-3 py-2 bg-red-500/10 border border-red-500/30 text-red-300 text-xs rounded">{error}</div>}
        <p className="text-2xs text-fg-muted mt-2">Recipients can read the note but not edit or delete it.</p>

        <div className="flex justify-end gap-2 mt-3">
          <button onClick={onClose} className="btn-ghost">Cancel</button>
          <button onClick={save} disabled={busy} className="btn-primary">{busy ? <><Loader2 className="size-4 animate-spin" /> Saving…</> : "Save sharing"}</button>
        </div>
      </div>
    </div>
  );
}

function NoteEditor({ note, hostId, hostLabel, onClose, onSaved }: {
  note: Note | null;
  hostId?: string; hostLabel?: string;
  onClose: () => void; onSaved: () => void;
}) {
  const [title, setTitle] = useState(note?.title ?? "");
  const [body, setBody] = useState(note?.body ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!body.trim() && !title.trim()) { setError("Note is empty."); return; }
    setBusy(true); setError(null);
    try {
      if (note) await notesApi.update(note.id, { title: title.trim() || null, body });
      else await notesApi.create({ title: title.trim() || null, body, hostId: hostId ?? null, hostLabel: hostLabel ?? null });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] grid place-items-center bg-black/50 p-4" onClick={onClose}>
      <form onClick={(e) => e.stopPropagation()} onSubmit={save} className="card p-4 w-full max-w-lg">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-base font-semibold">{note ? "Edit note" : "New note"}{hostLabel ? ` · ${hostLabel}` : ""}</h2>
          <button type="button" onClick={onClose} className="btn-ghost p-1"><X className="size-4" /></button>
        </div>
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} placeholder="Title (optional)" className="input w-full mb-2" autoFocus />
        <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={8} maxLength={20000} placeholder="Write your note…" className="input w-full text-sm" />
        {error && <div className="mt-2 px-3 py-2 bg-red-500/10 border border-red-500/30 text-red-300 text-xs rounded">{error}</div>}
        <div className="flex justify-end gap-2 mt-3">
          <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
          <button type="submit" disabled={busy} className="btn-primary">{busy ? <><Loader2 className="size-4 animate-spin" /> Saving…</> : "Save"}</button>
        </div>
      </form>
    </div>
  );
}
