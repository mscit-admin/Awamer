/**
 * Guacamole protocol helpers (used by the RDP gateway to talk to guacd).
 *
 * The Guacamole wire protocol is a stream of text instructions. Each
 * instruction is a comma-separated list of elements terminated by a semicolon,
 * where every element is length-prefixed by its Unicode *codepoint* count:
 *
 *     <len>.<value>,<len>.<value>,…;
 *
 * e.g. `6.select,3.rdp;`
 *
 * These functions are pure (no I/O) so they can be unit-tested without guacd.
 * The gateway wires them to a TCP socket + WebSocket.
 */

/** Count Unicode codepoints (not UTF-16 units) — the length unit guacd uses. */
function codepointLength(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/** Encode a single Guacamole instruction from its elements. */
export function encodeInstruction(...elements: string[]): string {
  return elements.map((e) => `${codepointLength(e)}.${e}`).join(",") + ";";
}

/**
 * Read exactly `count` codepoints from `s` starting at UTF-16 index `start`.
 * Returns the substring and how many UTF-16 code units it spanned, or null if
 * `s` doesn't yet contain that many codepoints (partial read).
 */
function readCodepoints(s: string, start: number, count: number): { str: string; rawLen: number } | null {
  let idx = start;
  let n = 0;
  while (n < count) {
    if (idx >= s.length) return null;
    const cp = s.codePointAt(idx);
    if (cp === undefined) return null;
    idx += cp > 0xffff ? 2 : 1;
    n++;
  }
  if (idx > s.length) return null;
  return { str: s.slice(start, idx), rawLen: idx - start };
}

/**
 * Try to parse a single instruction from the front of `buf`. Returns the parsed
 * elements and how many UTF-16 units were consumed (so the caller can slice the
 * remainder), or null if `buf` doesn't yet hold a complete instruction.
 * Throws on a malformed length/separator.
 */
export function parseInstruction(buf: string): { elements: string[]; consumed: number } | null {
  const elements: string[] = [];
  let i = 0;
  for (;;) {
    const dot = buf.indexOf(".", i);
    if (dot < 0) return null; // length prefix not complete yet
    const len = Number(buf.slice(i, dot));
    if (!Number.isInteger(len) || len < 0) throw new Error("malformed guacamole length prefix");
    const val = readCodepoints(buf, dot + 1, len);
    if (val === null) return null; // value not fully arrived
    elements.push(val.str);
    const sepIdx = dot + 1 + val.rawLen;
    const sep = buf[sepIdx];
    if (sep === undefined) return null; // separator not arrived
    if (sep === ",") { i = sepIdx + 1; continue; }
    if (sep === ";") return { elements, consumed: sepIdx + 1 };
    throw new Error(`malformed guacamole separator: ${JSON.stringify(sep)}`);
  }
}

/**
 * Build the `connect` instruction that answers a guacd `args` instruction.
 *
 * `argsElements` is the full parsed `args` instruction, i.e.
 * `["args", "VERSION_1_5_0"?, "hostname", "port", …]`. The `connect` reply must
 * carry one value per element after the "args" opcode, in the same order:
 *   - a `VERSION_*` token is echoed back verbatim (protocol-version handshake),
 *   - every other element is a parameter name → looked up in `params`
 *     (missing → empty string, i.e. "use guacd's default").
 */
export function buildConnectInstruction(argsElements: string[], params: Record<string, string>): string {
  const names = argsElements.slice(1); // drop the "args" opcode
  const values = names.map((name) => (/^VERSION_/.test(name) ? name : (params[name] ?? "")));
  return encodeInstruction("connect", ...values);
}

export interface RdpConnectionSettings {
  hostname: string;
  port: number;
  username?: string | null;
  password?: string | null;
  domain?: string | null;
  /** Security mode: any | nla | tls | rdp | vmconnect. */
  security?: string;
  /** Accept the server certificate without validation (self-signed hosts). */
  ignoreCert?: boolean;
  width?: number;
  height?: number;
  dpi?: number;
  /** Extra/override guacd rdp parameters straight from host.options.rdp. */
  extra?: Record<string, string>;
}

/**
 * Map connection settings to the guacd `rdp` parameter names. Only names guacd
 * actually advertises in its `args` are sent (via buildConnectInstruction); the
 * rest are ignored, so listing common ones here is safe across guacd versions.
 */
export function rdpParamMap(s: RdpConnectionSettings): Record<string, string> {
  const map: Record<string, string> = {
    hostname: s.hostname,
    port: String(s.port),
    username: s.username ?? "",
    password: s.password ?? "",
    domain: s.domain ?? "",
    security: s.security ?? "any",
    "ignore-cert": s.ignoreCert === false ? "false" : "true",
    width: String(s.width ?? 1024),
    height: String(s.height ?? 768),
    dpi: String(s.dpi ?? 96),
    "resize-method": "display-update",
  };
  if (s.extra) {
    // Only allow-listed display/UX parameters; they can never override the
    // connection target or the credentials set above.
    for (const [k, v] of Object.entries(s.extra)) {
      if (RDP_EXTRA_PARAMS.has(k) && !(k in map)) map[k] = String(v);
    }
  }
  return map;
}

/** RDP security modes guacd accepts. */
export const RDP_SECURITY_MODES = new Set(["any", "nla", "nla-ext", "tls", "vmconnect", "rdp"]);

/**
 * guacd `rdp` parameters a host may override through `host.options.rdp`.
 * Display and UX settings only. Anything that changes WHERE guacd connects or
 * what it may touch on the gateway is excluded on purpose: RD Gateway
 * (`gateway-*`, would bypass the destination policy), drive redirection and
 * session recording (write files inside the guacd container), SFTP, printing,
 * Wake-on-LAN, `remote-app` / `initial-program`, `preconnection-*`.
 */
export const RDP_EXTRA_PARAMS: ReadonlySet<string> = new Set([
  "color-depth", "server-layout", "timezone", "console", "console-audio",
  "disable-audio", "enable-audio-input", "enable-wallpaper", "enable-theming",
  "enable-font-smoothing", "enable-full-window-drag", "enable-desktop-composition",
  "enable-menu-animations", "disable-bitmap-caching", "disable-offscreen-caching",
  "disable-glyph-caching", "disable-copy", "disable-paste", "normalize-clipboard",
  "read-only", "force-lossless", "resize-method",
]);

const SAFE_PARAM_VALUE = /^[A-Za-z0-9 _:./+-]{0,64}$/;

/**
 * Extract the RDP options a user stored on the host (`host.options.rdp`),
 * keeping only known-safe values: a valid security mode, a boolean
 * ignore-cert flag, and allow-listed extra parameters with short plain values.
 */
export function rdpHostOptions(options: Record<string, unknown> | null | undefined): {
  security?: string; ignoreCert?: boolean; extra?: Record<string, string>;
} {
  const raw = options?.rdp && typeof options.rdp === "object" ? (options.rdp as Record<string, unknown>) : {};
  const security = typeof raw.security === "string" && RDP_SECURITY_MODES.has(raw.security) ? raw.security : undefined;
  const ic = raw.ignore_cert ?? raw.ignoreCert;
  const ignoreCert = typeof ic === "boolean" ? ic : undefined;
  const extra: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!RDP_EXTRA_PARAMS.has(k) || v == null) continue;
    const val = typeof v === "boolean" || typeof v === "number" ? String(v) : typeof v === "string" ? v : null;
    if (val !== null && SAFE_PARAM_VALUE.test(val)) extra[k] = val;
  }
  return { security, ignoreCert, extra: Object.keys(extra).length ? extra : undefined };
}
