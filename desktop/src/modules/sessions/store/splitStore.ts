/**
 * Terminal split layout (per tab).
 *
 * A tab can be split into multiple panes arranged as a binary tree of
 * horizontal ("row" → left/right) and vertical ("col" → top/bottom) splits.
 * Each leaf is a Pane (its own SSH session / WebTerminalPane).
 *
 * In-memory only (not persisted): after a reload every tab starts as a single
 * pane, which matches the fact that the underlying SSH sessions don't survive a
 * reload either.
 */
import { create } from "zustand";

export interface Pane {
  paneId: string;
  hostId: string;
  label: string;
}

export type SplitNode =
  | { type: "leaf"; pane: Pane }
  | { type: "split"; id: string; dir: "row" | "col"; size: number; a: SplitNode; b: SplitNode };

function rid(prefix: string): string {
  // No Date.now()/Math.random ban here (browser) — unique enough per pane.
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
}

function isLeaf(n: SplitNode): n is Extract<SplitNode, { type: "leaf" }> {
  return n.type === "leaf";
}

/** Replace the leaf `paneId` with a split of [old leaf, new leaf]. */
function splitAt(node: SplitNode, paneId: string, dir: "row" | "col", makePane: () => Pane): { node: SplitNode; newPaneId: string | null } {
  if (isLeaf(node)) {
    if (node.pane.paneId !== paneId) return { node, newPaneId: null };
    const np = makePane();
    return {
      node: { type: "split", id: rid("s"), dir, size: 50, a: node, b: { type: "leaf", pane: np } },
      newPaneId: np.paneId,
    };
  }
  const ra = splitAt(node.a, paneId, dir, makePane);
  if (ra.newPaneId) return { node: { ...node, a: ra.node }, newPaneId: ra.newPaneId };
  const rb = splitAt(node.b, paneId, dir, makePane);
  if (rb.newPaneId) return { node: { ...node, b: rb.node }, newPaneId: rb.newPaneId };
  return { node, newPaneId: null };
}

/** Remove the leaf `paneId`; a split collapses to its remaining child. Returns null if the whole tree is gone. */
function removeAt(node: SplitNode, paneId: string): SplitNode | null {
  if (isLeaf(node)) return node.pane.paneId === paneId ? null : node;
  const a = removeAt(node.a, paneId);
  if (a === null) return node.b;
  const b = removeAt(node.b, paneId);
  if (b === null) return node.a;
  return { ...node, a, b };
}

function setSizeAt(node: SplitNode, splitId: string, size: number): SplitNode {
  if (isLeaf(node)) return node;
  if (node.id === splitId) return { ...node, size };
  return { ...node, a: setSizeAt(node.a, splitId, size), b: setSizeAt(node.b, splitId, size) };
}

export function collectPanes(node: SplitNode | undefined): Pane[] {
  if (!node) return [];
  if (isLeaf(node)) return [node.pane];
  return [...collectPanes(node.a), ...collectPanes(node.b)];
}

interface SplitState {
  layouts: Record<string, SplitNode>;
  focused: Record<string, string>;
  maximized: Record<string, string | undefined>;
  ensure(tabId: string, pane: Pane): void;
  split(tabId: string, paneId: string, dir: "row" | "col"): void;
  closePane(tabId: string, paneId: string): boolean; // true if the tab still has panes
  setSize(tabId: string, splitId: string, size: number): void;
  setFocus(tabId: string, paneId: string): void;
  toggleMax(tabId: string, paneId: string): void;
  removeTab(tabId: string): void;
}

export const useSplit = create<SplitState>((set, get) => ({
  layouts: {},
  focused: {},
  maximized: {},

  ensure(tabId, pane) {
    if (get().layouts[tabId]) return;
    set((s) => ({
      layouts: { ...s.layouts, [tabId]: { type: "leaf", pane } },
      focused: { ...s.focused, [tabId]: pane.paneId },
    }));
  },

  split(tabId, paneId, dir) {
    set((s) => {
      const root = s.layouts[tabId];
      if (!root) return s;
      const src = collectPanes(root).find((p) => p.paneId === paneId);
      if (!src) return s;
      const { node, newPaneId } = splitAt(root, paneId, dir, () => ({ paneId: rid("pane"), hostId: src.hostId, label: src.label }));
      if (!newPaneId) return s;
      return {
        layouts: { ...s.layouts, [tabId]: node },
        focused: { ...s.focused, [tabId]: newPaneId },
        maximized: { ...s.maximized, [tabId]: undefined },
      };
    });
  },

  closePane(tabId, paneId) {
    const root = get().layouts[tabId];
    if (!root) return false;
    const next = removeAt(root, paneId);
    if (next === null) {
      // Last pane removed — the caller should close the whole tab.
      set((s) => {
        const layouts = { ...s.layouts }; delete layouts[tabId];
        const focused = { ...s.focused }; delete focused[tabId];
        const maximized = { ...s.maximized }; delete maximized[tabId];
        return { layouts, focused, maximized };
      });
      return false;
    }
    const remaining = collectPanes(next);
    set((s) => ({
      layouts: { ...s.layouts, [tabId]: next },
      focused: { ...s.focused, [tabId]: remaining[0]?.paneId ?? "" },
      maximized: { ...s.maximized, [tabId]: undefined },
    }));
    return true;
  },

  setSize(tabId, splitId, size) {
    set((s) => {
      const root = s.layouts[tabId];
      if (!root) return s;
      return { layouts: { ...s.layouts, [tabId]: setSizeAt(root, splitId, Math.max(8, Math.min(92, size))) } };
    });
  },

  setFocus(tabId, paneId) {
    set((s) => ({ focused: { ...s.focused, [tabId]: paneId } }));
  },

  toggleMax(tabId, paneId) {
    set((s) => ({ maximized: { ...s.maximized, [tabId]: s.maximized[tabId] === paneId ? undefined : paneId } }));
  },

  removeTab(tabId) {
    set((s) => {
      const layouts = { ...s.layouts }; delete layouts[tabId];
      const focused = { ...s.focused }; delete focused[tabId];
      const maximized = { ...s.maximized }; delete maximized[tabId];
      return { layouts, focused, maximized };
    });
  },
}));
