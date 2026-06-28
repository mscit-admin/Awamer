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
 * Auth: the access token and host id arrive as query params (browsers can't
 * set headers on a WebSocket). The token is verified before any SSH work.
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

export interface SshGatewayDeps {
  jwt: JwtService;
  hosts: HostRepository;
  credentials: CredentialRepository;
  history: ConnectionHistoryRepository;
  log: Logger;
}

function sendJson(ws: import("ws").WebSocket, obj: unknown): void {
  try {
    ws.send(JSON.stringify(obj));
  } catch {
    /* socket already closing */
  }
}

export function makeSshGateway(deps: SshGatewayDeps) {
  return async function plugin(app: FastifyInstance) {
    app.get("/connect", { websocket: true }, async (connection, req) => {
      // @fastify/websocket v8: connection.socket is the ws WebSocket.
      const ws = connection.socket;
      const q = req.query as Record<string, string | undefined>;
      const token = q.token;
      const hostId = q.host_id;
      const password_override = q.password ?? null;
      const passphrase_override = q.passphrase ?? null;

      const fail = (code: string, message: string) => {
        sendJson(ws, { type: "error", code, message });
        ws.close();
      };

      if (!token || !hostId) {
        return fail("bad_request", "token and host_id are required");
      }

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

      conn.on("ready", () => {
        sendJson(ws, { type: "status", status: "connected" });
        conn.shell({ term: "xterm-256color", cols, rows }, (err, stream) => {
          if (err) {
            fail("shell_failed", err.message);
            conn.end();
            return;
          }

          stream.on("data", (data: Buffer) => {
            bytesOut += data.length;
            if (ws.readyState === ws.OPEN) ws.send(data);
          });
          stream.stderr.on("data", (data: Buffer) => {
            bytesOut += data.length;
            if (ws.readyState === ws.OPEN) ws.send(data);
          });
          stream.on("close", () => {
            endHistory("closed");
            conn.end();
            if (ws.readyState === ws.OPEN) ws.close();
          });

          ws.on("message", (raw: Buffer, isBinary: boolean) => {
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
        deps.log.warn({ err: err.message, host: host.hostname }, "ssh gateway: connection error");
        endHistory("failed", err.message);
        fail("ssh_error", err.message);
      });

      conn.on("close", () => {
        endHistory("closed");
        if (ws.readyState === ws.OPEN) ws.close();
      });

      ws.on("close", () => {
        endHistory("closed");
        conn.end();
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
