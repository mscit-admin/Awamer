/**
 * RDP — remote desktop via the guacd gateway (Phase 6).
 *
 * A browser/webview can't speak RDP, so this renders an Apache Guacamole client
 * (guacamole-common-js) whose WebSocket tunnel points at the backend
 * `/api/v1/rdp/connect` gateway. The backend bridges to `guacd`, which speaks
 * RDP to the host. Credentials are resolved server-side from the host's
 * attached credential — nothing sensitive is sent from here.
 *
 * SEC-018: guacamole-common-js puts its connect data in the WebSocket URL, so
 * the page first mints a one-time ticket over the authenticated REST API and
 * puts only that ticket in the URL — never the access token.
 *
 * Requires `sessions:connect`.
 */
import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import Guacamole from "guacamole-common-js";
import { Loader2, AlertCircle, ArrowLeft, Maximize2, RefreshCw, Keyboard as KeyIcon } from "lucide-react";
import { useAuthStore } from "@/modules/auth/store/authStore";
import { request } from "@/shared/lib/api";
import { hostsApi } from "../api/sessionsApi";

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "";

/** Base WebSocket URL for the RDP gateway (no query — the tunnel appends it). */
function tunnelUrl(): string {
  const base = API_BASE_URL || window.location.origin;
  const u = new URL(base);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = u.pathname.replace(/\/$/, "") + "/api/v1/rdp/connect";
  return u.toString();
}

type Phase = "connecting" | "connected" | "error" | "closed";

export function RdpPage() {
  const { id: hostId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const accessToken = useAuthStore((s) => s.accessToken);

  const screenRef = useRef<HTMLDivElement | null>(null);
  const clientRef = useRef<Guacamole.Client | null>(null);
  const keyboardRef = useRef<Guacamole.Keyboard | null>(null);

  const [hostName, setHostName] = useState("");
  const [phase, setPhase] = useState<Phase>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!hostId || !accessToken) return;
    let disposed = false;

    hostsApi.get(hostId).then((h) => { if (!disposed) setHostName(h.name); }).catch(() => {});

    const container = screenRef.current;
    if (!container) return;
    // Ask for a display sized to the viewport (clamped by the gateway).
    const width = Math.max(640, Math.floor(container.clientWidth || window.innerWidth));
    const height = Math.max(480, Math.floor(container.clientHeight || window.innerHeight));
    const dpi = Math.round((window.devicePixelRatio || 1) * 96);

    setPhase("connecting");
    setError(null);

    const tunnel = new Guacamole.WebSocketTunnel(tunnelUrl());
    const client = new Guacamole.Client(tunnel);
    clientRef.current = client;

    const displayEl = client.getDisplay().getElement();
    container.appendChild(displayEl);
    displayEl.tabIndex = 0;

    // Mouse → server.
    const mouse = new Guacamole.Mouse(displayEl);
    mouse.on("mousedown", (e) => client.sendMouseState(e.state, true));
    mouse.on("mouseup", (e) => client.sendMouseState(e.state, true));
    mouse.on("mousemove", (e) => client.sendMouseState(e.state, true));

    // Keyboard → server (scoped to the document while mounted).
    const keyboard = new Guacamole.Keyboard(document);
    keyboard.onkeydown = (keysym) => client.sendKeyEvent(1, keysym);
    keyboard.onkeyup = (keysym) => client.sendKeyEvent(0, keysym);
    keyboardRef.current = keyboard;

    client.onstatechange = (state) => {
      if (disposed) return;
      if (state === Guacamole.Client.State.CONNECTED) setPhase("connected");
      else if (state === Guacamole.Client.State.DISCONNECTED) setPhase((p) => (p === "error" ? p : "closed"));
    };
    client.onerror = (status) => {
      if (disposed) return;
      setPhase("error");
      setError(status?.message || "RDP connection error");
      try { client.disconnect(); } catch { /* ignore */ }
    };
    tunnel.onerror = (status) => {
      if (disposed) return;
      setPhase("error");
      setError(status?.message || "Gateway connection failed");
    };

    void (async () => {
      let ticket: string;
      try {
        ticket = (await request<{ ticket: string }>("/api/v1/rdp/ticket", { method: "POST", body: { host_id: hostId } })).ticket;
      } catch (e) {
        if (!disposed) { setPhase("error"); setError(e instanceof Error ? e.message : "could not authorize the RDP session"); }
        return;
      }
      if (disposed) return;
      try {
        client.connect(`ticket=${encodeURIComponent(ticket)}&width=${width}&height=${height}&dpi=${dpi}`);
      } catch (e) {
        setPhase("error");
        setError(e instanceof Error ? e.message : "failed to start RDP");
      }
    })();

    return () => {
      disposed = true;
      try { keyboard.onkeydown = null; keyboard.onkeyup = null; keyboard.reset(); } catch { /* ignore */ }
      try { client.disconnect(); } catch { /* ignore */ }
      if (displayEl.parentNode === container) container.removeChild(displayEl);
      clientRef.current = null;
      keyboardRef.current = null;
    };
  }, [hostId, accessToken, attempt]);

  const goFullscreen = () => {
    const el = screenRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen?.();
  };

  return (
    <div className="h-full flex flex-col bg-black">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-2 bg-bg-elevated border-b border-border shrink-0">
        <button onClick={() => navigate(`/hosts/${hostId}`)} className="btn-ghost text-xs" title="Back">
          <ArrowLeft className="size-4" />
        </button>
        <span className="text-sm font-medium truncate">{hostName || "RDP session"}</span>
        <StateBadge phase={phase} />
        <div className="flex-1" />
        <button onClick={() => setAttempt((a) => a + 1)} className="btn-ghost text-xs" title="Reconnect">
          <RefreshCw className="size-3.5" />
        </button>
        <button onClick={goFullscreen} className="btn-ghost text-xs" title="Fullscreen">
          <Maximize2 className="size-3.5" />
        </button>
      </div>

      {/* Display surface */}
      <div className="relative flex-1 overflow-auto grid place-items-center">
        {/* `isolate`: Guacamole draws its layers at z-index -1; without its own
            stacking context the remote screen would sit behind the page background. */}
        <div ref={screenRef} className="relative isolate w-full h-full grid place-items-center [&>div]:mx-auto" />
        {phase === "connecting" && (
          <div className="absolute inset-0 grid place-items-center text-fg-muted pointer-events-none">
            <div className="flex items-center gap-2 text-sm"><Loader2 className="size-4 animate-spin" /> Connecting to {hostName || "host"}…</div>
          </div>
        )}
        {phase === "error" && (
          <div className="absolute inset-0 grid place-items-center p-6">
            <div className="max-w-md text-center space-y-3">
              <AlertCircle className="size-8 text-red-400 mx-auto" />
              <div className="text-sm text-red-300">{error || "Connection failed"}</div>
              <p className="text-2xs text-fg-muted flex items-start gap-1.5 text-left">
                <KeyIcon className="size-3.5 mt-0.5 shrink-0" />
                Check that the RDP gateway (guacd) is running and can reach the host on its RDP port, the host has an attached credential (username/password), and the host allows Remote Desktop.
              </p>
              <button onClick={() => setAttempt((a) => a + 1)} className="btn-primary text-xs">Retry</button>
            </div>
          </div>
        )}
        {phase === "closed" && (
          <div className="absolute inset-0 grid place-items-center p-6">
            <div className="text-center space-y-3">
              <div className="text-sm text-fg-muted">Session ended.</div>
              <button onClick={() => setAttempt((a) => a + 1)} className="btn-primary text-xs">Reconnect</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function StateBadge({ phase }: { phase: Phase }) {
  const map: Record<Phase, string> = {
    connecting: "text-amber-300 border-amber-500/40 bg-amber-500/10",
    connected: "text-emerald-300 border-emerald-500/40 bg-emerald-500/10",
    error: "text-red-300 border-red-500/40 bg-red-500/10",
    closed: "text-fg-muted border-border",
  };
  return <span className={"text-2xs px-1.5 py-0.5 rounded border " + map[phase]}>{phase}</span>;
}
