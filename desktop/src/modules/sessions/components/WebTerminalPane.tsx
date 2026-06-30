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
import { useEffect, useRef, useState, type FormEvent } from "react";
import { AlertCircle, Loader2, Lock, Power, History, Check, StickyNote } from "lucide-react";
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
import { NotesPanel } from "@/modules/notes/NotesPanel";
import { useCan } from "@/shared/lib/permissions";

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "";

function gatewayUrl(token: string, hostId: string, cols: number, rows: number, password?: string): string {
  // Resolve an absolute ws(s):// URL from the configured API base (or the
  // current origin when the API is served same-origin).
  const base = API_BASE_URL || window.location.origin;
  const u = new URL(base);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = (u.pathname.replace(/\/$/, "")) + "/api/v1/ssh/connect";
  u.searchParams.set("token", token);
  u.searchParams.set("host_id", hostId);
  u.searchParams.set("cols", String(cols));
  u.searchParams.set("rows", String(rows));
  if (password) u.searchParams.set("password", password);
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

function TerminalStatusBar({ stats, connectedAt, fallbackName }: { stats: ServerStats | null; connectedAt: number | null; fallbackName: string }) {
  const [, force] = useState(0);
  useEffect(() => { const id = setInterval(() => force((n) => n + 1), 1000); return () => clearInterval(id); }, []);
  const elapsed = connectedAt ? Math.max(0, Math.round((Date.now() - connectedAt) / 1000)) : 0;
  const Metric = ({ label, value, cls }: { label: string; value: string; cls?: string }) => (
    <span className="inline-flex items-baseline gap-1 whitespace-nowrap">
      <span className="text-slate-500 uppercase text-[9px] tracking-wider">{label}</span>
      <span className={"font-mono " + (cls ?? "text-slate-100")}>{value}</span>
    </span>
  );
  return (
    <div className="shrink-0 flex items-center gap-3 px-3 py-1 border-t border-white/10 bg-[#0b0e14] text-2xs text-slate-200 overflow-x-auto">
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
      <Metric label="SESSION" value={fmtDur(elapsed)} cls="text-sky-300" />
    </div>
  );
}

export function WebTerminalPane({ tab }: { tab: TerminalTab }) {
  const accessToken = useAuthStore((s) => s.accessToken);
  const refreshTokens = useAuthStore((s) => s.refreshTokens);
  const username = useAuthStore((s) => s.user?.username ?? null);
  const updateTab = useTerminalTabs((s) => s.updateTab);
  const saveHistory = useCommandHistoryPref((s) => s.saveHistory);
  const setSaveHistory = useCommandHistoryPref((s) => s.setSaveHistory);
  const canHistory = useCan("command_history:read");
  const bottomGapPx = useTerminalUi((s) => s.bottomGapPx);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  // Command-history capture. We reconstruct each typed line from the user's
  // keystrokes (xterm.onData) and POST it on Enter — but only when the user
  // has opted in. Read the flag through a ref so the keystroke handler always
  // sees the latest value without re-subscribing the WebSocket.
  const lineBufRef = useRef("");
  const saveHistoryRef = useRef(saveHistory && canHistory);
  useEffect(() => { saveHistoryRef.current = saveHistory && canHistory; }, [saveHistory, canHistory]);

  // Refit the terminal when the bottom gap changes.
  useEffect(() => {
    const t = setTimeout(() => window.dispatchEvent(new Event("resize")), 50);
    return () => clearTimeout(t);
  }, [bottomGapPx]);

  const [showHistory, setShowHistory] = useState(false);
  const [showNotes, setShowNotes] = useState(false);

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
      theme: { background: "rgba(0,0,0,0)" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(containerRef.current);
    try { fit.fit(); } catch { /* not visible yet */ }
    termRef.current = term;
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
      window.removeEventListener("resize", onResize);
      ro.disconnect();
      cancelAnimationFrame(raf);
      term.dispose();
      termRef.current = null;
    };
  }, []);

  // (Re)connect when token / attempt changes.
  useEffect(() => {
    const term = termRef.current;
    if (!term || !accessToken) return;

    try { fitRef.current?.fit(); } catch { /* ignore */ }
    const cols = term.cols || 80;
    const rows = term.rows || 24;

    setPhase("connecting");
    setError(null);
    setStats(null);
    setConnectedAt(null);
    updateTab(tab.tabId, { phase: "connecting", errorMessage: null, errorCode: null });

    const pw = attempt > 0 && password ? password : undefined;
    const ws = new WebSocket(gatewayUrl(accessToken, tab.hostId, cols, rows, pw));
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    const dataDisp = term.onData((d) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(new TextEncoder().encode(d));
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
      if (typeof ev.data === "string") {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === "status" && msg.status === "connected") {
            setPhase("connected");
            setConnectedAt((t) => t ?? Date.now());
            updateTab(tab.tabId, { phase: "connected" });
            ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
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

    ws.onclose = () => {
      dataDisp.dispose();
      setPhase((p) => (p === "connected" ? "error" : p));
      if (phase === "connected") {
        term.writeln("\r\n\x1b[31m*** disconnected ***\x1b[0m");
        updateTab(tab.tabId, { phase: "disconnected" });
      }
    };
    ws.onerror = () => {
      setPhase("error");
      setError((e) => e ?? "WebSocket error — check the server is reachable");
    };

    return () => {
      dataDisp.dispose();
      try { ws.close(); } catch { /* ignore */ }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken, tab.hostId, attempt]);

  function submitPassword(e: FormEvent) {
    e.preventDefault();
    if (!password) return;
    setAttempt((n) => n + 1);
  }

  // Retry: refresh the access token first (the WS uses it directly and doesn't
  // get the auto-refresh that REST calls do, so a long session's token may have
  // expired), then force a fresh reconnect.
  async function reconnect() {
    setPhase("connecting");
    setError(null);
    try { await refreshTokens(); } catch { /* reconnect with the current token */ }
    setAttempt((n) => n + 1);
  }

  function insertCommand(command: string) {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(new TextEncoder().encode(command));
      lineBufRef.current = saveHistoryRef.current ? command : "";
    }
    termRef.current?.focus();
  }

  return (
    <div className="flex flex-col h-full w-full bg-[#0b0e14]">
      {/* Terminal area — fills the space above the status bar. The user-adjustable
          bottom gap cushions the prompt from the status bar / OS taskbar; the
          status bar itself stays flush at the window bottom (no dead band). */}
      <div className="relative flex-1 min-h-0" style={{ paddingBottom: bottomGapPx }}>
      {/* Faint username watermark behind the terminal so you can tell whose session this is. */}
      {username && (
        <div className="absolute inset-0 z-0 grid place-items-center pointer-events-none select-none overflow-hidden">
          <div className="text-center -rotate-12">
            <div className="font-mono font-bold uppercase tracking-widest text-white/[0.05] leading-none whitespace-nowrap text-[12vw]">
              {username}
            </div>
            <div className="font-mono text-white/[0.06] mt-2 text-[2.2vw]">{tab.label}</div>
          </div>
        </div>
      )}
      <div ref={containerRef} className="absolute inset-0 z-10 px-2 pt-2 pb-2" />

      {(phase === "connected" || phase === "error") && (
        <div className="absolute top-2 right-2 z-10 flex items-center gap-1.5">
          {canHistory && (
            <>
              <button
                onClick={() => setSaveHistory(!saveHistory)}
                title={saveHistory ? "Saving command history — click to stop" : "Save command history (off)"}
                className={
                  "flex items-center gap-1.5 px-2 py-1 rounded text-2xs border backdrop-blur-sm transition-colors " +
                  (saveHistory
                    ? "bg-emerald-500/15 border-emerald-500/40 text-emerald-300"
                    : "bg-bg/70 border-border text-fg-muted hover:bg-bg-elevated")
                }
              >
                {saveHistory ? <Check className="size-3.5" /> : <History className="size-3.5" />}
                {saveHistory ? "Saving history" : "Save history"}
              </button>
              <button
                onClick={() => setShowHistory(true)}
                title="View command history"
                className="flex items-center gap-1.5 px-2 py-1 rounded text-2xs border bg-bg/70 border-border text-fg-muted hover:bg-bg-elevated backdrop-blur-sm"
              >
                <History className="size-3.5" /> History
              </button>
            </>
          )}
          <button
            onClick={() => setShowNotes(true)}
            title="Notes for this host"
            className="flex items-center gap-1.5 px-2 py-1 rounded text-2xs border bg-bg/70 border-border text-fg-muted hover:bg-bg-elevated backdrop-blur-sm"
          >
            <StickyNote className="size-3.5" /> Notes
          </button>
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

      {phase === "connecting" && (
        <div className="absolute inset-0 grid place-items-center bg-bg/60 backdrop-blur-sm">
          <div className="flex items-center gap-2 text-sm text-fg-muted">
            <Loader2 className="size-4 animate-spin" /> Connecting to {tab.label}…
          </div>
        </div>
      )}

      {phase === "need_password" && (
        <div className="absolute inset-0 grid place-items-center bg-bg/80 backdrop-blur-sm">
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
        <div className="absolute inset-0 grid place-items-center bg-bg/80 backdrop-blur-sm">
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
        <TerminalStatusBar stats={stats} connectedAt={connectedAt} fallbackName={tab.label} />
      )}
    </div>
  );
}
