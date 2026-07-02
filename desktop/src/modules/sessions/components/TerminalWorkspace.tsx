import { useNavigate } from "react-router-dom";
import { X, Plus, Server } from "lucide-react";

import { useTerminalTabs } from "../store/terminalTabsStore";
import { useSplit } from "../store/splitStore";
import { TerminalPane } from "./TerminalPane";
import { SplitLayout } from "./SplitLayout";
import { isTauri } from "@/shared/lib/tauri";

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
 * This component is mounted persistently by DashboardLayout (hidden when off
 * the terminal route) so sessions also survive navigating to other screens.
 * Opening a tab from `/hosts/:id/terminal` is handled by TerminalRoute.
 */
export function TerminalWorkspace() {
  const tabs = useTerminalTabs(s => s.tabs);
  const activeTabId = useTerminalTabs(s => s.activeTabId);
  const setActive = useTerminalTabs(s => s.setActive);
  const closeTab = useTerminalTabs(s => s.closeTab);
  const removeSplit = useSplit(s => s.removeTab);

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
                removeSplit(tab.tabId);
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
            {isTauri ? <TerminalPane tab={tab} /> : <SplitLayout tab={tab} />}
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
