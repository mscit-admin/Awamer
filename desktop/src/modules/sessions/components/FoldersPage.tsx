import { type FormEvent, useEffect, useState } from "react";
import { Folder as FolderIcon, Plus, Trash2, Edit3, X, Check, ChevronRight } from "lucide-react";
import { foldersApi, type Folder, type FolderTreeNode } from "../api/sessionsApi";
import { useCan } from "@/shared/lib/permissions";

export function FoldersPage() {
  const canWrite = useCan("resources:write");
  const [folders, setFolders] = useState<Folder[]>([]);
  const [tree, setTree] = useState<FolderTreeNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  useEffect(() => { void load(); }, []);

  async function load() {
    setLoading(true);
    try {
      const r = await foldersApi.list();
      setFolders(r.data);
      setTree(r.tree);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete(f: Folder) {
    if (!confirm(`Delete folder "${f.name}"? Sub-folders are also deleted; hosts become unfiled.`)) return;
    try {
      await foldersApi.delete(f.id);
      void load();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Delete failed");
    }
  }

  return (
    <div className="max-w-3xl mx-auto py-8 px-6 animate-fade-in">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-xl font-semibold tracking-tight">Folders</h1>
        {canWrite && <button onClick={() => setCreating(true)} className="btn-primary">
          <Plus className="size-4" /> New folder
        </button>}
      </div>
      <p className="text-sm text-fg-muted mb-6">
        Hierarchical organization for hosts. Folders can be nested.
      </p>

      {error && (
        <div className="text-sm text-red-500 bg-red-500/10 border border-red-500/30 rounded p-3 mb-4">{error}</div>
      )}

      {creating && (
        <FolderFormInline
          parentChoices={folders}
          onCancel={() => setCreating(false)}
          onSaved={() => { setCreating(false); void load(); }}
        />
      )}

      {loading ? (
        <div className="text-sm text-fg-muted">Loading…</div>
      ) : tree.length === 0 && !creating ? (
        <div className="card p-8 text-center">
          <FolderIcon className="size-8 mx-auto text-fg-muted mb-2" />
          <div className="font-medium text-sm mb-1">No folders yet</div>
          <p className="text-xs text-fg-muted mb-3">Use folders to group related hosts.</p>
          {canWrite && <button onClick={() => setCreating(true)} className="btn-primary inline-flex">
            <Plus className="size-4" /> New folder
          </button>}
        </div>
      ) : (
        <div className="card">
          <FolderTreeRows
            tree={tree}
            editingId={editingId}
            allFolders={folders}
            onEdit={setEditingId}
            onDelete={handleDelete}
            onSaved={() => { setEditingId(null); void load(); }}
          />
        </div>
      )}
    </div>
  );
}

function FolderTreeRows({
  tree, depth = 0, editingId, allFolders, onEdit, onDelete, onSaved,
}: {
  tree: FolderTreeNode[];
  depth?: number;
  editingId: string | null;
  allFolders: Folder[];
  onEdit: (id: string | null) => void;
  onDelete: (f: Folder) => void;
  onSaved: () => void;
}) {
  const canWrite = useCan("resources:write");
  return (
    <>
      {tree.map((node) => (
        <div key={node.id}>
          {editingId === node.id ? (
            <FolderFormInline
              existing={node}
              parentChoices={allFolders.filter((f) => f.id !== node.id)}
              onCancel={() => onEdit(null)}
              onSaved={onSaved}
            />
          ) : (
            <div
              className="px-4 py-2 flex items-center gap-2 border-b border-border last:border-b-0"
              style={{ paddingLeft: 16 + depth * 16 }}
            >
              <ChevronRight className="size-3 text-fg-muted opacity-50" />
              <FolderIcon className="size-4" style={node.color ? { color: node.color } : undefined} />
              <div className="flex-1 text-sm">{node.name}</div>
              {canWrite && <button onClick={() => onEdit(node.id)} className="btn-icon"><Edit3 className="size-3.5" /></button>}
              {canWrite && <button onClick={() => onDelete(node)} className="btn-icon hover:text-red-500">
                <Trash2 className="size-3.5" />
              </button>}
            </div>
          )}
          {node.children.length > 0 && (
            <FolderTreeRows
              tree={node.children}
              depth={depth + 1}
              editingId={editingId}
              allFolders={allFolders}
              onEdit={onEdit}
              onDelete={onDelete}
              onSaved={onSaved}
            />
          )}
        </div>
      ))}
    </>
  );
}

const FOLDER_COLORS = ["#ef4444", "#f97316", "#eab308", "#22c55e", "#06b6d4", "#3b82f6", "#8b5cf6", "#64748b"];

function FolderFormInline({
  existing, parentChoices, onCancel, onSaved,
}: {
  existing?: Folder;
  parentChoices: Folder[];
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(existing?.name ?? "");
  const [parentId, setParentId] = useState(existing?.parent_id ?? "");
  const [color, setColor] = useState(existing?.color ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (existing) {
        await foldersApi.update(existing.id, {
          name: name.trim(),
          parent_id: parentId || null,
          color: color || null,
        });
      } else {
        await foldersApi.create({
          name: name.trim(),
          parent_id: parentId || null,
          color: color || null,
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
    <form onSubmit={handleSubmit} className="px-4 py-3 bg-bg-elevated/40 border-b border-border space-y-2">
      {error && (
        <div className="text-xs text-red-500">{error}</div>
      )}
      <div className="flex items-center gap-2">
        <input
          value={name} onChange={(e) => setName(e.target.value)}
          placeholder="Folder name"
          autoFocus required maxLength={80}
          className="input flex-1"
        />
        <select value={parentId} onChange={(e) => setParentId(e.target.value)} className="input max-w-[160px]">
          <option value="">— Root —</option>
          {parentChoices.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select>
        <button type="submit" disabled={busy || !name} className="btn-icon text-emerald-400">
          <Check className="size-4" />
        </button>
        <button type="button" onClick={onCancel} className="btn-icon">
          <X className="size-4" />
        </button>
      </div>
      <div className="flex gap-1.5 items-center text-xs text-fg-muted">
        <span>Color:</span>
        <button
          type="button"
          onClick={() => setColor("")}
          className={"text-2xs px-1.5 py-0.5 rounded border " +
            (color === "" ? "border-fg" : "border-transparent")}
        >
          none
        </button>
        {FOLDER_COLORS.map((c) => (
          <button
            type="button" key={c}
            onClick={() => setColor(c)}
            className={"size-4 rounded-full border-2 " + (color === c ? "border-fg" : "border-transparent")}
            style={{ background: c }}
          />
        ))}
      </div>
    </form>
  );
}
