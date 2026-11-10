import { describe, expect, it } from "vitest";
import { clipboardActionForKey, isMultiline, sanitizePaste } from "./terminalClipboard";

const key = (code: string, mods: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean } = {}) => ({
  code, ctrlKey: !!mods.ctrl, shiftKey: !!mods.shift, altKey: !!mods.alt, metaKey: !!mods.meta,
});
const on = { ctrlCCopies: true, ctrlVPastes: true };
const off = { ctrlCCopies: false, ctrlVPastes: false };
const pc = (sel: boolean, prefs = on) => ({ isMac: false, hasSelection: sel, prefs });
const mac = (sel: boolean) => ({ isMac: true, hasSelection: sel, prefs: on });

describe("clipboardActionForKey — Windows/Linux", () => {
  it("Ctrl+Shift+C / Ctrl+Insert copy; Ctrl+Shift+V / Shift+Insert paste; Ctrl+Shift+A selects all", () => {
    expect(clipboardActionForKey(key("KeyC", { ctrl: true, shift: true }), pc(true))).toBe("copy");
    expect(clipboardActionForKey(key("Insert", { ctrl: true }), pc(true))).toBe("copy");
    expect(clipboardActionForKey(key("KeyV", { ctrl: true, shift: true }), pc(false))).toBe("paste");
    expect(clipboardActionForKey(key("Insert", { shift: true }), pc(false))).toBe("paste");
    expect(clipboardActionForKey(key("KeyA", { ctrl: true, shift: true }), pc(false))).toBe("selectAll");
  });

  it("Ctrl+C copies only with a selection; otherwise it reaches the shell as ^C", () => {
    expect(clipboardActionForKey(key("KeyC", { ctrl: true }), pc(true))).toBe("copyAndClear");
    expect(clipboardActionForKey(key("KeyC", { ctrl: true }), pc(false))).toBeNull();
    expect(clipboardActionForKey(key("KeyC", { ctrl: true }), pc(true, off))).toBeNull();
  });

  it("Ctrl+V pastes unless turned off; other Ctrl keys go to the shell", () => {
    expect(clipboardActionForKey(key("KeyV", { ctrl: true }), pc(false))).toBe("paste");
    expect(clipboardActionForKey(key("KeyV", { ctrl: true }), pc(false, off))).toBeNull();
    expect(clipboardActionForKey(key("KeyD", { ctrl: true }), pc(true))).toBeNull();
    expect(clipboardActionForKey(key("KeyA", { ctrl: true }), pc(false))).toBeNull(); // readline: start of line
    expect(clipboardActionForKey(key("KeyC", { ctrl: true, alt: true }), pc(true))).toBeNull();
  });
});

describe("clipboardActionForKey — macOS", () => {
  it("Cmd+C copies a selection, Cmd+V pastes, Cmd+A selects all; Ctrl+C is always ^C", () => {
    expect(clipboardActionForKey(key("KeyC", { meta: true }), mac(true))).toBe("copy");
    expect(clipboardActionForKey(key("KeyC", { meta: true }), mac(false))).toBeNull();
    expect(clipboardActionForKey(key("KeyV", { meta: true }), mac(false))).toBe("paste");
    expect(clipboardActionForKey(key("KeyA", { meta: true }), mac(false))).toBe("selectAll");
    expect(clipboardActionForKey(key("KeyC", { ctrl: true }), mac(true))).toBeNull();
  });
});

describe("sanitizePaste / isMultiline", () => {
  it("strips bracketed-paste markers so pasted text cannot escape paste mode", () => {
    expect(sanitizePaste("echo hi\x1b[201~rm -rf /tmp/x\n")).toBe("echo hirm -rf /tmp/x\n");
    expect(sanitizePaste("\x1b[200~ls")).toBe("ls");
  });

  it("normalises CRLF / CR line endings", () => {
    expect(sanitizePaste("a\r\nb\rc")).toBe("a\nb\nc");
  });

  it("a single line with a trailing newline is not multi-line; two lines are", () => {
    expect(isMultiline("ls -la")).toBe(false);
    expect(isMultiline("ls -la\n")).toBe(false);
    expect(isMultiline("cd /tmp\nls")).toBe(true);
  });
});
