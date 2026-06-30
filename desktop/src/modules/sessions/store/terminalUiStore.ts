/**
 * Terminal UI preferences (per browser).
 *
 * bottomGapPx: extra space reserved below the terminal so the last row / prompt
 * isn't hidden behind the OS taskbar. The browser can't measure the taskbar, so
 * the user sets this to suit their setup. Persisted in localStorage.
 */
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

interface TerminalUiState {
  bottomGapPx: number;
  setBottomGapPx: (n: number) => void;
}

export const useTerminalUi = create<TerminalUiState>()(
  persist(
    (set) => ({
      bottomGapPx: 40,
      setBottomGapPx: (n) => set({ bottomGapPx: Math.max(0, Math.min(200, Math.round(n) || 0)) }),
    }),
    { name: "netsphere.terminal-ui", storage: createJSONStorage(() => localStorage) },
  ),
);
