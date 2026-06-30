/**
 * Files — a unified file manager across all assets.
 *
 * Pick an SSH/SFTP-capable asset and browse its files inline, without going
 * through the per-host detail page. In the browser it embeds the web SFTP
 * browser; in the desktop app it routes to the native SFTP page.
 */
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { FolderTree, Server, Search } from "lucide-react";

import { hostsApi, type Host } from "../api/sessionsApi";
import { WebSftpPage } from "./WebSftpPage";
import { isTauri } from "@/shared/lib/tauri";

export function FilesPage() {
  const navigate = useNavigate();
  const [hosts, setHosts] = useState<Host[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      try {
        const res = await hostsApi.list({ limit: 200 });
        // Only SSH/SFTP assets can be browsed over SFTP.
        setHosts(res.data.filter((h) => h.protocol === "ssh" || h.protocol === "sftp"));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return hosts;
    return hosts.filter((h) => h.name.toLowerCase().includes(needle) || h.hostname.toLowerCase().includes(needle));
  }, [hosts, q]);

  function open(h: Host) {
    if (isTauri) {
      navigate(`/hosts/${h.id}/sftp`);
    } else {
      setSelected(h.id);
    }
  }

  return (
    <div className="h-full flex flex-col md:grid md:grid-cols-[260px_1fr]">
      {/* Asset list — top strip on mobile, side column on md+ */}
      <aside className="border-b md:border-b-0 md:border-r border-border flex flex-col bg-bg-surface min-h-0 max-h-48 md:max-h-none">
        <div className="px-3 py-3 border-b border-border">
          <div className="flex items-center gap-2 mb-2">
            <FolderTree className="size-4 text-accent" />
            <span className="font-medium text-sm">Files</span>
          </div>
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-fg-muted" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Find asset…"
              className="w-full pl-7 pr-2 py-1.5 text-xs bg-bg-elevated border border-border rounded focus:outline-none focus:border-accent"
            />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
          {loading ? (
            <div className="text-xs text-fg-muted px-2 py-3">Loading…</div>
          ) : filtered.length === 0 ? (
            <div className="text-xs text-fg-muted px-2 py-3">No SSH/SFTP assets.</div>
          ) : (
            filtered.map((h) => (
              <button
                key={h.id}
                onClick={() => open(h)}
                className={
                  "w-full text-left px-2 py-1.5 rounded text-sm flex items-center gap-2 " +
                  (selected === h.id ? "bg-accent/15 text-accent" : "hover:bg-bg-elevated text-fg")
                }
              >
                <Server className="size-3.5 shrink-0" />
                <span className="flex-1 min-w-0">
                  <span className="block truncate">{h.name}</span>
                  <span className="block truncate text-2xs text-fg-muted font-mono">{h.hostname}</span>
                </span>
                {h.is_shared && <span className="text-2xs text-accent">shared</span>}
              </button>
            ))
          )}
        </div>
      </aside>

      {/* Browser */}
      <main className="flex-1 min-h-0">
        {selected ? (
          <WebSftpPage key={selected} hostId={selected} />
        ) : (
          <div className="h-full grid place-items-center text-center p-6">
            <div>
              <div className="size-14 mx-auto rounded-full bg-bg-elevated grid place-items-center mb-3">
                <FolderTree className="size-7 text-fg-muted" />
              </div>
              <div className="text-base font-medium mb-1">Browse files</div>
              <p className="text-sm text-fg-muted max-w-xs">
                Pick an asset on the left to browse, edit, upload, and download its files.
              </p>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
