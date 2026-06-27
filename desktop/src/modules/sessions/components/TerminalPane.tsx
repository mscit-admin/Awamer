import { useEffect, useRef, useState } from "react";
import { AlertCircle, AlertTriangle, Lock, KeyRound, Loader2, Power } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";

import { useAuthStore } from "@/modules/auth/store/authStore";
import { isTauri, DESKTOP_ONLY_MESSAGE } from "@/shared/lib/tauri";
import { hostsApi, credentialsApi, type Host } from "../api/sessionsApi";
import {
  useTerminalTabs,
  type TerminalTab,
  type HostKeyChangedDetails,
} from "../store/terminalTabsStore";

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "http://localhost:8081";

interface SshEvent {
  type: "data" | "exit" | "closed";
  bytes?: number[];
  code?: number;
  reason?: string;
}

interface AppErrorBody {
  code: string;
  message: string;
}

export function TerminalPane({ tab }: { tab: TerminalTab }) {
  const accessToken = useAuthStore(s => s.accessToken);
  const setSessionEstablished = useTerminalTabs(s => s.setSessionEstablished);
  const setError = useTerminalTabs(s => s.setError);
  const markDisconnected = useTerminalTabs(s => s.markDisconnected);
  const updateTab = useTerminalTabs(s => s.updateTab);

  const [host, setHost] = useState<Host | null>(null);
  const [credentialType, setCredentialType] = useState<string | null>(null);
  const [promptNeeded, setPromptNeeded] = useState<null | "password" | "passphrase">(null);
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const unlistenRef = useRef<UnlistenFn | null>(null);
  const connectedOnce = useRef(false);

  // ---------- 1. Load host metadata to decide auth path -------------
  useEffect(() => {
    if (host) return;
    void (async () => {
      try {
        const h = await hostsApi.get(tab.hostId);
        setHost(h);

        // 1.4.0: if this tab was rehydrated from localStorage (phase is
        // already "disconnected" the moment we mount), wait for the user
        // to click Reconnect rather than firing a connect attempt — that
        // would yield a wall of password prompts every time they open
        // the app, which is hostile.
        if (tab.phase === "disconnected") {
          return;
        }

        // Decide if we can connect straight away or need a prompt.
        if (h.credential_id) {
          try {
            const cred = await credentialsApi.get(h.credential_id);
            setCredentialType(cred.credentialType);
            if (cred.credentialType === "password") {
              // Credential carries the password; connect right away.
              void doConnect({});
            } else if (cred.credentialType === "private_key") {
              // Unencrypted key OR key with stored passphrase → try connecting
              // without a passphrase first. If the Rust side returns
              // `key_passphrase_required`, we'll prompt.
              void doConnect({});
            } else if (cred.credentialType === "agent") {
              // 1.4.0 — ssh-agent: nothing to prompt, just connect.
              void doConnect({});
            } else {
              setError(tab.tabId, "unsupported_credential",
                `credential type "${cred.credentialType}" not supported (use password, private_key, or agent)`);
            }
          } catch (e) {
            setError(tab.tabId, "credential_load_failed",
              e instanceof Error ? e.message : "Failed to load credential");
          }
        } else {
          // No credential — must prompt for password.
          setPromptNeeded("password");
          updateTab(tab.tabId, { phase: "connecting" });
        }
      } catch (e) {
        setError(tab.tabId, "host_load_failed",
          e instanceof Error ? e.message : "Failed to load host");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.tabId]);

  // ---------- 2. Mount xterm once we reach "connected" --------------
  useEffect(() => {
    if (tab.phase !== "connected") return;
    if (connectedOnce.current) return;
    if (!containerRef.current) return;
    connectedOnce.current = true;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: '"JetBrains Mono", "SF Mono", Menlo, Consolas, monospace',
      fontSize: 13,
      theme: {
        background: "#0b0f17", foreground: "#e7ecf3",
        cursor: "#3ddc97", cursorAccent: "#0b0f17",
        selectionBackground: "#3ddc9740",
      },
      scrollback: 5000,
      convertEol: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(containerRef.current);
    fit.fit();

    termRef.current = term;
    fitRef.current = fit;

    term.onData((data) => {
      const sid = useTerminalTabs.getState().tabs.find(t => t.tabId === tab.tabId)?.sessionId;
      if (!sid) return;
      const bytes = Array.from(new TextEncoder().encode(data));
      void invoke("ssh_write", { sessionId: sid, data: bytes }).catch(console.error);
    });

    term.onResize(({ cols, rows }) => {
      const sid = useTerminalTabs.getState().tabs.find(t => t.tabId === tab.tabId)?.sessionId;
      if (!sid) return;
      void invoke("ssh_resize", { sessionId: sid, cols, rows }).catch(console.error);
    });

    const onResize = () => fit.fit();
    window.addEventListener("resize", onResize);

    return () => {
      window.removeEventListener("resize", onResize);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.phase]);

  // ---------- 3. Subscribe to events for this session ---------------
  useEffect(() => {
    if (!tab.sessionId) return;
    let cancelled = false;
    void (async () => {
      const unlisten = await listen<SshEvent>(`ssh:event:${tab.sessionId}`, (evt) => {
        if (cancelled) return;
        const p = evt.payload;
        if (p.type === "data" && p.bytes && termRef.current) {
          termRef.current.write(new Uint8Array(p.bytes));
        } else if (p.type === "exit") {
          termRef.current?.writeln(`\r\n\x1b[33m[exit ${p.code ?? 0}]\x1b[0m`);
        } else if (p.type === "closed") {
          termRef.current?.writeln(`\r\n\x1b[33m[disconnected: ${p.reason ?? "session ended"}]\x1b[0m`);
          markDisconnected(tab.tabId);
        }
      });
      unlistenRef.current = unlisten;
    })();
    return () => {
      cancelled = true;
      unlistenRef.current?.();
      unlistenRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.sessionId]);

  // ---------- 4. Connect ---------------------------------------------
  async function doConnect(opts: { password?: string; passphrase?: string }) {
    if (!accessToken) return;
    if (!isTauri) {
      updateTab(tab.tabId, { phase: "error", errorMessage: DESKTOP_ONLY_MESSAGE, errorCode: "desktop_only" });
      return;
    }
    setBusy(true);
    updateTab(tab.tabId, { phase: "connecting", errorMessage: null, errorCode: null });
    try {
      const result = await invoke<{ session_id: string; history_id: number | null }>("ssh_connect", {
        args: {
          api_base_url: API_BASE_URL,
          access_token: accessToken,
          host_id: tab.hostId,
          password_override: opts.password ?? null,
          passphrase: opts.passphrase ?? null,
          cols: 80, rows: 24,
        },
      });
      setSessionEstablished(tab.tabId, result.session_id);
      setSecret("");
      setPromptNeeded(null);
    } catch (e) {
      const err = parseAppError(e);
      if (err.code === "key_passphrase_required" || err.code === "key_invalid_passphrase") {
        setPromptNeeded("passphrase");
        updateTab(tab.tabId, { phase: "connecting", errorMessage: err.message, errorCode: err.code });
      } else if (err.code === "host_key_changed") {
        // The message JSON-encodes the structured details
        let details: HostKeyChangedDetails | null = null;
        try {
          details = JSON.parse(err.message);
        } catch { /* fall through to plain error */ }
        if (details) {
          setError(tab.tabId, err.code, "host key changed since last connection", details);
        } else {
          setError(tab.tabId, err.code, err.message);
        }
      } else if (err.code === "no_credential" && !opts.password) {
        // Host has no credential at all → prompt for password
        setPromptNeeded("password");
        updateTab(tab.tabId, { phase: "connecting" });
      } else {
        setError(tab.tabId, err.code, err.message);
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleDisconnect() {
    if (!tab.sessionId) return;
    try {
      await invoke("ssh_disconnect", { sessionId: tab.sessionId });
    } catch { /* ignore */ }
    markDisconnected(tab.tabId);
  }

  async function handleForgetKey() {
    if (!tab.hostKeyDetails) return;
    try {
      await invoke("ssh_forget_known_host", {
        host: tab.hostKeyDetails.host,
        port: tab.hostKeyDetails.port,
      });
      updateTab(tab.tabId, {
        phase: "connecting",
        hostKeyDetails: null,
        errorCode: null,
        errorMessage: null,
      });
      // Retry the connect
      void doConnect({});
    } catch (e) {
      const err = parseAppError(e);
      setError(tab.tabId, err.code, err.message);
    }
  }

  // -----------------------------------------------------------------
  // Render branches
  // -----------------------------------------------------------------

  if (tab.phase === "host_key_changed" && tab.hostKeyDetails) {
    return <HostKeyChangedScreen details={tab.hostKeyDetails} onForget={handleForgetKey} busy={busy} />;
  }

  if (tab.phase === "error") {
    return <ErrorScreen code={tab.errorCode} message={tab.errorMessage} onRetry={() => doConnect({})} />;
  }

  if (promptNeeded === "password") {
    return (
      <PasswordPrompt
        kind="password"
        host={host}
        busy={busy}
        value={secret}
        onChange={setSecret}
        onSubmit={() => doConnect({ password: secret })}
      />
    );
  }

  if (promptNeeded === "passphrase") {
    return (
      <PasswordPrompt
        kind="passphrase"
        host={host}
        busy={busy}
        value={secret}
        onChange={setSecret}
        onSubmit={() => doConnect({ passphrase: secret })}
        errorBelow={tab.errorCode === "key_invalid_passphrase" ? "Wrong passphrase — try again" : null}
      />
    );
  }

  // Connecting (no prompt — waiting on ssh_connect)
  if (tab.phase === "connecting") {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-fg-muted h-full">
        <Loader2 className="size-4 animate-spin mr-2" />
        Establishing SSH connection
        {credentialType === "private_key" && " (using key)"}…
      </div>
    );
  }

  // connected | disconnected: render the xterm container.
  // When disconnected, also show a reconnect button (1.4.0).
  return (
    <div className="flex flex-col h-full">
      <header className="px-4 py-2 border-b border-border flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium truncate">
            {host?.name ?? tab.label}{" "}
            <span className="text-fg-muted text-xs font-mono">
              ssh://{host?.hostname}:{host?.port}
            </span>
          </div>
        </div>
        <span className={
          "text-2xs px-1.5 py-0.5 rounded font-mono " +
          (tab.phase === "connected" ? "bg-emerald-500/15 text-emerald-300"
          : "bg-fg-muted/15 text-fg-muted")
        }>
          {tab.phase}
        </span>
        {tab.phase === "connected" && (
          <button onClick={handleDisconnect} className="btn-ghost text-red-400 hover:text-red-300">
            <Power className="size-3.5" /> Disconnect
          </button>
        )}
        {tab.phase === "disconnected" && (
          <button onClick={() => doConnect({})} className="btn-primary text-xs">
            Reconnect
          </button>
        )}
      </header>
      <div className="flex-1 min-h-0 relative">
        {/* xterm always renders here when we've connected at least once */}
        <div ref={containerRef} className="absolute inset-0 p-2" />
        {/* Disconnected overlay when we have no xterm yet (e.g. rehydrated from previous session) */}
        {tab.phase === "disconnected" && !connectedOnce.current && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="text-center pointer-events-auto">
              <Power className="size-8 text-fg-muted mx-auto mb-2" />
              <div className="text-sm text-fg-muted mb-3">
                This session was restored from your last app run.
              </div>
              <button onClick={() => doConnect({})} className="btn-primary">
                Reconnect to {host?.name ?? tab.label}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// =====================================================================
// Subcomponents
// =====================================================================

function PasswordPrompt({
  kind, host, busy, value, onChange, onSubmit, errorBelow,
}: {
  kind: "password" | "passphrase";
  host: Host | null;
  busy: boolean;
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  errorBelow?: string | null;
}) {
  const isPassphrase = kind === "passphrase";
  return (
    <div className="flex items-center justify-center h-full">
      <div className="card p-6 w-full max-w-sm m-4">
        <div className="flex items-center gap-2 mb-4">
          {isPassphrase ? <KeyRound className="size-4 text-accent" /> : <Lock className="size-4 text-accent" />}
          <h2 className="text-base font-semibold">
            {isPassphrase ? "Private key passphrase" : "SSH password"}
          </h2>
        </div>
        <p className="text-xs text-fg-muted mb-4">
          {isPassphrase
            ? <>The private key for <span className="font-mono">{host?.name}</span> is encrypted. Enter the passphrase to unlock it. It is held in memory only.</>
            : <>Enter the password for <span className="font-mono">{host?.name}</span>.</>}
        </p>
        <form onSubmit={(e) => { e.preventDefault(); onSubmit(); }}>
          <input
            type="password"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={isPassphrase ? "Passphrase" : "Password"}
            autoFocus
            className="input font-mono w-full"
          />
          {errorBelow && (
            <div className="text-xs text-red-400 mt-1">{errorBelow}</div>
          )}
          <button
            type="submit"
            disabled={busy || !value}
            className="btn-primary w-full mt-3"
          >
            {busy ? "Connecting…" : "Connect"}
          </button>
        </form>
      </div>
    </div>
  );
}

function ErrorScreen({ code, message, onRetry }: { code: string | null; message: string | null; onRetry: () => void }) {
  return (
    <div className="flex items-center justify-center h-full p-6">
      <div className="card p-6 max-w-md w-full">
        <div className="flex items-center gap-2 text-red-400 mb-2">
          <AlertCircle className="size-4" />
          <h2 className="text-base font-semibold">Connection failed</h2>
        </div>
        {code && <div className="text-2xs font-mono text-fg-muted mb-2">{code}</div>}
        <p className="text-sm text-fg-muted font-mono break-words">{message ?? "Unknown error"}</p>
        <button onClick={onRetry} className="btn-primary mt-4">Try again</button>
      </div>
    </div>
  );
}

function HostKeyChangedScreen({
  details, onForget, busy,
}: {
  details: HostKeyChangedDetails;
  onForget: () => void;
  busy: boolean;
}) {
  return (
    <div className="flex items-center justify-center h-full p-6">
      <div className="card p-6 max-w-lg w-full border-red-500/50 bg-red-500/5">
        <div className="flex items-center gap-2 text-red-400 mb-3">
          <AlertTriangle className="size-5" />
          <h2 className="text-base font-semibold">⚠ Host key changed</h2>
        </div>
        <p className="text-sm text-fg-muted mb-4">
          The server <span className="font-mono">{details.host}:{details.port}</span>{" "}
          presented a different host key than the one NetSphere has on file.
          This <strong className="text-red-400">may indicate a man-in-the-middle attack</strong>{" "}
          — your connection was blocked.
        </p>
        <div className="space-y-2 text-2xs font-mono bg-bg p-3 rounded border border-border mb-4">
          <div>
            <div className="text-fg-muted">Stored fingerprint:</div>
            <div className="break-all">{details.stored_fingerprint}</div>
          </div>
          <div>
            <div className="text-fg-muted">Server now presents:</div>
            <div className="break-all">{details.presented_fingerprint}</div>
          </div>
        </div>
        <p className="text-xs text-fg-muted mb-4">
          Legitimate reasons this can happen: the server was reinstalled,
          you're connecting to a different machine with the same hostname,
          or DNS changed. Verify out-of-band with the server administrator
          before proceeding.
        </p>
        <div className="flex gap-2">
          <button
            onClick={onForget}
            disabled={busy}
            className="btn-primary flex-1 bg-red-500 hover:bg-red-600 border-red-500"
          >
            Forget old key and retry
          </button>
        </div>
      </div>
    </div>
  );
}

// =====================================================================
// Tauri error shape parser
// =====================================================================

function parseAppError(e: unknown): AppErrorBody {
  if (typeof e === "object" && e && "code" in e && "message" in e) {
    return e as AppErrorBody;
  }
  if (typeof e === "string") return { code: "unknown", message: e };
  return { code: "unknown", message: String(e) };
}
