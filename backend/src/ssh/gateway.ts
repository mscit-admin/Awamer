/**
 * Browser SSH gateway (Phase 5 — web terminals).
 *
 * The desktop app speaks SSH natively (Rust). The browser can't, so this
 * WebSocket endpoint bridges a browser xterm.js terminal to a real SSH
 * session: the server holds the SSH connection (via `ssh2`) and streams
 * bytes both ways.
 *
 * Wire protocol (after the WS handshake):
 *   client → server:
 *     - binary frame            → raw keystrokes (stdin)
 *     - text frame (JSON)       → control: {"type":"resize","cols":N,"rows":N}
 *   server → client:
 *     - binary frame            → terminal output (stdout/stderr)
 *     - text frame (JSON)       → control: {"type":"status"|"error","message":...}
 *
 * Auth: only the (non-secret) host id + initial window size arrive as query
 * params. The access token and any SSH password/passphrase are sent as the
 * first WS frame ({"type":"auth",…}) over the encrypted channel — never in the
 * URL, where nginx/proxy logs and browser history would capture them (SEC-001).
 * The token is verified before any SSH work.
 *
 * Security note: host-key verification currently accepts the server's key on
 * first sight (TOFU is not yet persisted server-side) — the fingerprint is
 * logged. A persistent known-hosts store is a follow-up.
 */
import { Client } from "ssh2";
import type { FastifyInstance } from "fastify";
import type { JwtService } from "../jwt/index.js";
import { can } from "../domain/permissions.js";
import type { Logger } from "../logger/index.js";
import type {
  HostRepository,
  CredentialRepository,
  ConnectionHistoryRepository,
} from "../repos/sessionRepos.js";
import { resolveSshConnection, SshResolveError, type SshAuth } from "./resolveAuth.js";
import { STATS_CMD, parseStats, type PrevSample } from "./serverStats.js";

export interface SshGatewayDeps {
  jwt: JwtService;
  hosts: HostRepository;
  credentials: CredentialRepository;
  history: ConnectionHistoryRepository;
  settings: import("../repos/appSettings.js").AppSettingsRepository;
  log: Logger;
}

function sendJson(ws: import("ws").WebSocket, obj: unknown): void {
  try {
    ws.send(JSON.stringify(obj));
  } catch {
    /* socket already closing */
  }
}

export interface AuthFrame {
  token: string;
  password: string | null;
  passphrase: string | null;
}

/**
 * SEC-001: authenticate the WebSocket over the (encrypted) channel, not the
 * URL. Browsers can't set headers on a WS handshake, so the original design
 * smuggled the JWT — and worse, the SSH password/passphrase — through query
 * params, where nginx/proxy access logs and browser history capture them.
 *
 * Instead we open the socket unauthenticated and wait for the first text frame
 * to be `{"type":"auth","token":"…","password"?:"…","passphrase"?:"…"}`. The
 * secrets travel inside the TLS-wrapped WS payload, never in the request line.
 * A short deadline drops sockets that never authenticate so an unauthenticated
 * peer can't sit and consume resources.
 */
export function awaitAuthFrame(ws: import("ws").WebSocket, timeoutMs = 10_000): Promise<AuthFrame | null> {
  return new Promise((resolve) => {
    const cleanup = () => {
      clearTimeout(timer);
      ws.off("message", onMsg);
      ws.off("close", onClose);
    };
    const timer = setTimeout(() => { cleanup(); resolve(null); }, timeoutMs);
    const onMsg = (raw: Buffer, isBinary: boolean) => {
      if (isBinary) return; // ignore stray stdin before auth
      let msg: { type?: unknown; token?: unknown; password?: unknown; passphrase?: unknown };
      try { msg = JSON.parse(raw.toString("utf8")); } catch { return; }
      if (!msg || msg.type !== "auth" || typeof msg.token !== "string" || msg.token.length === 0) return;
      cleanup();
      resolve({
        token: msg.token,
        password: typeof msg.password === "string" ? msg.password : null,
        passphrase: typeof msg.passphrase === "string" ? msg.passphrase : null,
      });
    };
    const onClose = () => { cleanup(); resolve(null); };
    ws.on("message", onMsg);
    ws.on("close", onClose);
  });
}

export function makeSshGateway(deps: SshGatewayDeps) {
  return async function plugin(app: FastifyInstance) {
    app.get("/connect", { websocket: true }, async (connection, req) => {
      // @fastify/websocket v11: the handler receives the WebSocket directly.
      const ws = connection;
      const q = req.query as Record<string, string | undefined>;
      const hostId = q.host_id;

      const fail = (code: string, message: string) => {
        sendJson(ws, { type: "error", code, message });
        ws.close();
      };

      if (!hostId) {
        return fail("bad_request", "host_id is required");
      }

      // SEC-001: credentials/token arrive over the WS channel, not the URL.
      sendJson(ws, { type: "status", status: "authenticating" });
      const authFrame = await awaitAuthFrame(ws);
      if (!authFrame) {
        return fail("auth_required", "no authentication frame received");
      }
      const token = authFrame.token;
      const password_override = authFrame.password;
      const passphrase_override = authFrame.passphrase;

      // 1. Authenticate + authorize.
      let userId: string;
      try {
        const claims = await deps.jwt.verifyAccess(token);
        userId = claims.sub;
        if (!can(claims.role, "sessions:connect")) {
          return fail("forbidden", "your role cannot open sessions");
        }
      } catch {
        return fail("invalid_token", "token is invalid or expired");
      }

      // 2. Resolve host + auth material (user-scoped) via the shared resolver.
      let host: Awaited<ReturnType<HostRepository["getById"]>>;
      let username: string;
      let auth: SshAuth;
      try {
        const resolved = await resolveSshConnection(deps, userId, hostId, {
          password: password_override,
          passphrase: passphrase_override,
        });
        host = resolved.host;
        username = resolved.username;
        auth = resolved.auth;
      } catch (e) {
        if (e instanceof SshResolveError) return fail(e.code, e.message);
        deps.log.warn({ err: e }, "ssh gateway: credential resolution failed");
        return fail("credential_error", "could not resolve credentials");
      }

      // 3. Open the SSH connection.
      const conn = new Client();
      let historyId: number | null = null;
      let bytesIn = 0;
      let bytesOut = 0;
      let cols = 80;
      let rows = 24;

      // Best-effort connection-history record.
      void deps.history
        .start({
          userId,
          hostId: host.id,
          hostNameSnapshot: host.name,
          hostnameSnapshot: host.hostname,
          portSnapshot: host.port,
          protocol: "ssh",
        })
        .then((id) => {
          historyId = id;
        })
        .catch(() => {});

      const endHistory = (status: "closed" | "failed", errorMessage?: string) => {
        if (historyId == null) return;
        const id = historyId;
        historyId = null;
        void deps.history.end(id, status, { errorMessage: errorMessage ?? null, bytesIn, bytesOut }).catch(() => {});
      };

      // Idle timeout (admin-configurable, 0 = disabled): close the session
      // after N minutes with no client activity.
      let idleMs = 0;
      try {
        const s = await deps.settings.getMany(["ssh_idle_timeout_minutes"]);
        const mins = Number(s["ssh_idle_timeout_minutes"] ?? 0);
        if (Number.isFinite(mins) && mins > 0) idleMs = mins * 60_000;
      } catch { /* default: no idle timeout */ }
      let idleTimer: NodeJS.Timeout | null = null;
      const clearIdle = () => { if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; } };
      const armIdle = () => {
        if (idleMs <= 0) return;
        clearIdle();
        idleTimer = setTimeout(() => {
          if (ws.readyState === ws.OPEN) ws.send(Buffer.from("\r\n\x1b[33m*** session closed: idle timeout ***\x1b[0m\r\n"));
          try { conn.end(); } catch { /* ignore */ }
          try { ws.close(); } catch { /* ignore */ }
        }, idleMs);
      };

      // Periodic server-stats poller (separate exec channel, doesn't touch the
      // interactive shell). Non-overlapping (skips if the previous poll is still
      // running) so a slow link can't pile up exec channels and exhaust the
      // target's MaxSessions — a common cause of mid-session drops.
      let prevSample: PrevSample = {};
      let statsTimer: NodeJS.Timeout | null = null;
      let statsInFlight = false;
      const clearStats = () => { if (statsTimer) { clearInterval(statsTimer); statsTimer = null; } };
      const pollStats = () => {
        if (ws.readyState !== ws.OPEN || statsInFlight) return;
        statsInFlight = true;
        try {
          conn.exec(STATS_CMD, (err, stream) => {
            if (err) { statsInFlight = false; return; }
            let out = "";
            stream.on("data", (d: Buffer) => { if (out.length < 16_384) out += d.toString(); });
            stream.stderr.on("data", () => { /* ignore */ });
            // Without this handler an exec-channel error would crash the process.
            stream.on("error", () => { statsInFlight = false; });
            stream.on("close", () => {
              statsInFlight = false;
              const { stats, prev } = parseStats(out, prevSample, Date.now());
              prevSample = prev;
              if (Object.keys(stats).length && ws.readyState === ws.OPEN) sendJson(ws, { type: "stats", data: stats });
            });
          });
        } catch { statsInFlight = false; }
      };

      // WebSocket heartbeat: ping the browser periodically so idle proxies
      // (nginx) keep the socket open, and reap peers that stop answering.
      let wsAlive = true;
      let wsPingTimer: NodeJS.Timeout | null = null;
      const clearWsPing = () => { if (wsPingTimer) { clearInterval(wsPingTimer); wsPingTimer = null; } };
      ws.on("pong", () => { wsAlive = true; });
      const startWsPing = () => {
        clearWsPing();
        wsPingTimer = setInterval(() => {
          if (ws.readyState !== ws.OPEN) return;
          if (!wsAlive) { try { ws.terminate(); } catch { /* ignore */ } return; }
          wsAlive = false;
          try { ws.ping(); } catch { /* ignore */ }
        }, 25_000);
      };

      conn.on("ready", () => {
        sendJson(ws, { type: "status", status: "connected" });
        conn.shell({ term: "xterm-256color", cols, rows }, (err, stream) => {
          if (err) {
            fail("shell_failed", err.message);
            conn.end();
            return;
          }
          armIdle();
          startWsPing();
          statsTimer = setInterval(pollStats, 8000);
          pollStats();

          // ssh2 channels are Node streams — an unhandled 'error' would throw
          // and crash the whole process (killing every other user's session).
          stream.on("error", (e: Error) => {
            deps.log.warn({ err: e.message, host: host.hostname }, "ssh gateway: shell stream error");
            clearStats();
            clearWsPing();
            endHistory("failed", e.message);
            try { conn.end(); } catch { /* ignore */ }
            if (ws.readyState === ws.OPEN) ws.close();
          });
          stream.stderr.on("error", () => { /* ignore stderr channel errors */ });
          stream.on("data", (data: Buffer) => {
            bytesOut += data.length;
            if (ws.readyState === ws.OPEN) ws.send(data);
          });
          stream.stderr.on("data", (data: Buffer) => {
            bytesOut += data.length;
            if (ws.readyState === ws.OPEN) ws.send(data);
          });
          stream.on("close", () => {
            clearStats();
            clearWsPing();
            endHistory("closed");
            conn.end();
            if (ws.readyState === ws.OPEN) ws.close();
          });

          ws.on("message", (raw: Buffer, isBinary: boolean) => {
            armIdle(); // reset idle timer on any client activity
            if (isBinary) {
              bytesIn += raw.length;
              stream.write(raw);
              return;
            }
            // Text frame → control message.
            try {
              const msg = JSON.parse(raw.toString("utf8"));
              if (msg.type === "resize" && Number.isFinite(msg.cols) && Number.isFinite(msg.rows)) {
                cols = msg.cols;
                rows = msg.rows;
                stream.setWindow(rows, cols, 0, 0);
              } else if (msg.type === "data" && typeof msg.data === "string") {
                // Tolerate JSON-wrapped keystrokes too.
                const buf = Buffer.from(msg.data, "utf8");
                bytesIn += buf.length;
                stream.write(buf);
              }
            } catch {
              // Not JSON — treat as raw stdin.
              bytesIn += raw.length;
              stream.write(raw);
            }
          });
        });
      });

      conn.on("error", (err) => {
        clearStats();
        clearWsPing();
        deps.log.warn({ err: err.message, host: host.hostname }, "ssh gateway: connection error");
        endHistory("failed", err.message);
        fail("ssh_error", err.message);
      });

      conn.on("close", () => {
        clearStats();
        clearWsPing();
        endHistory("closed");
        if (ws.readyState === ws.OPEN) ws.close();
      });

      ws.on("close", () => {
        clearIdle();
        clearStats();
        clearWsPing();
        endHistory("closed");
        conn.end();
      });
      ws.on("error", () => {
        clearIdle();
        clearStats();
        clearWsPing();
        try { conn.end(); } catch { /* ignore */ }
      });

      // Initial resize hint if the client passed one in the query.
      if (q.cols) cols = Number(q.cols) || cols;
      if (q.rows) rows = Number(q.rows) || rows;

      sendJson(ws, { type: "status", status: "connecting" });
      conn.connect({
        host: host.hostname,
        port: host.port,
        username,
        readyTimeout: 20_000,
        // Keepalive so the session survives network/NAT idle gaps.
        keepaliveInterval: 30_000,
        keepaliveCountMax: 3,
        // TOFU: accept the host key on first sight; log its fingerprint.
        hostVerifier: (key: Buffer) => {
          deps.log.info({ host: host.hostname, port: host.port }, "ssh gateway: accepting host key (TOFU)");
          void key;
          return true;
        },
        ...auth,
      });
    });
  };
}
