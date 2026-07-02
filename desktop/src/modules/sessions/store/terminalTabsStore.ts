/**
 * Phase 3b (1.3.0) → 1.4.0 — Terminal tabs state.
 *
 * Holds the list of OPEN terminal sessions ("tabs"). Each tab carries
 * the metadata needed to render the xterm + reconnect/replay events,
 * plus the runtime session_id returned by the Rust ssh_connect command.
 *
 * Persistence (1.4.0): the list of tabs (hostId + label) survives app
 * restarts via localStorage. SSH sessions themselves do NOT — runtime
 * fields (sessionId, phase, errorMessage) are reset on rehydrate so the
 * user lands on "disconnected" tabs they can click to reconnect.
 */
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

export type TabPhase =
  | "connecting"
  | "connected"
  | "disconnected"
  | "error"
  | "host_key_changed";

export interface TerminalTab {
  /** Stable client-side id used as the React key + URL param. */
  tabId: string;
  /** Backend host UUID this tab connects to. */
  hostId: string;
  /** Human label shown on the tab — usually host.name. */
  label: string;
  /** Rust-issued session id; null while connecting / after error. */
  sessionId: string | null;
  /** Current lifecycle phase, drives what the page renders. */
  phase: TabPhase;
  /** Last error message if phase === "error" or "host_key_changed". */
  errorMessage: string | null;
  errorCode: string | null;
  /** Optional structured payload for host-key-changed UI. */
  hostKeyDetails: HostKeyChangedDetails | null;
  /** Created time — used for sort and aging tabs. */
  createdAt: number;
}

export interface HostKeyChangedDetails {
  host: string;
  port: number;
  stored_fingerprint: string;
  presented_fingerprint: string;
}

interface TabsState {
  tabs: TerminalTab[];
  activeTabId: string | null;

  // ---- mutators ---------------------------------------------------
  /** Open a terminal tab for a host. Focuses an existing live tab for that host
   *  unless `force` is true (then always opens a brand-new tab). */
  openTab(hostId: string, label: string, force?: boolean): string;
  setActive(tabId: string): void;
  closeTab(tabId: string): void;
  updateTab(tabId: string, patch: Partial<TerminalTab>): void;
  setSessionEstablished(tabId: string, sessionId: string): void;
  setError(tabId: string, errorCode: string, errorMessage: string, hostKeyDetails?: HostKeyChangedDetails): void;
  markDisconnected(tabId: string): void;
}

export const useTerminalTabs = create<TabsState>()(
  persist(
    (set, get) => ({
      tabs: [],
      activeTabId: null,

      openTab(hostId, label, force = false) {
        // If a tab for this host is already in "connecting" or "connected"
        // state, just focus it instead of opening a duplicate — unless the
        // caller forces a new tab (e.g. "Open host in new tab").
        if (!force) {
          const existing = get().tabs.find(t =>
            t.hostId === hostId && (t.phase === "connecting" || t.phase === "connected")
          );
          if (existing) {
            set({ activeTabId: existing.tabId });
            return existing.tabId;
          }
        }
        const tabId = `tab-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const newTab: TerminalTab = {
          tabId,
          hostId,
          label,
          sessionId: null,
          phase: "connecting",
          errorMessage: null,
          errorCode: null,
          hostKeyDetails: null,
          createdAt: Date.now(),
        };
        set(s => ({ tabs: [...s.tabs, newTab], activeTabId: tabId }));
        return tabId;
      },

      setActive(tabId) {
        set({ activeTabId: tabId });
      },

      closeTab(tabId) {
        set(s => {
          const newTabs = s.tabs.filter(t => t.tabId !== tabId);
          let newActive: string | null = s.activeTabId;
          if (s.activeTabId === tabId) {
            newActive = newTabs[newTabs.length - 1]?.tabId ?? null;
          }
          return { tabs: newTabs, activeTabId: newActive };
        });
      },

      updateTab(tabId, patch) {
        set(s => ({
          tabs: s.tabs.map(t => t.tabId === tabId ? { ...t, ...patch } : t),
        }));
      },

      setSessionEstablished(tabId, sessionId) {
        get().updateTab(tabId, { sessionId, phase: "connected", errorMessage: null, errorCode: null });
      },

      setError(tabId, errorCode, errorMessage, hostKeyDetails) {
        get().updateTab(tabId, {
          phase: hostKeyDetails ? "host_key_changed" : "error",
          errorCode,
          errorMessage,
          hostKeyDetails: hostKeyDetails ?? null,
        });
      },

      markDisconnected(tabId) {
        get().updateTab(tabId, { phase: "disconnected" });
      },
    }),
    {
      name: "netsphere.terminal-tabs",
      storage: createJSONStorage(() => localStorage),
      // Persist only durable identity. Runtime fields (sessionId, phase,
      // errorMessage, hostKeyDetails) reset on rehydrate because the SSH
      // sessions they describe no longer exist after an app restart.
      partialize: (state) => ({
        tabs: state.tabs.map(t => ({
          tabId: t.tabId,
          hostId: t.hostId,
          label: t.label,
          createdAt: t.createdAt,
          // Reset the runtime fields to a clean "disconnected" state.
          sessionId: null,
          phase: "disconnected" as TabPhase,
          errorMessage: null,
          errorCode: null,
          hostKeyDetails: null,
        })),
        activeTabId: state.activeTabId,
      }),
    },
  ),
);
