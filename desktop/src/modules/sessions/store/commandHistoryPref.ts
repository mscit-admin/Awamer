/**
 * Per-user, per-browser preference: whether to save shell command history.
 *
 * OFF by default — typed commands can contain secrets (passwords, tokens), so
 * recording them is strictly opt-in. The flag lives in localStorage; the actual
 * command rows are stored server-side per user (see commandHistoryApi).
 */
import { create } from "zustand";

const KEY = "netsphere.saveCommandHistory";

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

interface PrefState {
  saveHistory: boolean;
  setSaveHistory: (on: boolean) => void;
}

export const useCommandHistoryPref = create<PrefState>((set) => ({
  saveHistory: read(),
  setSaveHistory(on: boolean) {
    try {
      localStorage.setItem(KEY, on ? "1" : "0");
    } catch {
      /* ignore */
    }
    set({ saveHistory: on });
  },
}));
