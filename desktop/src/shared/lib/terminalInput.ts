/**
 * SEC-AI-INSERT-001 (ASVS V1.3.3) — make text safe to type into a live shell
 * WITHOUT running it.
 *
 * "Insert into terminal" promises the command won't run. Any CR/LF in the text
 * is an Enter keypress to the remote PTY, and other control bytes (ESC, ^C, ^D,
 * C1 CSI…) drive the line editor or terminal. Model output (prompt-injectable)
 * and stored history are untrusted, so everything except printable text is
 * removed: tabs become spaces, line breaks end the command (only the first line
 * is kept), all other C0/C1 controls and DEL are dropped.
 *
 * This is NOT applied to explicit pastes (`pasteRaw`), which keep newlines on
 * purpose, like a real terminal paste.
 */
export function sanitizeInsertedCommand(text: string): string {
  const firstLine = text.split(/[\r\n\u2028\u2029\u0085]/, 1)[0] ?? "";
  return firstLine
    .replace(/\t/g, " ")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .trim();
}
