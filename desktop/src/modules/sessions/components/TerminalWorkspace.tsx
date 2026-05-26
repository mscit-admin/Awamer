import { useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { X, Plus, Server } from "lucide-react";

import { useTerminalTabs } from "../store/terminalTabsStore";
import { TerminalPane } from "./TerminalPane";
import { hostsApi } from "../api/sessionsApi";

/**
 * Top-level terminal workspace.
 *
 * Layout:
 *   ┌──────────────────────────────────────────────────────┐
 *   │ [web01 ×] [db01 ×] [+]                               │  ← tab bar
 *   ├──────────────────────────────────────────────────────┤
 *   │                                                       │
 *   │   <TerminalPane for active tab>                       │
 *   │                                                       │
 *   └──────────────────────────────────────────────────────┘
 *
 * Each TerminalPane is mounted as long as its tab exists; we toggle
 * visibility with display:none rather than unmounting so the xterm
 * instance and the SSH session both survive a tab switch.
 *
 * The URL `/hosts/:id/terminal` opens a NEW tab for that host (or
 * focuses an existing one). After that, internal state takes over —
 * the URL doesn't track which tab is active.
 */
export function TerminalWorkspace() {
  const params = useParams<{ id?: string }>();
  const navigate = useNavigate();

  const tabs = useTerminalTabs(s => s.tabs);
  const activeTabId = useTerminalTabs(s => s.activeTabId);
  const openTab = useTerminalTabs(s => s.openTab);
  const setActive = useTerminalTabs(s => s.setActive);
  const closeTab = useTerminalTabs(s => s.closeTab);

  // When navigated to /hosts/:id/terminal, open (or focus) a tab for that host.
  useEffect(() => {
    if (!params.id) return;
    const hostId = params.id;
    void (async () => {
      let label = hostId.slice(0, 8);
      try {
        const h = await hostsApi.get(hostId);
        label = h.name;
      } catch {
        // Use the short ID as a fallback label
      }
      const tabId = openTab(hostId, label);
      // Strip the host id from the URL so subsequent navigations don't
      // re-trigger this effect. The route `/terminal` (without :id) still
      // renders this component.
      navigate("/terminal", { replace: true });
      // Ensure the new tab is active even if openTab returned an existing one.
      setActive(tabId);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.id]);

  if (tabs.length === 0) {
    return <EmptyState />;
  }

  return (
    <div className="flex flex-col h-full bg-bg">
      {/* Tab bar */}
      <div className="flex items-center border-b border-border bg-bg-elevated/40 overflow-x-auto">
        {tabs.map(tab => (
          <button
            key={tab.tabId}
            onClick={() => setActive(tab.tabId)}
            className={
              "group flex items-center gap-1.5 px-3 py-2 text-sm border-r border-border min-w-[120px] max-w-[200px] " +
              (activeTabId === tab.tabId
                ? "bg-bg text-fg"
                : "text-fg-muted hover:bg-bg-elevated hover:text-fg")
            }
          >
            <span className={"size-1.5 rounded-full shrink-0 " + statusDotClass(tab.phase)} />
            <span className="truncate flex-1 text-left">{tab.label}</span>
            <span
              onClick={(e) => {
                e.stopPropagation();
                closeTab(tab.tabId);
              }}
              className="opacity-0 group-hover:opacity-100 hover:bg-bg p-0.5 rounded shrink-0"
              title="Close tab"
            >
              <X className="size-3" />
            </span>
          </button>
        ))}
      </div>

      {/* Panes — all mounted; visibility toggled via inline style */}
      <div className="flex-1 min-h-0 relative">
        {tabs.map(tab => (
          <div
            key={tab.tabId}
            className="absolute inset-0"
            style={{ display: tab.tabId === activeTabId ? "block" : "none" }}
          >
            <TerminalPane tab={tab} />
          </div>
        ))}
      </div>
    </div>
  );
}

function EmptyState() {
  const navigate = useNavigate();
  return (
    <div className="flex-1 flex items-center justify-center p-6 animate-fade-in">
      <div className="text-center max-w-sm">
        <div className="size-14 mx-auto rounded-full bg-bg-elevated grid place-items-center mb-4">
          <Server className="size-7 text-fg-muted" />
        </div>
        <div className="text-base font-medium mb-1">No active terminals</div>
        <p className="text-sm text-fg-muted mb-4">
          Open a host and click <span className="font-medium">Connect</span> to
          start an SSH session here.
        </p>
        <button onClick={() => navigate("/hosts")} className="btn-primary inline-flex gap-1">
          <Plus className="size-4" /> Go to hosts
        </button>
      </div>
    </div>
  );
}

function statusDotClass(phase: string): string {
  switch (phase) {
    case "connected": return "bg-emerald-400";
    case "connecting": return "bg-amber-400 animate-pulse";
    case "disconnected": return "bg-fg-muted";
    case "error":
    case "host_key_changed": return "bg-red-400";
    default: return "bg-fg-muted";
  }
}
