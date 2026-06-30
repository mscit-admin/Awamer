/**
 * Slide-over panel that lists the user's saved shell commands for a host.
 * Lets them search, copy, re-insert (via onPick), and clear history.
 */
import { useEffect, useState, useCallback } from "react";
import { X, Loader2, Copy, Trash2, Search, ShieldAlert, CornerDownLeft } from "lucide-react";
import { commandHistoryApi, type CommandHistoryEntry } from "../api/commandHistoryApi";

export function CommandHistoryPanel({
  hostId,
  hostLabel,
  onClose,
  onPick,
}: {
  hostId: string;
  hostLabel: string;
  onClose: () => void;
  onPick?: (command: string) => void;
}) {
  const [entries, setEntries] = useState<CommandHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [clearing, setClearing] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async (q: string) => {
    setLoading(true);
    setError(null);
    try {
      const r = await commandHistoryApi.list({ hostId, search: q.trim() || undefined, limit: 300 });
      setEntries(r.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to load");
    } finally {
      setLoading(false);
    }
  }, [hostId]);

  useEffect(() => { void load(""); }, [load]);

  useEffect(() => {
    const t = setTimeout(() => { void load(search); }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  async function clearAll() {
    if (!confirm(`Clear all saved command history for ${hostLabel}?`)) return;
    setClearing(true);
    try {
      await commandHistoryApi.clear({ hostId });
      setEntries([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to clear");
    } finally {
      setClearing(false);
    }
  }

  function copy(cmd: string) {
    void navigator.clipboard?.writeText(cmd);
    setCopied(cmd);
    setTimeout(() => setCopied((c) => (c === cmd ? null : c)), 1200);
  }

  return (
    <div className="absolute inset-y-0 right-0 z-20 w-full max-w-md bg-bg border-l border-border shadow-2xl flex flex-col animate-fade-in">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold truncate">Command history</h2>
          <p className="text-2xs text-fg-muted truncate">{hostLabel}</p>
        </div>
        <button onClick={onClose} className="btn-ghost p-1.5" aria-label="Close">
          <X className="size-4" />
        </button>
      </div>

      <div className="px-4 py-2 border-b border-border flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="size-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-fg-subtle" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search commands…"
            className="input w-full pl-7 text-sm"
          />
        </div>
        <button
          onClick={clearAll}
          disabled={clearing || entries.length === 0}
          className="btn-ghost text-xs text-red-400 whitespace-nowrap"
        >
          {clearing ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />} Clear
        </button>
      </div>

      <div className="px-4 py-2 text-2xs text-amber-300/90 bg-amber-500/10 border-b border-amber-500/20 flex items-start gap-1.5">
        <ShieldAlert className="size-3.5 shrink-0 mt-px" />
        <span>History may contain anything you typed, including passwords or tokens. Stored on the server for your account only.</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="p-8 text-center text-fg-muted text-sm flex items-center justify-center gap-2">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </div>
        ) : error ? (
          <div className="m-4 px-3 py-2 bg-red-500/10 border border-red-500/30 text-red-300 text-xs rounded">{error}</div>
        ) : entries.length === 0 ? (
          <div className="p-8 text-center text-fg-muted text-sm">
            No saved commands{search ? " match your search" : " yet"}.
          </div>
        ) : (
          <ul className="divide-y divide-border/50">
            {entries.map((e) => (
              <li key={e.id} className="group px-4 py-2 hover:bg-bg-elevated/40">
                <div className="flex items-start gap-2">
                  <code className="flex-1 text-xs font-mono break-all text-fg">{e.command}</code>
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    {onPick && (
                      <button onClick={() => onPick(e.command)} className="btn-ghost p-1" title="Insert into terminal">
                        <CornerDownLeft className="size-3.5" />
                      </button>
                    )}
                    <button onClick={() => copy(e.command)} className="btn-ghost p-1" title="Copy">
                      <Copy className="size-3.5" />
                    </button>
                  </div>
                </div>
                <div className="text-2xs text-fg-subtle mt-0.5">
                  {new Date(e.created_at).toLocaleString()}
                  {copied === e.command && <span className="ml-2 text-emerald-400">copied</span>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
