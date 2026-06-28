/**
 * Browser VNC viewer (Phase 6 — remote desktop).
 *
 * Uses noVNC against the backend VNC gateway (a WebSocket↔TCP relay). The RFB
 * protocol (incl. VNC auth) runs end-to-end between noVNC and the target; the
 * gateway only shuttles bytes.
 *
 * The VNC password is taken from the host's linked credential when the user
 * may reveal it; otherwise noVNC prompts for it.
 */
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Loader2, AlertCircle, Lock, Power, Maximize2 } from "lucide-react";
import RFB from "@novnc/novnc";

import { useAuthStore } from "@/modules/auth/store/authStore";
import { hostsApi, credentialsApi } from "../api/sessionsApi";

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "";

function gatewayUrl(token: string, hostId: string): string {
  const base = API_BASE_URL || window.location.origin;
  const u = new URL(base);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = u.pathname.replace(/\/$/, "") + "/api/v1/vnc/connect";
  u.searchParams.set("token", token);
  u.searchParams.set("host_id", hostId);
  return u.toString();
}

export function VncPage() {
  const { id: hostId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const accessToken = useAuthStore((s) => s.accessToken);

  const screenRef = useRef<HTMLDivElement | null>(null);
  const rfbRef = useRef<RFB | null>(null);

  const [hostName, setHostName] = useState("");
  const [phase, setPhase] = useState<"connecting" | "connected" | "error" | "need_password">("connecting");
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [attempt, setAttempt] = useState(0);

  // Load host name + (optionally) the stored VNC password before connecting.
  const prefillRef = useRef<string | undefined>(undefined);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    void (async () => {
      if (!hostId) return;
      try {
        const h = await hostsApi.get(hostId);
        setHostName(h.name);
        if (h.credential_id) {
          try {
            const c = await credentialsApi.get(h.credential_id, true);
            const pw = (c.secret_data as Record<string, unknown> | undefined)?.["password"];
            if (typeof pw === "string") prefillRef.current = pw;
          } catch { /* no reveal permission — will prompt */ }
        }
      } catch { /* ignore */ }
      setReady(true);
    })();
  }, [hostId]);

  // (Re)connect when ready / retry.
  useEffect(() => {
    if (!ready || !screenRef.current || !accessToken || !hostId) return;
    setPhase("connecting");
    setError(null);

    let rfb: RFB;
    try {
      rfb = new RFB(screenRef.current, gatewayUrl(accessToken, hostId), {
        credentials: { password: password || prefillRef.current || "" },
      });
    } catch (e) {
      setPhase("error");
      setError(e instanceof Error ? e.message : "failed to start VNC");
      return;
    }
    rfb.scaleViewport = true;
    rfb.background = "#0b0e14";
    rfbRef.current = rfb;

    const onConnect = () => setPhase("connected");
    const onDisconnect = (e: any) => {
      if (phase === "connected") {
        setPhase("error");
        setError("Disconnected");
      } else {
        setPhase("error");
        setError(e?.detail?.clean === false ? "Could not connect — check the host, port, and that VNC is reachable." : "Disconnected");
      }
    };
    const onCredentials = () => { setPhase("need_password"); };
    const onSecurityFailure = (e: any) => { setPhase("error"); setError(e?.detail?.reason || "VNC authentication failed"); };

    rfb.addEventListener("connect", onConnect);
    rfb.addEventListener("disconnect", onDisconnect);
    rfb.addEventListener("credentialsrequired", onCredentials);
    rfb.addEventListener("securityfailure", onSecurityFailure);

    return () => {
      rfb.removeEventListener("connect", onConnect);
      rfb.removeEventListener("disconnect", onDisconnect);
      rfb.removeEventListener("credentialsrequired", onCredentials);
      rfb.removeEventListener("securityfailure", onSecurityFailure);
      try { rfb.disconnect(); } catch { /* ignore */ }
      rfbRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, accessToken, hostId, attempt]);

  function submitPassword(e: FormEvent) {
    e.preventDefault();
    if (!password) return;
    // Send the entered credentials to the in-progress RFB session.
    if (rfbRef.current) {
      rfbRef.current.sendCredentials({ password });
      setPhase("connecting");
    } else {
      setAttempt((n) => n + 1);
    }
  }

  return (
    <div className="flex flex-col h-full bg-[#0b0e14]">
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border bg-bg-elevated/40">
        <button onClick={() => navigate(-1)} className="btn-ghost text-xs"><ArrowLeft className="size-3.5" /></button>
        <span className="text-sm font-medium">{hostName || "VNC"}</span>
        <span className="text-xs text-fg-muted">remote desktop</span>
        <div className="flex-1" />
        <button onClick={() => rfbRef.current?.sendCtrlAltDel()} disabled={phase !== "connected"} className="btn-ghost text-xs disabled:opacity-40">
          Ctrl+Alt+Del
        </button>
        <button onClick={() => screenRef.current?.requestFullscreen?.()} disabled={phase !== "connected"} className="btn-ghost text-xs disabled:opacity-40">
          <Maximize2 className="size-3.5" /> Fullscreen
        </button>
      </div>

      <div className="relative flex-1 min-h-0">
        <div ref={screenRef} className="absolute inset-0" />

        {phase === "connecting" && (
          <div className="absolute inset-0 grid place-items-center bg-bg/60">
            <div className="flex items-center gap-2 text-sm text-fg-muted"><Loader2 className="size-4 animate-spin" /> Connecting to {hostName || "host"}…</div>
          </div>
        )}

        {phase === "need_password" && (
          <div className="absolute inset-0 grid place-items-center bg-bg/80">
            <form onSubmit={submitPassword} className="card p-6 w-full max-w-sm">
              <div className="flex items-center gap-2 mb-4"><Lock className="size-4 text-accent" /><h2 className="text-base font-semibold">VNC password</h2></div>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" autoFocus className="input w-full" />
              <button type="submit" disabled={!password} className="btn-primary w-full mt-3">Connect</button>
            </form>
          </div>
        )}

        {phase === "error" && (
          <div className="absolute inset-0 grid place-items-center bg-bg/80">
            <div className="card p-6 w-full max-w-sm text-center">
              <AlertCircle className="size-6 text-red-400 mx-auto mb-2" />
              <div className="text-sm font-medium mb-1">VNC error</div>
              <p className="text-xs text-fg-muted mb-4 break-words">{error}</p>
              <button onClick={() => { setPassword(""); prefillRef.current = undefined; setAttempt((n) => n + 1); }} className="btn-ghost text-xs inline-flex gap-1">
                <Power className="size-3.5" /> Retry
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
