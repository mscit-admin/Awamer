/**
 * Browser SSH terminal.
 *
 * Used when the app runs as a plain web page (no Tauri). Instead of a native
 * SSH client, it opens a WebSocket to the backend SSH gateway
 * (/api/v1/ssh/connect) which holds the real SSH connection and streams bytes
 * both ways. xterm.js renders the terminal.
 *
 * Wire protocol mirrors backend/src/ssh/gateway.ts:
 *   send: binary = keystrokes, text JSON = {type:"resize",cols,rows}
 *   recv: binary = output, text JSON = {type:"status"|"error",...}
 */
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { AlertCircle, Loader2, Lock, Power, History, Check, StickyNote, ClipboardPaste, Maximize2, Minimize2, LayoutGrid, SplitSquareHorizontal, SplitSquareVertical, ExternalLink, X, Bot } from "lucide-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";

import { useAuthStore } from "@/modules/auth/store/authStore";
import { useTerminalTabs, type TerminalTab } from "../store/terminalTabsStore";
import { useCommandHistoryPref } from "../store/commandHistoryPref";
import { useTerminalUi } from "../store/terminalUiStore";
import { commandHistoryApi } from "../api/commandHistoryApi";
import { CommandHistoryPanel } from "./CommandHistoryPanel";
import { TerminalClipboard, type TerminalClipboardHandle } from "./TerminalClipboard";
import { NotesPanel } from "@/modules/notes/NotesPanel";
import { AiAssistPanel } from "@/modules/ai/AiAssistPanel";
import { sanitizeInsertedCommand } from "@/shared/lib/terminalInput";
import { useCan } from "@/shared/lib/permissions";
import { useBranding } from "@/shared/branding";

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "";

function gatewayUrl(hostId: string, cols: number, rows: number): string {
  // Resolve an absolute ws(s):// URL from the configured API base (or the
  // current origin when the API is served same-origin).
  //
  // SEC-001: the access token and any SSH password/passphrase are NEVER placed
  // in the URL (they would leak into nginx/proxy access logs and browser
  // history). Only the non-secret host id + initial window size travel in the
  // query; the token and secrets are sent as the first WS frame after open.
  const base = API_BASE_URL || window.location.origin;
  const u = new URL(base);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = (u.pathname.replace(/\/$/, "")) + "/api/v1/ssh/connect";
  u.searchParams.set("host_id", hostId);
  u.searchParams.set("cols", String(cols));
  u.searchParams.set("rows", String(rows));
  return u.toString();
}

/**
 * Fold a chunk of user keystrokes into a running line buffer, emitting any
 * completed command lines (on Enter). Best-effort reconstruction: handles
 * printable text, backspace, and Ctrl-C/Ctrl-U cancel; skips escape sequences
 * (arrow keys, etc.) so they don't corrupt the captured text.
 */
function foldKeystrokes(buf: string, chunk: string): { buf: string; commands: string[] } {
  const commands: string[] = [];
  for (let i = 0; i < chunk.length; i++) {
    const ch = chunk[i]!;
    const code = ch.charCodeAt(0);
    if (ch === "\r" || ch === "\n") {
      const cmd = buf.trim();
      if (cmd) commands.push(cmd);
      buf = "";
    } else if (ch === "\x7f" || ch === "\b") {
      buf = buf.slice(0, -1);
    } else if (ch === "\x03" || ch === "\x15") {
      // Ctrl-C / Ctrl-U → abandon the current line.
      buf = "";
    } else if (ch === "\x1b") {
      // Escape sequence (e.g. arrow key) — skip to the end of this chunk's seq.
      // Most fit in this chunk; drop the rest of the chunk's control bytes.
      while (i + 1 < chunk.length && chunk.charCodeAt(i + 1) < 0x40) i++;
      if (i + 1 < chunk.length) i++; // final byte of the sequence
    } else if (code >= 0x20) {
      buf += ch;
    }
  }
  return { buf, commands };
}

interface ServerStats {
  host?: string; nproc?: number; uptime_sec?: number; load1?: number;
  cpu?: number; mem?: number; mem_used_mb?: number; mem_total_mb?: number;
  disk?: number; rx_bps?: number; tx_bps?: number;
}

function fmtBps(n?: number): string {
  if (n == null) return "—";
  if (n < 1024) return `${n} B/s`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB/s`;
  return `${(n / 1024 / 1024).toFixed(1)} MB/s`;
}
function fmtDur(sec: number): string {
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
// The status bar is attached to the always-dark terminal surface, so it uses
// fixed dark-on-light-text colours (not theme tokens) to stay legible in both
// light and dark app themes.
function barClass(pct?: number): string {
  if (pct == null) return "text-slate-300";
  if (pct >= 90) return "text-red-400";
  if (pct >= 75) return "text-amber-300";
  return "text-emerald-300";
}

function TerminalStatusBar({ stats, connectedAt, fallbackName, username }: { stats: ServerStats | null; connectedAt: number | null; fallbackName: string; username?: string | null }) {
  const [, force] = useState(0);
  useEffect(() => { const id = setInterval(() => force((n) => n + 1), 1000); return () => clearInterval(id); }, []);
  const elapsed = connectedAt ? Math.max(0, Math.round((Date.now() - connectedAt) / 1000)) : 0;
  const now = new Date();
  const dateStr = now.toLocaleDateString();
  const timeStr = now.toLocaleTimeString();
  const Metric = ({ label, value, cls }: { label: string; value: string; cls?: string }) => (
    <span className="inline-flex items-baseline gap-1 whitespace-nowrap">
      <span className="text-slate-500 uppercase text-[9px] tracking-wider">{label}</span>
      <span className={"font-mono " + (cls ?? "text-slate-100")}>{value}</span>
    </span>
  );
  const Divider = () => <span className="h-3 w-px bg-white/10 shrink-0" />;
  return (
    <div className="shrink-0 flex items-center gap-3 px-3 py-1 border-t border-white/10 bg-[#0b0e14] text-2xs text-slate-200 overflow-x-auto">
      {/* Left corner: who is signed in to Awamer, current date/time, and how long
          this session has been open. */}
      {username && <Metric label="USER" value={username} cls="text-slate-100" />}
      <Metric label="DATE" value={dateStr} cls="text-slate-300" />
      <Metric label="TIME" value={timeStr} cls="text-slate-300" />
      <Metric label="SESSION" value={fmtDur(elapsed)} cls="text-sky-300" />
      <Divider />
      {/* Server identity + live vitals. */}
      <span className="inline-flex items-center gap-1 font-medium text-slate-100 whitespace-nowrap">
        <span className="size-1.5 rounded-full bg-emerald-400" /> {stats?.host || fallbackName}
      </span>
      <Metric label="CPU" value={stats?.cpu != null ? `${stats.cpu}%` : "…"} cls={barClass(stats?.cpu)} />
      <Metric label="RAM" value={stats?.mem != null ? `${stats.mem}%` : "…"} cls={barClass(stats?.mem)} />
      {stats?.mem_total_mb != null && <Metric label="" value={`${(stats.mem_used_mb! / 1024).toFixed(1)}/${(stats.mem_total_mb / 1024).toFixed(1)}G`} cls="text-slate-300" />}
      <Metric label="DISK" value={stats?.disk != null ? `${stats.disk}%` : "…"} cls={barClass(stats?.disk)} />
      <Metric label="LOAD" value={stats?.load1 != null ? stats.load1.toFixed(2) + (stats.nproc ? `/${stats.nproc}` : "") : "…"} cls="text-slate-200" />
      <Metric label="NET" value={`↓${fmtBps(stats?.rx_bps)} ↑${fmtBps(stats?.tx_bps)}`} cls="text-slate-300" />
      {stats?.uptime_sec != null && <Metric label="UP" value={fmtDur(stats.uptime_sec)} cls="text-slate-300" />}
      <span className="ml-auto" />
    </div>
  );
}

function ToolItem({ icon, label, onClick, danger, keepOpen }: { icon: ReactNode; label: string; onClick: () => void; danger?: boolean; keepOpen?: boolean }) {
  return (
    <button
      onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
      onClick={onClick}
      className={"w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-bg-elevated " + (danger ? "text-red-400" : "text-fg")}
    >
      <span className="shrink-0 text-fg-muted">{icon}</span>
      <span className="truncate">{label}</span>
      {keepOpen && <span className="ml-auto text-2xs text-fg-subtle">•</span>}
    </button>
  );
}

export interface PaneActions {
  onSplitH: () => void;
  onSplitV: () => void;
  onMaximize: () => void;
  isMaximized: boolean;
  onNewTab: () => void;
  onClose: () => void;
  isSplit: boolean;
}

export function WebTerminalPane({ tab, paneActions }: { tab: TerminalTab; paneActions?: PaneActions }) {
  const accessToken = useAuthStore((s) => s.accessToken);
  const hasToken = accessToken != null && accessToken !== "";
  const refreshTokens = useAuthStore((s) => s.refreshTokens);
  const username = useAuthStore((s) => s.user?.username ?? null);
  const updateTab = useTerminalTabs((s) => s.updateTab);
  const saveHistory = useCommandHistoryPref((s) => s.saveHistory);
  const setSaveHistory = useCommandHistoryPref((s) => s.setSaveHistory);
  const canHistory = useCan("command_history:read");
  const canAi = useCan("ai:use");
  const bottomGapPx = useTerminalUi((s) => s.bottomGapPx);
  const logoUrl = useBranding((s) => s.logoUrl);
  const terminalWatermark = useBranding((s) => s.terminalWatermark);
  const brandingLoaded = useBranding((s) => s.loaded);
  // Dedicated terminal watermark wins; fall back to the app logo.
  const watermarkUrl = terminalWatermark || logoUrl;
  // Only fall back to the username watermark once branding is known — otherwise
  // the username would flash before the logo loads.
  const showUsernameWatermark = brandingLoaded && !watermarkUrl && !!username;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  // State copy of the terminal so the copy/paste layer mounts once xterm exists.
  const [termObj, setTermObj] = useState<Terminal | null>(null);
  const clipRef = useRef<TerminalClipboardHandle | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  // Auto-reconnect on unexpected drops: count consecutive attempts + a pending timer.
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Command-history capture. We reconstruct each typed line from the user's
  // keystrokes (xterm.onData) and POST it on Enter — but only when the user
  // has opted in. Read the flag through a ref so the keystroke handler always
  // sees the latest value without re-subscribing the WebSocket.
  const lineBufRef = useRef("");
  const saveHistoryRef = useRef(saveHistory && canHistory);
  useEffect(() => { saveHistoryRef.current = saveHistory && canHistory; }, [saveHistory, canHistory]);

  // Inline "AI: <question>" trigger. We track the current line and, when the
  // user submits a line starting with "AI:", open the assistant instead of
  // running it in the shell. Read live values through refs so the keystroke
  // handler never needs to re-subscribe.
  const aiLineRef = useRef("");
  const canAiRef = useRef(canAi);
  useEffect(() => { canAiRef.current = canAi; }, [canAi]);
  const aiTriggerRef = useRef<(q: string, provider?: string) => void>(() => {});

  // Refit the terminal when the bottom gap changes.
  useEffect(() => {
    const t = setTimeout(() => window.dispatchEvent(new Event("resize")), 50);
    return () => clearTimeout(t);
  }, [bottomGapPx]);

  const [showHistory, setShowHistory] = useState(false);
  const [showNotes, setShowNotes] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [showAi, setShowAi] = useState(false);
  const [aiQuestion, setAiQuestion] = useState<string | null>(null);
  const [aiProvider, setAiProvider] = useState<string | null>(null);
  const [showAiHint, setShowAiHint] = useState(false);
  const aiHintOffRef = useRef(false);
  useEffect(() => { try { aiHintOffRef.current = localStorage.getItem("netsphere.ai-hint-off") === "1"; } catch { /* ignore */ } }, []);
  const toolsRef = useRef<HTMLDivElement | null>(null);
  // Stable opener used by the inline "AI:" interceptor (avoids re-subscribing onData).
  useEffect(() => { aiTriggerRef.current = (q: string, provider?: string) => { setAiQuestion(q); setAiProvider(provider ?? null); setShowAi(true); }; }, []);

  const [phase, setPhase] = useState<"connecting" | "connected" | "error" | "need_password">("connecting");
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [attempt, setAttempt] = useState(0); // bump to force reconnect
  const [stats, setStats] = useState<ServerStats | null>(null);
  const [connectedAt, setConnectedAt] = useState<number | null>(null);

  // Mount xterm once.
  useEffect(() => {
    if (!containerRef.current || termRef.current) return;
    const term = new Terminal({
      fontSize: 13,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      cursorBlink: true,
      // Transparent so the username watermark behind the canvas shows through.
      allowTransparency: true,
      theme: { background: "rgba(0,0,0,0)", selectionBackground: "rgba(61,220,151,0.35)" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(containerRef.current);
    try { fit.fit(); } catch { /* not visible yet */ }
    termRef.current = term;
    setTermObj(term);
    fitRef.current = fit;

    const onResize = () => {
      try {
        fit.fit();
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
        }
      } catch { /* ignore */ }
    };
    window.addEventListener("resize", onResize);

    // Refit whenever the container itself changes size — covers the persistent
    // terminal being shown/hidden, sidebar toggles, and OS chrome differences
    // (e.g. Windows) that a window 'resize' event alone misses.
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(onResize);
    });
    ro.observe(containerRef.current);

    return () => {
      mountedRef.current = false;
      window.removeEventListener("resize", onResize);
      ro.disconnect();
      cancelAnimationFrame(raf);
      if (reconnectTimerRef.current) { clearTimeout(reconnectTimerRef.current); reconnectTimerRef.current = null; }
      term.dispose();
      termRef.current = null;
      setTermObj(null);
    };
  }, []);

  // Fullscreen (Tools → Fullscreen); the browser's native Escape returns.
  // Double-click is left to the terminal, where it selects a word. Refit xterm
  // whenever fullscreen toggles.
  useEffect(() => {
    const onFsChange = () => {
      setIsFullscreen(document.fullscreenElement === rootRef.current);
      setTimeout(() => window.dispatchEvent(new Event("resize")), 60);
    };
    document.addEventListener("fullscreenchange", onFsChange);
    return () => {
      document.removeEventListener("fullscreenchange", onFsChange);
    };
  }, []);

  function toggleFullscreen() {
    if (document.fullscreenElement) void document.exitFullscreen?.().catch(() => {});
    else void rootRef.current?.requestFullscreen?.().catch(() => {});
  }

  // Close the Tools menu when clicking anywhere outside it. Capture phase so it
  // fires even over the xterm canvas (which stops propagation), and Escape closes too.
  useEffect(() => {
    if (!toolsOpen) return;
    const onDown = (e: MouseEvent) => {
      if (toolsRef.current && !toolsRef.current.contains(e.target as Node)) setToolsOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setToolsOpen(false); };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [toolsOpen]);

  // (Re)connect when token / attempt changes.
  useEffect(() => {
    const term = termRef.current;
    // Read the freshest token at connect time (getState), so a token refresh
    // during Retry does NOT itself re-trigger this effect — only `attempt` does.
    // That guarantees exactly one reconnect per Retry (no double-open race,
    // which some browsers — notably Firefox — mishandle).
    const token = useAuthStore.getState().accessToken;
    if (!term || !token) return;

    try { fitRef.current?.fit(); } catch { /* ignore */ }
    const cols = term.cols || 80;
    const rows = term.rows || 24;

    setPhase("connecting");
    setError(null);
    setStats(null);
    setConnectedAt(null);
    updateTab(tab.tabId, { phase: "connecting", errorMessage: null, errorCode: null });

    const pw = attempt > 0 && password ? password : undefined;
    const ws = new WebSocket(gatewayUrl(tab.hostId, cols, rows));
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    // SEC-001: authenticate over the channel. Send the token (and any password
    // override) as the first frame once the socket is open — never in the URL.
    ws.onopen = () => {
      if (wsRef.current !== ws) return;
      const frame: { type: "auth"; token: string; password?: string } = { type: "auth", token };
      if (pw) frame.password = pw;
      ws.send(JSON.stringify(frame));
    };
    // Tracks whether this specific socket ever reached "connected", so a late
    // close can tell a real disconnect from a failed handshake.
    let opened = false;

    const dataDisp = term.onData((d) => {
      const send = (s: string) => { if (ws.readyState === WebSocket.OPEN) ws.send(new TextEncoder().encode(s)); };

      // Inline AI trigger — "AI: <q>" or "AI @provider: <q>" — intercepted on
      // Enter so it never runs in the shell.
      if (canAiRef.current && (d === "\r" || d === "\n")) {
        const m = /^\s*ai\s*(?:@\s*([^:]+?)\s*)?:\s*(.+)$/i.exec(aiLineRef.current);
        if (m && m[2]!.trim()) {
          send("\x15");            // Ctrl-U: clear the typed line from the shell prompt
          aiLineRef.current = "";
          lineBufRef.current = "";
          aiTriggerRef.current(m[2]!.trim(), m[1]?.trim() || undefined);
          return;                  // swallow the Enter
        }
      }

      send(d);

      // Track the current line for the AI trigger.
      if (canAiRef.current) {
        aiLineRef.current = (d === "\r" || d === "\n") ? "" : foldKeystrokes(aiLineRef.current, d).buf;
      }

      // Capture typed commands when the user has opted in.
      if (saveHistoryRef.current) {
        const { buf, commands } = foldKeystrokes(lineBufRef.current, d);
        lineBufRef.current = buf;
        for (const command of commands) {
          commandHistoryApi
            .add({ command, hostId: tab.hostId, hostLabel: tab.label })
            .catch(() => { /* best-effort; never disrupt the session */ });
        }
      } else {
        lineBufRef.current = "";
      }
    });

    ws.onmessage = (ev) => {
      if (wsRef.current !== ws) return; // ignore messages from a superseded socket
      if (typeof ev.data === "string") {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === "status" && msg.status === "connected") {
            opened = true;
            reconnectAttemptsRef.current = 0; // healthy again — reset the backoff
            setPhase("connected");
            setConnectedAt((t) => t ?? Date.now());
            updateTab(tab.tabId, { phase: "connected" });
            ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
            // First-run AI hint: show how to use the assistant on each new terminal.
            if (canAiRef.current && !aiHintOffRef.current) {
              setShowAiHint(true);
              setTimeout(() => setShowAiHint(false), 15000);
            }
          } else if (msg.type === "stats" && msg.data) {
            setStats(msg.data as ServerStats);
          } else if (msg.type === "error") {
            if (msg.code === "no_credential") {
              setPhase("need_password");
            } else {
              setPhase("error");
              setError(msg.message || "connection failed");
              updateTab(tab.tabId, { phase: "error", errorMessage: msg.message, errorCode: msg.code });
            }
          }
        } catch { /* ignore non-JSON text */ }
        return;
      }
      // Binary → terminal output.
      term.write(new Uint8Array(ev.data as ArrayBuffer));
    };

    ws.onclose = (ev) => {
      dataDisp.dispose();
      if (!mountedRef.current || wsRef.current !== ws) return; // superseded / unmounted — ignore
      // Only auto-reconnect on an ABNORMAL close (network drop → code 1006 /
      // !wasClean). Deliberate server closes — shell `exit`, idle timeout,
      // auth error — arrive as a clean 1000 close and must NOT reconnect
      // (otherwise idle-timeout loops forever and `exit` re-opens the shell).
      const abnormal = !ev.wasClean || ev.code === 1006;
      if (opened && abnormal) {
        // Brief network blip — self-heal with backoff (refresh token first).
        updateTab(tab.tabId, { phase: "disconnected" });
        if (reconnectAttemptsRef.current < 6) {
          reconnectAttemptsRef.current += 1;
          const n = reconnectAttemptsRef.current;
          const delay = Math.min(8000, 1000 * 2 ** (n - 1));
          term.writeln(`\r\n\x1b[33m*** connection lost — reconnecting (${n})… ***\x1b[0m`);
          setPhase("connecting");
          if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
          reconnectTimerRef.current = setTimeout(() => {
            void refreshTokens().catch(() => {}).finally(() => setAttempt((a) => a + 1));
          }, delay);
        } else {
          term.writeln("\r\n\x1b[31m*** disconnected — reconnect failed ***\x1b[0m");
          setPhase("error");
          setError("Connection keeps dropping. Check the network/server, then click Retry.");
        }
      } else if (opened) {
        // Clean, deliberate close (exit / idle timeout / server) — end the
        // session; the user can click Retry to reconnect.
        term.writeln("\r\n\x1b[31m*** disconnected ***\x1b[0m");
        updateTab(tab.tabId, { phase: "disconnected" });
        setPhase((p) => (p === "connected" ? "error" : p));
        setError((e) => e ?? "The session was closed.");
      } else {
        // Never fully connected — a failed attempt.
        setPhase((p) => (p === "connecting" ? "error" : p));
      }
    };
    ws.onerror = () => {
      if (wsRef.current !== ws) return; // ignore errors from a superseded socket
      setPhase((p) => (p === "need_password" ? p : "error"));
      setError((e) => e ?? "WebSocket error — check the server is reachable");
    };

    return () => {
      dataDisp.dispose();
      try { ws.close(); } catch { /* ignore */ }
    };
    // Depend on token PRESENCE (not its value) so a refresh doesn't re-run this;
    // `attempt` is the single, explicit reconnect trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasToken, tab.hostId, attempt]);

  function submitPassword(e: FormEvent) {
    e.preventDefault();
    if (!password) return;
    setAttempt((n) => n + 1);
  }

  // Retry: refresh the access token first (the WS uses it directly and doesn't
  // get the auto-refresh that REST calls do, so a long session's token may have
  // expired), then force a fresh reconnect. If the refresh token is also gone,
  // don't silently hang on "connecting" — surface a clear error.
  async function reconnect() {
    reconnectAttemptsRef.current = 0;
    if (reconnectTimerRef.current) { clearTimeout(reconnectTimerRef.current); reconnectTimerRef.current = null; }
    setPhase("connecting");
    setError(null);
    let token: string | null = accessToken;
    try { token = await refreshTokens(); } catch { token = accessToken; }
    if (!token) {
      setPhase("error");
      setError("Your session has expired. Please sign in again.");
      return;
    }
    setAttempt((n) => n + 1);
  }

  // Type a command at the prompt WITHOUT running it (AI suggestion / history).
  // SEC-AI-INSERT-001: strip CR/LF and control bytes so untrusted text can't
  // press Enter or drive the line editor.
  function insertCommand(raw: string) {
    const command = sanitizeInsertedCommand(raw);
    if (!command) return;
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(new TextEncoder().encode(command));
      lineBufRef.current = saveHistoryRef.current ? command : "";
    }
    termRef.current?.focus();
  }

  return (
    <div ref={rootRef} className="flex flex-col h-full w-full bg-[#0b0e14]">
      {/* Terminal area — fills the space above the status bar. The user-adjustable
          bottom gap cushions the prompt from the status bar / OS taskbar; the
          status bar itself stays flush at the window bottom (no dead band). */}
      <div className="relative flex-1 min-h-0" style={{ paddingBottom: bottomGapPx }}>
      {/* Faint watermark behind the terminal: the dedicated terminal watermark
          (or the app logo) if one is set, otherwise the username (so you can
          still tell whose session this is). */}
      {(watermarkUrl || showUsernameWatermark) && (
        <div className="absolute inset-0 z-0 grid place-items-center pointer-events-none select-none overflow-hidden">
          {watermarkUrl ? (
            <img src={watermarkUrl} alt="" className="max-w-[45%] max-h-[45%] object-contain opacity-[0.13]" />
          ) : (
            <div className="text-center -rotate-12">
              <div className="font-mono font-bold uppercase tracking-widest text-white/[0.05] leading-none whitespace-nowrap text-[12vw]">
                {username}
              </div>
              <div className="font-mono text-white/[0.06] mt-2 text-[2.2vw]">{tab.label}</div>
            </div>
          )}
        </div>
      )}
      <div ref={containerRef} className="absolute inset-0 z-10 px-2 pt-2 pb-2" />
      <TerminalClipboard ref={clipRef} term={termObj} container={termObj ? containerRef.current : null} label={tab.label} />

      {showAiHint && phase === "connected" && canAi && (
        <div className="absolute top-9 left-1/2 -translate-x-1/2 z-30 w-[min(92%,34rem)] rounded-lg border border-accent/30 bg-bg/95 backdrop-blur shadow-xl px-4 py-3 text-xs animate-fade-in">
          <div className="flex items-start gap-2">
            <Bot className="size-4 text-accent shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <div className="font-medium text-fg mb-1">AI assistant is available here</div>
              <div className="text-fg-muted mb-2">Type <span className="font-mono text-accent">AI:</span> then what you want and press Enter. Try one:</div>
              <div className="flex flex-wrap gap-1.5">
                {["show the 10 largest files", "restart nginx", "why is my disk full", "open ports and who is listening"].map((ex) => (
                  <button key={ex} onClick={() => { setAiQuestion(ex); setAiProvider(null); setShowAi(true); setShowAiHint(false); }}
                    className="px-2 py-1 rounded bg-bg-elevated border border-border font-mono text-2xs text-fg-muted hover:border-accent/40 hover:text-accent transition-colors">
                    AI: {ex}
                  </button>
                ))}
              </div>
              <div className="text-2xs text-fg-muted mt-2">Pick a specific AI with <span className="font-mono text-accent">AI @Cohere:</span> …, or open <span className="font-medium">Tools → Ask AI</span>. Suggested commands are inserted, never run.</div>
              <button onClick={() => { try { localStorage.setItem("netsphere.ai-hint-off", "1"); } catch { /* ignore */ } aiHintOffRef.current = true; setShowAiHint(false); }}
                className="mt-2 text-2xs text-fg-subtle hover:text-fg-muted underline">Don't show this again</button>
            </div>
            <button onClick={() => setShowAiHint(false)} title="Dismiss" className="text-fg-muted hover:text-fg shrink-0"><X className="size-3.5" /></button>
          </div>
        </div>
      )}

      {(phase === "connected" || phase === "error") && (
        // Floating tools handle: tucked at the top-centre, faint until you hover
        // the top-centre of the terminal (or while the menu is open).
        <div ref={toolsRef} className="absolute top-0 left-1/2 -translate-x-1/2 z-20 group/tools">
          <button
            onClick={() => setToolsOpen((v) => !v)}
            title="Terminal tools"
            className={"flex items-center gap-1.5 px-2 py-1 rounded-b-md border border-t-0 text-2xs backdrop-blur-sm transition-all duration-200 " +
              (toolsOpen
                ? "bg-bg-elevated border-accent/40 text-fg opacity-100 translate-y-0"
                : "bg-bg/60 border-border text-fg-muted opacity-25 -translate-y-1 hover:opacity-100 group-hover/tools:opacity-100 group-hover/tools:translate-y-0")}
          >
            <LayoutGrid className="size-3.5 shrink-0" />
            <span className={"overflow-hidden whitespace-nowrap transition-all duration-200 " +
              (toolsOpen ? "max-w-[80px]" : "max-w-0 group-hover/tools:max-w-[80px]")}>Tools</span>
            {saveHistory && <span className="size-1.5 rounded-full bg-emerald-400 shrink-0" title="Saving command history" />}
          </button>

          {toolsOpen && (
            <>
              <div className="absolute top-full left-1/2 -translate-x-1/2 mt-0.5 z-20 w-52 rounded-md border border-border bg-bg shadow-xl backdrop-blur-sm py-1 text-xs">
                {canHistory && (
                  <>
                    <ToolItem icon={saveHistory ? <Check className="size-3.5 text-emerald-400" /> : <History className="size-3.5" />}
                      label={saveHistory ? "Saving history — stop" : "Save command history"}
                      onClick={() => { setSaveHistory(!saveHistory); }} keepOpen />
                    <ToolItem icon={<History className="size-3.5" />} label="View history"
                      onClick={() => { setShowHistory(true); setToolsOpen(false); }} />
                  </>
                )}
                <ToolItem icon={<StickyNote className="size-3.5" />} label="Notes"
                  onClick={() => { setShowNotes(true); setToolsOpen(false); }} />
                {canAi && (
                  <ToolItem icon={<Bot className="size-3.5" />} label="Ask AI"
                    onClick={() => { setAiQuestion(null); setAiProvider(null); setShowAi(true); setToolsOpen(false); }} />
                )}
                <ToolItem icon={<ClipboardPaste className="size-3.5" />} label="Paste…"
                  onClick={() => { clipRef.current?.openPasteReview(); setToolsOpen(false); }} />
                <ToolItem icon={isFullscreen ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
                  label={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
                  onClick={() => { toggleFullscreen(); setToolsOpen(false); }} />

                {paneActions && (
                  <>
                    <div className="my-1 border-t border-border" />
                    <ToolItem icon={<SplitSquareHorizontal className="size-3.5" />} label="Split left / right"
                      onClick={() => { paneActions.onSplitH(); setToolsOpen(false); }} />
                    <ToolItem icon={<SplitSquareVertical className="size-3.5" />} label="Split top / bottom"
                      onClick={() => { paneActions.onSplitV(); setToolsOpen(false); }} />
                    {paneActions.isSplit && (
                      <ToolItem icon={paneActions.isMaximized ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
                        label={paneActions.isMaximized ? "Restore pane" : "Maximize pane"}
                        onClick={() => { paneActions.onMaximize(); setToolsOpen(false); }} />
                    )}
                    <ToolItem icon={<ExternalLink className="size-3.5" />} label="Open host in new tab"
                      onClick={() => { paneActions.onNewTab(); setToolsOpen(false); }} />
                    <ToolItem icon={<X className="size-3.5" />} danger label={paneActions.isSplit ? "Close pane" : "Close terminal"}
                      onClick={() => { paneActions.onClose(); setToolsOpen(false); }} />
                  </>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {showHistory && (
        <CommandHistoryPanel
          hostId={tab.hostId}
          hostLabel={tab.label}
          onClose={() => setShowHistory(false)}
          onPick={(cmd) => { insertCommand(cmd); setShowHistory(false); }}
        />
      )}

      {showNotes && (
        <NotesPanel hostId={tab.hostId} hostLabel={tab.label} onClose={() => setShowNotes(false)} />
      )}

      {showAi && (
        <AiAssistPanel
          key={`${aiQuestion ?? "manual"}|${aiProvider ?? ""}`}
          hostLabel={tab.label}
          initialInput={aiQuestion ?? undefined}
          initialProvider={aiProvider ?? undefined}
          autoSuggest={aiQuestion != null}
          onInsert={(cmd) => { insertCommand(cmd); setShowAi(false); setAiQuestion(null); setAiProvider(null); }}
          onClose={() => { setShowAi(false); setAiQuestion(null); setAiProvider(null); }}
        />
      )}

      {phase === "connecting" && (
        <div className="absolute inset-0 z-30 grid place-items-center bg-bg/60 backdrop-blur-sm">
          <div className="flex items-center gap-2 text-sm text-fg-muted">
            <Loader2 className="size-4 animate-spin" /> Connecting to {tab.label}…
          </div>
        </div>
      )}

      {phase === "need_password" && (
        <div className="absolute inset-0 z-30 grid place-items-center bg-bg/80 backdrop-blur-sm">
          <form onSubmit={submitPassword} className="card p-6 w-full max-w-sm m-4">
            <div className="flex items-center gap-2 mb-4">
              <Lock className="size-4 text-accent" />
              <h2 className="text-base font-semibold">SSH password</h2>
            </div>
            <p className="text-xs text-fg-muted mb-4">
              No stored credential for <span className="font-mono">{tab.label}</span>. Enter a password to connect.
            </p>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              autoFocus
              className="input font-mono w-full"
            />
            <button type="submit" disabled={!password} className="btn-primary w-full mt-3">
              Connect
            </button>
          </form>
        </div>
      )}

      {phase === "error" && (
        <div className="absolute inset-0 z-30 grid place-items-center bg-bg/80 backdrop-blur-sm">
          <div className="card p-6 w-full max-w-sm m-4 text-center">
            <AlertCircle className="size-6 text-red-400 mx-auto mb-2" />
            <div className="text-sm font-medium mb-1">Connection failed</div>
            <p className="text-xs text-fg-muted mb-4 break-words">{error}</p>
            <button onClick={() => void reconnect()} className="btn-primary text-xs inline-flex gap-1">
              <Power className="size-3.5" /> Retry
            </button>
          </div>
        </div>
      )}
      </div>

      {/* Live server status bar below the terminal (CPU/RAM/disk/load/net/uptime
          + how long you've been connected). Only while a session is live. */}
      {phase === "connected" && (
        <TerminalStatusBar stats={stats} connectedAt={connectedAt} fallbackName={tab.label} username={username} />
      )}
    </div>
  );
}
