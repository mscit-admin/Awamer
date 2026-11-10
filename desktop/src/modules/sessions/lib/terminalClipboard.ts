/**
 * Terminal copy & paste — pure helpers shared by every xterm terminal
 * (browser SSH, desktop SSH, Telnet). The React wiring lives in
 * components/TerminalClipboard.tsx.
 *
 * Shortcuts (Windows / Linux):
 *   Copy        Ctrl+Shift+C · Ctrl+Insert · Ctrl+C while text is selected
 *   Paste       Ctrl+Shift+V · Shift+Insert · Ctrl+V
 *   Select all  Ctrl+Shift+A
 * macOS: Cmd+C / Cmd+V / Cmd+A; Ctrl+C always reaches the shell.
 *
 * Keys are matched on `KeyboardEvent.code` (the physical key), so the
 * shortcuts work the same with an Arabic or any other keyboard layout.
 */

export type ClipboardAction = "copy" | "copyAndClear" | "paste" | "selectAll";

export interface KeyPrefs {
  ctrlCCopies: boolean;
  ctrlVPastes: boolean;
}

type KeyLike = Pick<KeyboardEvent, "code" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey">;

/** Which clipboard action (if any) a key press maps to. `null` → send it to the shell. */
export function clipboardActionForKey(e: KeyLike, ctx: { isMac: boolean; hasSelection: boolean; prefs: KeyPrefs }): ClipboardAction | null {
  if (e.altKey) return null;
  if (ctx.isMac) {
    if (!e.metaKey || e.ctrlKey) return null;
    if (e.code === "KeyC") return ctx.hasSelection ? "copy" : null;
    if (e.code === "KeyV") return "paste";
    if (e.code === "KeyA") return "selectAll";
    return null;
  }
  if (e.metaKey) return null;
  if (e.ctrlKey && e.shiftKey) {
    if (e.code === "KeyC") return "copy";
    if (e.code === "KeyV") return "paste";
    if (e.code === "KeyA") return "selectAll";
    return null;
  }
  if (e.code === "Insert") {
    if (e.ctrlKey) return "copy";
    if (e.shiftKey) return "paste";
    return null;
  }
  if (e.ctrlKey && !e.shiftKey) {
    // Plain Ctrl+C copies only when something is selected; otherwise it is the
    // interrupt (^C) the shell needs.
    if (e.code === "KeyC" && ctx.hasSelection && ctx.prefs.ctrlCCopies) return "copyAndClear";
    if (e.code === "KeyV" && ctx.prefs.ctrlVPastes) return "paste";
  }
  return null;
}

/**
 * Clean text before it is pasted into a live shell:
 *  - drop bracketed-paste markers (ESC[200~ / ESC[201~) so pasted text cannot
 *    break out of bracketed-paste mode and have the rest run as typed keys;
 *  - normalise Windows/old-Mac line endings to "\n" (xterm turns these into
 *    Enter when it pastes).
 */
export function sanitizePaste(text: string): string {
  return text
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[20[01]~/g, "")
    .replace(/\r\n?/g, "\n");
}

/** True when the text would press Enter more than once or run something mid-text. */
export function isMultiline(text: string): boolean {
  const t = text.replace(/\n+$/, "");
  return t.includes("\n");
}

export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const p = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? "";
  return /mac/i.test(p);
}

/**
 * Write text to the system clipboard. Uses the async Clipboard API when the
 * page allows it, else falls back to a hidden textarea + execCommand("copy")
 * (plain-http pages, older webviews).
 */
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through */ }
  const active = document.activeElement as HTMLElement | null;
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  ta.style.pointerEvents = "none";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch { ok = false; }
  ta.remove();
  active?.focus?.();
  return ok;
}

/** Read the system clipboard; null when the browser refuses or has no API. */
export async function readClipboard(): Promise<string | null> {
  try {
    if (navigator.clipboard?.readText) return await navigator.clipboard.readText();
  } catch { /* denied */ }
  return null;
}
