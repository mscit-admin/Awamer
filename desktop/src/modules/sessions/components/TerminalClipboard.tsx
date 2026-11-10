/**
 * Copy & paste for an xterm terminal: keyboard shortcuts, copy-on-select,
 * mouse-button paste, a right-click menu, a "Copied" toast and the
 * review-before-paste dialog. Used by every terminal (browser SSH, desktop SSH,
 * Telnet) so they all behave the same.
 *
 * Render it as a SIBLING of the xterm container, inside the same positioned
 * (`relative`) parent — the dialog must not sit inside the container, whose
 * paste events are captured here.
 *
 * Everything that reaches the shell goes through `term.paste()`, so xterm
 * applies bracketed-paste mode and turns newlines into Enter exactly like a
 * native paste, and the pane's normal onData path (history, AI trigger) sees it.
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from "react";
import { ClipboardPaste, Copy, Eraser, TextSelect, AlertTriangle } from "lucide-react";
import type { Terminal } from "@xterm/xterm";

import { useTerminalPaste } from "../store/terminalPastePref";
import {
  clipboardActionForKey, copyText, isMacPlatform, isMultiline, readClipboard, sanitizePaste,
} from "../lib/terminalClipboard";

export interface TerminalClipboardHandle {
  /** Open the review/edit dialog, pre-filled from the clipboard when allowed. */
  openPasteReview: () => void;
}

interface Props {
  term: Terminal | null;
  container: HTMLElement | null;
  /** Shown in the paste dialog ("Paste into <label>"). */
  label: string;
}

const IS_MAC = isMacPlatform();
const MOD = IS_MAC ? "⌘" : "Ctrl+Shift+";

export const TerminalClipboard = forwardRef<TerminalClipboardHandle, Props>(function TerminalClipboard({ term, container, label }, ref) {
  const [menu, setMenu] = useState<{ x: number; y: number; hasSelection: boolean } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [review, setReview] = useState<{ text: string; multiline: boolean; blocked: boolean } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  // A keyboard paste waits briefly for the browser's native paste event.
  const pendingPaste = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearPendingPaste = useCallback(() => { if (pendingPaste.current) { clearTimeout(pendingPaste.current); pendingPaste.current = null; } }, []);

  const flash = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 1400);
  }, []);
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  const copySelection = useCallback(async (clear: boolean) => {
    if (!term || !term.hasSelection()) return;
    const text = term.getSelection();
    const ok = await copyText(text);
    flash(ok ? `Copied ${text.length} character${text.length === 1 ? "" : "s"}` : "Copy blocked by the browser");
    if (clear) term.clearSelection();
    term.focus();
  }, [term, flash]);

  // Single entry point for every paste: clean it, then review multi-line text
  // (when enabled) or send it straight to the shell.
  const deliver = useCallback((raw: string) => {
    if (!term) return;
    const text = sanitizePaste(raw);
    if (!text) return;
    if (useTerminalPaste.getState().warnMultiline && isMultiline(text)) {
      setReview({ text, multiline: true, blocked: false });
      return;
    }
    term.paste(text);
    term.focus();
  }, [term]);

  const pasteFromClipboard = useCallback(async () => {
    const text = await readClipboard();
    if (text == null) setReview({ text: "", multiline: false, blocked: true });
    else deliver(text);
  }, [deliver]);

  const openPasteReview = useCallback(async () => {
    const text = await readClipboard();
    const clean = sanitizePaste(text ?? "");
    setReview({ text: clean, multiline: isMultiline(clean), blocked: text == null });
  }, []);

  useImperativeHandle(ref, () => ({ openPasteReview: () => { void openPasteReview(); } }), [openPasteReview]);

  // Keyboard shortcuts.
  useEffect(() => {
    if (!term) return;
    term.attachCustomKeyEventHandler((e) => {
      const action = clipboardActionForKey(e, {
        isMac: IS_MAC, hasSelection: term.hasSelection(), prefs: useTerminalPaste.getState(),
      });
      if (!action) return true;
      if (e.type === "keydown") {
        if (action === "paste") {
          // Let the browser fire its native paste event (no permission prompt);
          // it is caught below. If none arrives, read the clipboard directly.
          clearPendingPaste();
          pendingPaste.current = setTimeout(() => { pendingPaste.current = null; void pasteFromClipboard(); }, 120);
        } else {
          e.preventDefault();
          if (action === "selectAll") term.selectAll();
          else void copySelection(action === "copyAndClear");
        }
      }
      return false; // never forward the shortcut to the shell
    });
    return () => {
      clearPendingPaste();
      term.attachCustomKeyEventHandler(() => true);
    };
  }, [term, copySelection, pasteFromClipboard, clearPendingPaste]);

  // Native paste (Ctrl/Cmd+V, Shift+Insert, browser menu), copy-on-select and
  // the mouse buttons — all on the terminal container.
  useEffect(() => {
    if (!term || !container) return;
    const onPaste = (e: ClipboardEvent) => {
      clearPendingPaste();
      const text = e.clipboardData?.getData("text/plain") ?? "";
      e.preventDefault();
      e.stopImmediatePropagation(); // xterm's own handler would paste it unreviewed
      deliver(text);
    };
    const onMouseUp = (e: MouseEvent) => {
      if (e.button !== 0) return;
      if (useTerminalPaste.getState().copyOnSelect && term.hasSelection()) void copySelection(false);
    };
    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 1) return; // middle only
      const p = useTerminalPaste.getState();
      if (p.quickButton === "middle") { e.preventDefault(); void pasteFromClipboard(); }
      else if (p.editButton === "middle") { e.preventDefault(); void openPasteReview(); }
    };
    const onAuxClick = (e: MouseEvent) => {
      const p = useTerminalPaste.getState();
      if (e.button === 1 && (p.quickButton === "middle" || p.editButton === "middle")) e.preventDefault();
    };
    const onContext = (e: MouseEvent) => {
      e.preventDefault();
      const p = useTerminalPaste.getState();
      if (p.quickButton === "right") void pasteFromClipboard();
      else if (p.editButton === "right") void openPasteReview();
      else setMenu({ x: e.clientX, y: e.clientY, hasSelection: term.hasSelection() });
    };
    container.addEventListener("paste", onPaste, true);
    container.addEventListener("mouseup", onMouseUp);
    container.addEventListener("mousedown", onMouseDown);
    container.addEventListener("auxclick", onAuxClick);
    container.addEventListener("contextmenu", onContext);
    return () => {
      container.removeEventListener("paste", onPaste, true);
      container.removeEventListener("mouseup", onMouseUp);
      container.removeEventListener("mousedown", onMouseDown);
      container.removeEventListener("auxclick", onAuxClick);
      container.removeEventListener("contextmenu", onContext);
    };
  }, [term, container, deliver, copySelection, pasteFromClipboard, openPasteReview, clearPendingPaste]);

  // Close the menu on any outside click, Escape, scroll or resize.
  useEffect(() => {
    if (!menu) return;
    const close = (e: Event) => {
      if (e instanceof MouseEvent && menuRef.current?.contains(e.target as Node)) return;
      if (e instanceof KeyboardEvent && e.key !== "Escape") return;
      setMenu(null);
    };
    window.addEventListener("mousedown", close, true);
    window.addEventListener("keydown", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("wheel", close, true);
    return () => {
      window.removeEventListener("mousedown", close, true);
      window.removeEventListener("keydown", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("wheel", close, true);
    };
  }, [menu]);

  function confirmReview() {
    if (!review || !term) return;
    const text = sanitizePaste(review.text);
    setReview(null);
    if (text) term.paste(text);
    term.focus();
  }
  function cancelReview() {
    setReview(null);
    term?.focus();
  }

  const run = (fn: () => void) => () => { setMenu(null); fn(); };

  return (
    <>
      {toast && (
        <div className="absolute top-2 right-3 z-30 pointer-events-none rounded-md bg-bg-elevated/95 border border-border px-2.5 py-1 text-2xs text-fg shadow-lg animate-fade-in">
          {toast}
        </div>
      )}

      {menu && (
        <div
          ref={menuRef}
          role="menu"
          style={{ left: Math.min(menu.x, window.innerWidth - 230), top: Math.min(menu.y, window.innerHeight - 200) }}
          className="fixed z-50 w-56 rounded-md border border-border bg-bg shadow-xl py-1 text-xs"
          onContextMenu={(e) => e.preventDefault()}
        >
          <MenuItem icon={<Copy className="size-3.5" />} label="Copy" hint={`${MOD}C`} disabled={!menu.hasSelection}
            onClick={run(() => void copySelection(false))} />
          <MenuItem icon={<ClipboardPaste className="size-3.5" />} label="Paste" hint={`${MOD}V`}
            onClick={run(() => void pasteFromClipboard())} />
          <MenuItem icon={<ClipboardPaste className="size-3.5" />} label="Paste and edit…"
            onClick={run(() => void openPasteReview())} />
          <div className="my-1 border-t border-border" />
          <MenuItem icon={<TextSelect className="size-3.5" />} label="Select all" hint={`${MOD}A`}
            onClick={run(() => { term?.selectAll(); term?.focus(); })} />
          <MenuItem icon={<Eraser className="size-3.5" />} label="Clear scrollback"
            onClick={run(() => { term?.clear(); term?.focus(); })} />
        </div>
      )}

      {review && (
        <div className="absolute inset-0 z-40 grid place-items-center bg-bg/80 backdrop-blur-sm p-4">
          <div className="card p-5 w-full max-w-lg">
            <div className="flex items-center gap-2 mb-3">
              <ClipboardPaste className="size-4 text-accent" />
              <h2 className="text-base font-semibold">Paste to terminal</h2>
            </div>
            {review.multiline && (
              <p className="flex items-start gap-1.5 text-xs text-amber-400 mb-2">
                <AlertTriangle className="size-3.5 shrink-0 mt-0.5" />
                This text has more than one line. Each line can run as a separate command — check it before pasting.
              </p>
            )}
            {review.blocked && (
              <p className="text-xs text-fg-muted mb-2">
                The browser didn't allow reading the clipboard. Press {IS_MAC ? "⌘V" : "Ctrl+V"} in the box below.
              </p>
            )}
            <p className="text-xs text-fg-muted mb-3">
              Review or edit the text, then paste it into <span className="font-mono">{label}</span>.
            </p>
            <textarea
              value={review.text}
              onChange={(e) => setReview({ ...review, text: e.target.value, multiline: isMultiline(e.target.value) })}
              autoFocus
              spellCheck={false}
              rows={8}
              onKeyDown={(e) => {
                if (e.key === "Escape") { e.preventDefault(); cancelReview(); }
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); confirmReview(); }
              }}
              placeholder={`Paste here (${IS_MAC ? "⌘V" : "Ctrl+V"}), edit, then click Paste…`}
              className="input font-mono w-full resize-y text-xs leading-relaxed"
            />
            <div className="flex items-center justify-between mt-3 gap-2">
              <span className="text-2xs text-fg-muted">
                {review.text.length} chars · {review.text ? review.text.split("\n").length : 0} line(s) · {IS_MAC ? "⌘" : "Ctrl"}+Enter to paste, Esc to cancel
              </span>
              <div className="flex items-center gap-2 shrink-0">
                <button onClick={cancelReview} className="btn-ghost text-sm">Cancel</button>
                <button onClick={confirmReview} disabled={!review.text} className="btn-primary text-sm inline-flex gap-1">
                  <ClipboardPaste className="size-3.5" /> Paste
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
});

function MenuItem({ icon, label, hint, onClick, disabled }: { icon: ReactNode; label: string; hint?: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      role="menuitem"
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-fg hover:bg-bg-elevated disabled:opacity-40 disabled:hover:bg-transparent"
    >
      <span className="shrink-0 text-fg-muted">{icon}</span>
      <span className="flex-1 truncate">{label}</span>
      {hint && <span className="text-2xs text-fg-subtle font-mono">{hint}</span>}
    </button>
  );
}
