import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  Server, Plus, Search, Star, Trash2, Edit3,
  Folder as FolderIcon, ChevronRight, Users2,
} from "lucide-react";
import {
  hostsApi, foldersApi, tagsApi,
  type Host, type FolderTreeNode, type Tag, type HostProtocol,
} from "../api/sessionsApi";
import { useCan } from "@/shared/lib/permissions";
import { useAuthStore } from "@/modules/auth/store/authStore";

const PROTOCOL_ICONS: Record<HostProtocol, string> = {
  ssh: "🔒", sftp: "📁", rdp: "🖥️", vnc: "📺",
  telnet: "📡", serial: "🔌", http: "🌐", https: "🔐", custom: "❓",
};

export function HostsPage() {
  const canWrite = useCan("resources:write");
  const [hosts, setHosts] = useState<Host[]>([]);
  const [folders, setFolders] = useState<FolderTreeNode[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [q, setQ] = useState("");
  const [selectedFolder, setSelectedFolder] = useState<string | "root" | null>(null);
  const [selectedProtocol, setSelectedProtocol] = useState<HostProtocol | null>(null);
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFolder, selectedProtocol, favoritesOnly, selectedTagIds.join(",")]);

  // Debounce search
  useEffect(() => {
    const t = setTimeout(() => { void load(); }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [h, f, t] = await Promise.all([
        hostsApi.list({
          q: q || undefined,
          folder_id: selectedFolder ?? undefined,
          protocol: selectedProtocol ?? undefined,
          favorites_only: favoritesOnly || undefined,
          tag_ids: selectedTagIds.length ? selectedTagIds : undefined,
        }),
        foldersApi.list(),
        tagsApi.list(),
      ]);
      setHosts(h.data);
      setFolders(f.tree);
      setTags(t.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }

  async function toggleFavorite(h: Host) {
    try {
      const r = await hostsApi.toggleFavorite(h.id);
      setHosts((arr) => arr.map((x) => x.id === h.id ? { ...x, is_favorite: r.is_favorite } : x));
    } catch { /* ignore */ }
  }

  async function deleteHost(h: Host) {
    if (!confirm(`Delete "${h.name}"? This cannot be undone.`)) return;
    try {
      await hostsApi.delete(h.id);
      setHosts((arr) => arr.filter((x) => x.id !== h.id));
    } catch (e) {
      alert(e instanceof Error ? e.message : "Delete failed");
    }
  }

  function toggleTag(id: string) {
    setSelectedTagIds((arr) =>
      arr.includes(id) ? arr.filter((x) => x !== id) : [...arr, id]
    );
  }

  return (
    <div className="flex h-full">
      {/* Sidebar: folders + tags filter */}
      <aside className="w-56 border-r border-border bg-bg-elevated/40 p-3 overflow-y-auto">
        <FilterButton
          active={selectedFolder === null && !favoritesOnly}
          onClick={() => { setSelectedFolder(null); setFavoritesOnly(false); }}
        >
          <Server className="size-4" /> All hosts
        </FilterButton>
        <FilterButton
          active={favoritesOnly}
          onClick={() => { setFavoritesOnly((b) => !b); setSelectedFolder(null); }}
        >
          <Star className="size-4" /> Favorites
        </FilterButton>
        <FilterButton
          active={selectedFolder === "root"}
          onClick={() => setSelectedFolder("root")}
        >
          <FolderIcon className="size-4" /> Unfiled
        </FilterButton>

        <div className="mt-4 text-xs uppercase tracking-wide text-fg-muted px-2 mb-1">Folders</div>
        <FolderTree
          tree={folders}
          selectedId={typeof selectedFolder === "string" && selectedFolder !== "root" ? selectedFolder : null}
          onSelect={(id) => setSelectedFolder(id)}
        />

        {tags.length > 0 && (
          <>
            <div className="mt-4 text-xs uppercase tracking-wide text-fg-muted px-2 mb-1">Tags</div>
            <div className="px-2 space-y-1">
              {tags.map((t) => (
                <button
                  key={t.id}
                  onClick={() => toggleTag(t.id)}
                  className={
                    "w-full text-left text-xs px-2 py-1 rounded flex items-center gap-2 " +
                    (selectedTagIds.includes(t.id)
                      ? "bg-accent/10 text-accent"
                      : "hover:bg-bg-elevated")
                  }
                >
                  <span className="inline-block size-2 rounded-full"
                        style={{ background: t.color ?? "#888" }} />
                  {t.name}
                </button>
              ))}
            </div>
          </>
        )}
      </aside>

      {/* Main: list */}
      <main className="flex-1 flex flex-col min-w-0">
        <header className="px-6 py-4 border-b border-border flex items-center gap-3">
          <div className="flex-1 relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-fg-muted" />
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search assets…"
              className="w-full pl-8 pr-3 py-1.5 text-sm bg-bg-elevated border border-border rounded
                         focus:outline-none focus:border-accent"
            />
          </div>
          <select
            value={selectedProtocol ?? ""}
            onChange={(e) => setSelectedProtocol((e.target.value || null) as HostProtocol | null)}
            className="px-2 py-1.5 text-sm bg-bg-elevated border border-border rounded"
          >
            <option value="">All protocols</option>
            {(["ssh", "sftp", "rdp", "vnc", "telnet", "serial", "http", "https", "custom"] as const).map((p) => (
              <option key={p} value={p}>{p.toUpperCase()}</option>
            ))}
          </select>
          {canWrite && (
            <Link
              to="/hosts/new"
              className="btn-primary flex items-center gap-1"
            >
              <Plus className="size-4" /> New asset
            </Link>
          )}
        </header>

        <div className="flex-1 overflow-y-auto p-6">
          {error && (
            <div className="text-sm text-red-500 bg-red-500/10 border border-red-500/30 rounded p-3 mb-4">
              {error}
            </div>
          )}
          {loading ? (
            <div className="text-sm text-fg-muted">Loading…</div>
          ) : hosts.length === 0 ? (
            <EmptyState />
          ) : (
            <div className="grid gap-2 grid-cols-1 lg:grid-cols-2 2xl:grid-cols-3">
              {hosts.map((h) => (
                <HostCard
                  key={h.id}
                  host={h}
                  onToggleFavorite={() => toggleFavorite(h)}
                  onDelete={() => deleteHost(h)}
                />
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

// =====================================================================
// Subcomponents
// =====================================================================

function FilterButton({ children, active, onClick }: { children: React.ReactNode; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={
        "w-full text-left text-sm px-2 py-1.5 rounded flex items-center gap-2 mb-0.5 " +
        (active ? "bg-accent/10 text-accent" : "hover:bg-bg-elevated text-fg")
      }
    >
      {children}
    </button>
  );
}

function FolderTree({
  tree, selectedId, onSelect, depth = 0,
}: {
  tree: FolderTreeNode[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  depth?: number;
}) {
  return (
    <div>
      {tree.map((node) => (
        <div key={node.id}>
          <button
            onClick={() => onSelect(node.id)}
            style={{ paddingLeft: 8 + depth * 12 }}
            className={
              "w-full text-left text-sm py-1 rounded flex items-center gap-1.5 " +
              (selectedId === node.id ? "bg-accent/10 text-accent" : "hover:bg-bg-elevated text-fg")
            }
          >
            <ChevronRight className="size-3 text-fg-muted" />
            <FolderIcon className="size-3.5" style={node.color ? { color: node.color } : undefined} />
            {node.name}
          </button>
          {node.children.length > 0 && (
            <FolderTree
              tree={node.children}
              selectedId={selectedId}
              onSelect={onSelect}
              depth={depth + 1}
            />
          )}
        </div>
      ))}
    </div>
  );
}

function HostCard({
  host, onToggleFavorite, onDelete,
}: {
  host: Host;
  onToggleFavorite: () => void;
  onDelete: () => void;
}) {
  const navigate = useNavigate();
  const myId = useAuthStore((s) => s.user?.id);
  const canWrite = useCan("resources:write");
  // Shared hosts owned by someone else: viewable & connectable, not editable.
  const isOwner = !host.owner_id || host.owner_id === myId;
  const canManage = canWrite && isOwner;
  return (
    <div
      className="card p-4 hover:border-accent/50 transition-colors cursor-pointer group"
      onClick={() => navigate(`/hosts/${host.id}`)}
    >
      <div className="flex items-start gap-3">
        <div className="size-10 rounded grid place-items-center text-lg bg-bg-elevated">
          {PROTOCOL_ICONS[host.protocol]}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <div className="font-medium truncate">{host.name}</div>
            {host.is_favorite && <Star className="size-3.5 text-yellow-400 fill-yellow-400" />}
            {host.is_shared && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-accent/15 border border-accent/30 text-accent flex items-center gap-0.5 shrink-0">
                <Users2 className="size-2.5" /> {isOwner ? "Shared" : "Shared with you"}
              </span>
            )}
          </div>
          <div className="text-xs text-fg-muted font-mono truncate">
            {host.protocol}://{host.hostname}:{host.port}
          </div>
          {host.description && (
            <div className="text-xs text-fg-muted mt-1 line-clamp-1">{host.description}</div>
          )}
          {host.tags.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-2">
              {host.tags.map((t: Tag) => (
                <span key={t.id} className="text-[10px] px-1.5 py-0.5 rounded bg-bg-elevated border border-border">
                  {t.name}
                </span>
              ))}
            </div>
          )}
        </div>
        {canManage && (
        <div className="opacity-0 group-hover:opacity-100 transition-opacity flex flex-col gap-1">
          <button
            className="btn-icon"
            onClick={(e) => { e.stopPropagation(); onToggleFavorite(); }}
            title={host.is_favorite ? "Unfavorite" : "Favorite"}
          >
            <Star className={"size-3.5 " + (host.is_favorite ? "text-yellow-400 fill-yellow-400" : "")} />
          </button>
          <button
            className="btn-icon"
            onClick={(e) => { e.stopPropagation(); navigate(`/hosts/${host.id}/edit`); }}
            title="Edit"
          >
            <Edit3 className="size-3.5" />
          </button>
          <button
            className="btn-icon hover:text-red-500"
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            title="Delete"
          >
            <Trash2 className="size-3.5" />
          </button>
        </div>
        )}
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="text-center py-16">
      <div className="size-14 mx-auto rounded-full bg-bg-elevated grid place-items-center mb-4">
        <Server className="size-7 text-fg-muted" />
      </div>
      <div className="text-base font-medium mb-1">No assets yet</div>
      <p className="text-sm text-fg-muted mb-4 max-w-xs mx-auto">
        Add your first remote asset to get started, then open an SSH terminal or SFTP browser.
      </p>
      <Link to="/hosts/new" className="btn-primary inline-flex items-center gap-1">
        <Plus className="size-4" /> New asset
      </Link>
    </div>
  );
}

// helper memo (silences unused-var warnings if any feature is removed later)
void useMemo;
