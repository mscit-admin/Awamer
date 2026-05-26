import { type FormEvent, useEffect, useState } from "react";
import { Tag as TagIconCmp, Plus, Trash2, Edit3, X, Check } from "lucide-react";
import { tagsApi, type Tag } from "../api/sessionsApi";

const TAG_COLORS = [
  "#ef4444", "#f97316", "#eab308", "#22c55e",
  "#06b6d4", "#3b82f6", "#8b5cf6", "#ec4899", "#64748b",
];

export function TagsPage() {
  const [tags, setTags] = useState<Tag[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  useEffect(() => { void load(); }, []);

  async function load() {
    setLoading(true);
    try {
      const r = await tagsApi.list();
      setTags(r.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete(t: Tag) {
    if (!confirm(`Delete tag "${t.name}"? Hosts will lose this tag.`)) return;
    try {
      await tagsApi.delete(t.id);
      setTags((arr) => arr.filter((x) => x.id !== t.id));
    } catch (e) {
      alert(e instanceof Error ? e.message : "Delete failed");
    }
  }

  return (
    <div className="max-w-3xl mx-auto py-8 px-6 animate-fade-in">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-xl font-semibold tracking-tight">Tags</h1>
        <button onClick={() => setCreating(true)} className="btn-primary">
          <Plus className="size-4" /> New tag
        </button>
      </div>
      <p className="text-sm text-fg-muted mb-6">
        Cross-cutting labels for hosts (independent of folders).
      </p>

      {error && (
        <div className="text-sm text-red-500 bg-red-500/10 border border-red-500/30 rounded p-3 mb-4">{error}</div>
      )}

      {creating && (
        <TagFormInline
          onCancel={() => setCreating(false)}
          onSaved={() => { setCreating(false); void load(); }}
        />
      )}

      {loading ? (
        <div className="text-sm text-fg-muted">Loading…</div>
      ) : tags.length === 0 && !creating ? (
        <div className="card p-8 text-center">
          <TagIconCmp className="size-8 mx-auto text-fg-muted mb-2" />
          <div className="font-medium text-sm mb-1">No tags yet</div>
          <button onClick={() => setCreating(true)} className="btn-primary inline-flex mt-3">
            <Plus className="size-4" /> New tag
          </button>
        </div>
      ) : (
        <div className="card divide-y divide-border">
          {tags.map((t) => (
            editingId === t.id ? (
              <TagFormInline
                key={t.id}
                existing={t}
                onCancel={() => setEditingId(null)}
                onSaved={() => { setEditingId(null); void load(); }}
              />
            ) : (
              <div key={t.id} className="px-4 py-2.5 flex items-center gap-3">
                <span className="inline-block size-3 rounded-full" style={{ background: t.color ?? "#888" }} />
                <div className="flex-1 text-sm font-medium">{t.name}</div>
                <button onClick={() => setEditingId(t.id)} className="btn-icon"><Edit3 className="size-3.5" /></button>
                <button onClick={() => handleDelete(t)} className="btn-icon hover:text-red-500">
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            )
          ))}
        </div>
      )}
    </div>
  );
}

function TagFormInline({
  existing, onCancel, onSaved,
}: {
  existing?: Tag;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(existing?.name ?? "");
  const [color, setColor] = useState(existing?.color ?? TAG_COLORS[0]!);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (existing) {
        await tagsApi.update(existing.id, { name: name.trim(), color });
      } else {
        await tagsApi.create({ name: name.trim(), color });
      }
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="px-4 py-3 bg-bg-elevated/40">
      {error && (
        <div className="text-xs text-red-500 mb-2">{error}</div>
      )}
      <div className="flex items-center gap-2">
        <input
          value={name} onChange={(e) => setName(e.target.value)}
          placeholder="Tag name"
          autoFocus required maxLength={40}
          className="input flex-1"
        />
        <div className="flex gap-1">
          {TAG_COLORS.map((c) => (
            <button
              type="button" key={c}
              onClick={() => setColor(c)}
              className={"size-5 rounded-full border-2 " + (color === c ? "border-fg" : "border-transparent")}
              style={{ background: c }}
              title={c}
            />
          ))}
        </div>
        <button type="submit" disabled={busy || !name} className="btn-icon text-emerald-400">
          <Check className="size-4" />
        </button>
        <button type="button" onClick={onCancel} className="btn-icon">
          <X className="size-4" />
        </button>
      </div>
    </form>
  );
}
