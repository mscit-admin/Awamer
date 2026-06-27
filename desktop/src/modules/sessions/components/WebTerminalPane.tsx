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
import { AlertCircle, Loader2, Lock, Power } from "lucide-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";

import { useAuthStore } from "@/modules/auth/store/authStore";
import { useTerminalTabs, type TerminalTab } from "../store/terminalTabsStore";

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

export function WebTerminalPane({ tab }: { tab: TerminalTab }) {
  const accessToken = useAuthStore((s) => s.accessToken);
  const updateTab = useTerminalTabs((s) => s.updateTab);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const [phase, setPhase] = useState<"connecting" | "connected" | "error" | "need_password">("connecting");
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [attempt, setAttempt] = useState(0); // bump to force reconnect

  // Mount xterm once.
  useEffect(() => {
    if (!containerRef.current || termRef.current) return;
    const term = new Terminal({
      fontSize: 13,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      cursorBlink: true,
      theme: { background: "#0b0e14" },
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

    return () => {
      window.removeEventListener("resize", onResize);
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
    updateTab(tab.tabId, { phase: "connecting", errorMessage: null, errorCode: null });

    const pw = attempt > 0 && password ? password : undefined;
    const ws = new WebSocket(gatewayUrl(accessToken, tab.hostId, cols, rows, pw));
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    const dataDisp = term.onData((d) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(new TextEncoder().encode(d));
    });

    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === "status" && msg.status === "connected") {
            setPhase("connected");
            updateTab(tab.tabId, { phase: "connected" });
            ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
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

  return (
    <div className="relative h-full w-full bg-[#0b0e14]">
      <div ref={containerRef} className="absolute inset-0 p-2" />

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
            <button onClick={() => setAttempt((n) => n + 1)} className="btn-ghost text-xs inline-flex gap-1">
              <Power className="size-3.5" /> Retry
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
