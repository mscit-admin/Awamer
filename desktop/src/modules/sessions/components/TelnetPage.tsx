/**
 * Browser Telnet terminal.
 *
 * Opens a WebSocket to the backend Telnet gateway (/api/v1/telnet/connect),
 * which relays bytes to a raw TCP connection and handles Telnet option
 * negotiation. xterm.js renders the session; the login happens in-stream.
 */
import { useEffect, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { AlertCircle, Loader2, Power, ArrowLeft } from "lucide-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

import { useAuthStore } from "@/modules/auth/store/authStore";
import { hostsApi } from "../api/sessionsApi";
import { useTerminalUi } from "../store/terminalUiStore";

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "";

function gatewayUrl(hostId: string): string {
  // SEC-018: no token in the URL — sent as the first WS frame after open.
  const base = API_BASE_URL || window.location.origin;
  const u = new URL(base);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = u.pathname.replace(/\/$/, "") + "/api/v1/telnet/connect";
  u.searchParams.set("host_id", hostId);
  return u.toString();
}

export function TelnetPage() {
  const params = useParams<{ id: string }>();
  const navigate = useNavigate();
  const accessToken = useAuthStore((s) => s.accessToken);
  const username = useAuthStore((s) => s.user?.username ?? null);
  const bottomGapPx = useTerminalUi((s) => s.bottomGapPx);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const [hostName, setHostName] = useState("");
  const [phase, setPhase] = useState<"connecting" | "connected" | "error">("connecting");
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (params.id) hostsApi.get(params.id).then((h) => setHostName(h.name)).catch(() => {});
  }, [params.id]);

  useEffect(() => {
    const t = setTimeout(() => window.dispatchEvent(new Event("resize")), 50);
    return () => clearTimeout(t);
  }, [bottomGapPx]);

  // Mount xterm once.
  useEffect(() => {
    if (!containerRef.current || termRef.current) return;
    const term = new Terminal({
      fontSize: 13,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      cursorBlink: true,
      allowTransparency: true,
      theme: { background: "rgba(0,0,0,0)" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    try { fit.fit(); } catch { /* not visible yet */ }
    termRef.current = term;
    fitRef.current = fit;
    const onResize = () => { try { fit.fit(); } catch { /* ignore */ } };
    window.addEventListener("resize", onResize);
    return () => { window.removeEventListener("resize", onResize); term.dispose(); termRef.current = null; };
  }, []);

  // (Re)connect.
  useEffect(() => {
    const term = termRef.current;
    if (!term || !accessToken || !params.id) return;
    try { fitRef.current?.fit(); } catch { /* ignore */ }
    setPhase("connecting");
    setError(null);

    const ws = new WebSocket(gatewayUrl(params.id));
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    // SEC-018: authenticate over the channel — token in the first frame.
    ws.onopen = () => {
      if (wsRef.current === ws) ws.send(JSON.stringify({ type: "auth", token: accessToken }));
    };

    const dataDisp = term.onData((d) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(new TextEncoder().encode(d));
    });

    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === "status" && msg.status === "connected") setPhase("connected");
          else if (msg.type === "error") { setPhase("error"); setError(msg.message || "connection failed"); }
        } catch { /* ignore */ }
        return;
      }
      term.write(new Uint8Array(ev.data as ArrayBuffer));
    };
    ws.onclose = () => {
      dataDisp.dispose();
      setPhase((p) => (p === "connected" ? "error" : p));
      if (phase === "connected") term.writeln("\r\n\x1b[31m*** disconnected ***\x1b[0m");
    };
    ws.onerror = () => { setPhase("error"); setError((e) => e ?? "WebSocket error — check the server is reachable"); };

    return () => { dataDisp.dispose(); try { ws.close(); } catch { /* ignore */ } };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken, params.id, attempt]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-bg-elevated/40">
        <button onClick={() => navigate(-1)} className="btn-ghost text-xs"><ArrowLeft className="size-3.5" /></button>
        <div className="text-xs font-mono text-fg-muted truncate">telnet · {hostName || "host"}</div>
      </div>
      <div className="relative flex-1 min-h-0 bg-[#0b0e14]">
        {username && (
          <div className="absolute inset-0 z-0 grid place-items-center pointer-events-none select-none overflow-hidden">
            <div className="font-mono font-bold uppercase tracking-widest text-white/[0.05] text-[12vw] -rotate-12 whitespace-nowrap">{username}</div>
          </div>
        )}
        <div ref={containerRef} className="absolute inset-0 z-10 px-2 pt-2" style={{ paddingBottom: bottomGapPx }} />

        {phase === "connecting" && (
          <div className="absolute inset-0 grid place-items-center bg-bg/60 backdrop-blur-sm z-20">
            <div className="flex items-center gap-2 text-sm text-fg-muted"><Loader2 className="size-4 animate-spin" /> Connecting to {hostName || "host"}…</div>
          </div>
        )}
        {phase === "error" && (
          <div className="absolute inset-0 grid place-items-center bg-bg/80 backdrop-blur-sm z-20">
            <div className="card p-6 w-full max-w-sm m-4 text-center">
              <AlertCircle className="size-6 text-red-400 mx-auto mb-2" />
              <div className="text-sm font-medium mb-1">Connection failed</div>
              <p className="text-xs text-fg-muted mb-4 break-words">{error}</p>
              <button onClick={() => setAttempt((n) => n + 1)} className="btn-ghost text-xs inline-flex gap-1"><Power className="size-3.5" /> Retry</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
