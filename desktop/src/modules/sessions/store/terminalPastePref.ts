/**
 * Terminal paste preferences (per browser).
 *
 * The web terminal can paste the clipboard via a mouse button. Two independent
 * actions can each be bound to a mouse button (or disabled):
 *   - quickButton: paste the clipboard immediately (no confirmation).
 *   - editButton:  open an editable popup pre-filled with the clipboard, so the
 *                  text can be reviewed/edited before it's sent to the terminal.
 *
 * "left" is intentionally not offered — the left button is needed for selecting
 * text. Persisted in localStorage.
 */
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

export type PasteButton = "none" | "middle" | "right";

interface TerminalPasteState {
  quickButton: PasteButton;
  editButton: PasteButton;
  setQuickButton: (b: PasteButton) => void;
  setEditButton: (b: PasteButton) => void;
}

export const useTerminalPaste = create<TerminalPasteState>()(
  persist(
    (set) => ({
      quickButton: "middle",
      editButton: "right",
      // Keep the two actions on distinct buttons (a button can't do both).
      setQuickButton: (b) => set((s) => ({ quickButton: b, editButton: b !== "none" && s.editButton === b ? "none" : s.editButton })),
      setEditButton: (b) => set((s) => ({ editButton: b, quickButton: b !== "none" && s.quickButton === b ? "none" : s.quickButton })),
    }),
    { name: "netsphere.terminal-paste", storage: createJSONStorage(() => localStorage) },
  ),
);
