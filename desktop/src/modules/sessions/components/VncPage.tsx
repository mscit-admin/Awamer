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
import { ArrowLeft, Loader2, AlertCircle, Lock, Power, Maximize2, Keyboard } from "lucide-react";
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
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [attempt, setAttempt] = useState(0);

  // Guest-login auto-type panel.
  const [showInject, setShowInject] = useState(false);
  const [osUser, setOsUser] = useState("");
  const [osPass, setOsPass] = useState("");

  // Load host name + (optionally) the stored VNC username/password.
  const prefillRef = useRef<string | undefined>(undefined);
  const prefillUserRef = useRef<string | undefined>(undefined);
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
            if (c.username) prefillUserRef.current = c.username;
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
        credentials: {
          username: username || prefillUserRef.current || undefined,
          password: password || prefillRef.current || "",
        },
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
    const onCredentials = () => {
      // Pre-fill from the stored credential if we have it.
      if (prefillUserRef.current && !username) setUsername(prefillUserRef.current);
      setPhase("need_password");
    };
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

  // ---- Auto-type OS credentials into the remote desktop --------------
  // Sends the username/password as keystrokes to the *guest* login screen,
  // so they're never typed by hand on the remote screen.
  const XK_TAB = 0xff09;
  const XK_RETURN = 0xff0d;
  const XK_SHIFT_L = 0xffe1;
  // Symbols that require Shift on a US keyboard layout.
  const SHIFTED = new Set("~!@#$%^&*()_+{}|:\"<>?".split(""));

  function keysymFor(ch: string): number {
    const cp = ch.codePointAt(0)!;
    // Latin-1 keysyms equal the codepoint; others use the Unicode keysym range.
    return cp < 0x100 ? cp : 0x01000000 + cp;
  }

  /**
   * Type a string into the remote desktop as keystrokes. Shift is held around
   * uppercase letters and shifted symbols so they aren't mistyped, and a small
   * delay between keys avoids the server dropping/merging fast input.
   */
  async function sendString(s: string) {
    const rfb = rfbRef.current;
    if (!rfb) return;
    for (const ch of s) {
      const shift = (ch >= "A" && ch <= "Z") || SHIFTED.has(ch);
      if (shift) rfb.sendKey(XK_SHIFT_L, "ShiftLeft", true);
      const ks = keysymFor(ch);
      rfb.sendKey(ks, "Unidentified", true);
      rfb.sendKey(ks, "Unidentified", false);
      if (shift) rfb.sendKey(XK_SHIFT_L, "ShiftLeft", false);
      await new Promise((r) => setTimeout(r, 15));
    }
  }

  function sendKeysym(keysym: number) {
    const rfb = rfbRef.current;
    if (!rfb) return;
    rfb.sendKey(keysym, "Unidentified", true);
    rfb.sendKey(keysym, "Unidentified", false);
  }

  function submitCredentials(e: FormEvent) {
    e.preventDefault();
    if (!password) return;
    const creds = { username: username || undefined, password };
    // Send the entered credentials to the in-progress RFB session.
    if (rfbRef.current) {
      rfbRef.current.sendCredentials(creds);
      setPhase("connecting");
    } else {
      setAttempt((n) => n + 1);
    }
  }

  return (
    <div className="relative flex flex-col h-full bg-[#0b0e14]">
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border bg-bg-elevated/40">
        <button onClick={() => navigate(-1)} className="btn-ghost text-xs"><ArrowLeft className="size-3.5" /></button>
        <span className="text-sm font-medium">{hostName || "VNC"}</span>
        <span className="text-xs text-fg-muted">remote desktop</span>
        <div className="flex-1" />
        <button
          onClick={() => {
            if (!showInject) { setOsUser(prefillUserRef.current ?? ""); setOsPass(prefillRef.current ?? ""); }
            setShowInject((v) => !v);
          }}
          disabled={phase !== "connected"}
          className="btn-ghost text-xs disabled:opacity-40"
          title="Type login credentials into the remote screen"
        >
          <Keyboard className="size-3.5" /> Send login
        </button>
        <button onClick={() => rfbRef.current?.sendCtrlAltDel()} disabled={phase !== "connected"} className="btn-ghost text-xs disabled:opacity-40">
          Ctrl+Alt+Del
        </button>
        <button onClick={() => screenRef.current?.requestFullscreen?.()} disabled={phase !== "connected"} className="btn-ghost text-xs disabled:opacity-40">
          <Maximize2 className="size-3.5" /> Fullscreen
        </button>
      </div>

      {/* Auto-type panel: inject the guest OS login without typing on screen */}
      {showInject && phase === "connected" && (
        <div className="absolute right-4 top-12 z-20 card p-4 w-72 space-y-3 shadow-xl">
          <div className="flex items-center gap-2">
            <Keyboard className="size-4 text-accent" />
            <span className="text-sm font-medium">Type login into desktop</span>
          </div>
          <p className="text-2xs text-fg-muted leading-relaxed">
            Click the username field on the remote screen first, then use the
            buttons below. Keystrokes are sent to the desktop — nothing is typed
            here on the host terminal.
          </p>
          <div>
            <label className="block text-xs text-fg-muted mb-1">Username</label>
            <input value={osUser} onChange={(e) => setOsUser(e.target.value)} className="input w-full text-sm" autoComplete="off" />
          </div>
          <div>
            <label className="block text-xs text-fg-muted mb-1">Password</label>
            <input type="password" value={osPass} onChange={(e) => setOsPass(e.target.value)} className="input w-full text-sm" autoComplete="off" />
          </div>
          <div className="flex flex-wrap gap-1.5">
            <button onClick={() => void sendString(osUser)} disabled={!osUser} className="btn-ghost text-xs disabled:opacity-40">Type username</button>
            <button onClick={() => void sendString(osPass)} disabled={!osPass} className="btn-ghost text-xs disabled:opacity-40">Type password</button>
            <button
              onClick={async () => { await sendString(osUser); sendKeysym(XK_TAB); await sendString(osPass); sendKeysym(XK_RETURN); }}
              disabled={!osPass}
              className="btn-primary text-xs"
            >
              Username ⇥ Password ⏎
            </button>
            <button onClick={() => sendKeysym(XK_RETURN)} className="btn-ghost text-xs">Enter</button>
          </div>
        </div>
      )}

      <div className="relative flex-1 min-h-0">
        <div ref={screenRef} className="absolute inset-0" />

        {phase === "connecting" && (
          <div className="absolute inset-0 grid place-items-center bg-bg/60">
            <div className="flex items-center gap-2 text-sm text-fg-muted"><Loader2 className="size-4 animate-spin" /> Connecting to {hostName || "host"}…</div>
          </div>
        )}

        {phase === "need_password" && (
          <div className="absolute inset-0 grid place-items-center bg-bg/80">
            <form onSubmit={submitCredentials} className="card p-6 w-full max-w-sm space-y-3">
              <div className="flex items-center gap-2"><Lock className="size-4 text-accent" /><h2 className="text-base font-semibold">VNC sign-in</h2></div>
              <div>
                <label className="block text-xs text-fg-muted mb-1">Username <span className="text-fg-subtle">(optional)</span></label>
                <input
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="Leave blank if not required"
                  autoComplete="username"
                  className="input w-full"
                />
              </div>
              <div>
                <label className="block text-xs text-fg-muted mb-1">Password</label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Password"
                  autoFocus
                  autoComplete="current-password"
                  className="input w-full"
                />
              </div>
              <button type="submit" disabled={!password} className="btn-primary w-full">Connect</button>
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
