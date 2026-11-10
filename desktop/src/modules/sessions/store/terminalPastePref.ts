/**
 * Terminal copy & paste preferences (per browser).
 *
 * Mouse paste: two independent actions can each be bound to a mouse button
 * (or disabled):
 *   - quickButton: paste the clipboard immediately (no confirmation).
 *   - editButton:  open an editable popup pre-filled with the clipboard, so the
 *                  text can be reviewed/edited before it's sent to the terminal.
 * When right-click is bound to neither, it opens the terminal context menu
 * (Copy / Paste / Paste… / Select all / Clear).
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
  /** Copy the selection to the clipboard as soon as the mouse is released. */
  copyOnSelect: boolean;
  /** Windows/Linux: Ctrl+C copies when text is selected (otherwise it sends ^C). */
  ctrlCCopies: boolean;
  /** Windows/Linux: Ctrl+V pastes (otherwise it sends ^V to the shell). */
  ctrlVPastes: boolean;
  /** Review a paste that contains more than one line before it is sent. */
  warnMultiline: boolean;
  setQuickButton: (b: PasteButton) => void;
  setEditButton: (b: PasteButton) => void;
  setCopyOnSelect: (v: boolean) => void;
  setCtrlCCopies: (v: boolean) => void;
  setCtrlVPastes: (v: boolean) => void;
  setWarnMultiline: (v: boolean) => void;
}

export const useTerminalPaste = create<TerminalPasteState>()(
  persist(
    (set) => ({
      quickButton: "middle",
      editButton: "none",
      copyOnSelect: true,
      ctrlCCopies: true,
      ctrlVPastes: true,
      warnMultiline: true,
      // Keep the two actions on distinct buttons (a button can't do both).
      setQuickButton: (b) => set((s) => ({ quickButton: b, editButton: b !== "none" && s.editButton === b ? "none" : s.editButton })),
      setEditButton: (b) => set((s) => ({ editButton: b, quickButton: b !== "none" && s.quickButton === b ? "none" : s.quickButton })),
      setCopyOnSelect: (v) => set({ copyOnSelect: v }),
      setCtrlCCopies: (v) => set({ ctrlCCopies: v }),
      setCtrlVPastes: (v) => set({ ctrlVPastes: v }),
      setWarnMultiline: (v) => set({ warnMultiline: v }),
    }),
    {
      name: "netsphere.terminal-paste",
      storage: createJSONStorage(() => localStorage),
      version: 1,
      // v0 defaulted right-click to the edit popup; v1 gives right-click the
      // context menu (which still offers "Paste…"). Other choices are kept.
      migrate: (persisted, version) => {
        const s = (persisted ?? {}) as Partial<TerminalPasteState>;
        if (version < 1 && s.editButton === "right") s.editButton = "none";
        return s as TerminalPasteState;
      },
    },
  ),
);
