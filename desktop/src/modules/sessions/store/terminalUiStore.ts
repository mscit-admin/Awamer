/**
 * Terminal UI preferences (per browser).
 *
 * bottomGapPx: extra space reserved between the terminal's last row and the
 * status bar, so the prompt isn't hidden behind the OS taskbar. The browser
 * can't measure the taskbar, so the user sets this to suit their setup. The
 * status bar itself stays flush at the bottom. Defaults to 0 (the status bar
 * already separates the prompt from the window edge). Persisted in localStorage.
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
      bottomGapPx: 0,
      setBottomGapPx: (n) => set({ bottomGapPx: Math.max(0, Math.min(200, Math.round(n) || 0)) }),
    }),
    { name: "netsphere.terminal-ui", storage: createJSONStorage(() => localStorage) },
  ),
);
