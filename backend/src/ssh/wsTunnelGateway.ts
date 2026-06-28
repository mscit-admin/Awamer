/**
 * Per-user WebSocket TCP tunnel (browser-native forwarding).
 *
 * A JWT-authenticated WebSocket relays a raw TCP stream to (dst_host, dst_port)
 * reached *through* an SSH host the user owns/shares — the browser-native
 * counterpart to the server-managed `ssh -L` tunnels. Unlike those, the socket
 * is authenticated per user (the token is verified before any SSH work), so it
 * never exposes an unauthenticated listening port.
 *
 * Wire protocol (after the WS handshake):
 *   client → server: binary frames → bytes written to the TCP target
 *   server → client: binary frames → bytes read from the TCP target
 *                    text  frames (JSON) → {type:"status"|"error",...}
 */
import { Client } from "ssh2";
import type { FastifyInstance } from "fastify";
import type { JwtService } from "../jwt/index.js";
import { can } from "../domain/permissions.js";
import type { Logger } from "../logger/index.js";
import type { HostRepository, CredentialRepository } from "../repos/sessionRepos.js";
import { resolveSshConnection, SshResolveError } from "./resolveAuth.js";

export interface WsTunnelDeps {
  jwt: JwtService;
  hosts: HostRepository;
  credentials: CredentialRepository;
  log: Logger;
}

const DST_HOST_RE = /^[a-zA-Z0-9._-]+$/;

function sendJson(ws: import("ws").WebSocket, obj: unknown): void {
  try { ws.send(JSON.stringify(obj)); } catch { /* closing */ }
}

export function makeWsTunnelGateway(deps: WsTunnelDeps) {
  return async function plugin(app: FastifyInstance) {
    app.get("/connect", { websocket: true }, async (connection, req) => {
      const ws = connection.socket;
      const q = req.query as Record<string, string | undefined>;
      const token = q.token;
      const hostId = q.host_id;
      const dstHost = q.dst_host;
      const dstPort = Number(q.dst_port);

      const fail = (code: string, message: string) => {
        sendJson(ws, { type: "error", code, message });
        ws.close();
      };

      if (!token || !hostId || !dstHost || !Number.isInteger(dstPort) || dstPort < 1 || dstPort > 65535) {
        return fail("bad_request", "token, host_id, dst_host and a valid dst_port are required");
      }
      if (!DST_HOST_RE.test(dstHost)) {
        return fail("bad_request", "invalid destination host");
      }

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

      let resolved;
      try {
        resolved = await resolveSshConnection(deps, userId, hostId);
      } catch (e) {
        if (e instanceof SshResolveError) return fail(e.code, e.message);
        return fail("credential_error", "could not resolve credentials");
      }
      const { host, username, auth } = resolved;

      const conn = new Client();
      conn.on("ready", () => {
        conn.forwardOut("127.0.0.1", 0, dstHost, dstPort, (err, stream) => {
          if (err) {
            fail("forward_failed", err.message);
            conn.end();
            return;
          }
          sendJson(ws, { type: "status", status: "connected" });

          stream.on("data", (b: Buffer) => { if (ws.readyState === ws.OPEN) ws.send(b); });
          stream.on("close", () => { conn.end(); if (ws.readyState === ws.OPEN) ws.close(); });
          stream.on("error", () => { if (ws.readyState === ws.OPEN) ws.close(); });

          ws.on("message", (raw: Buffer) => { stream.write(raw); });
        });
      });

      conn.on("error", (err) => {
        deps.log.warn({ err: err.message, host: host.hostname }, "ws tunnel: connection error");
        fail("ssh_error", err.message);
      });
      conn.on("close", () => { if (ws.readyState === ws.OPEN) ws.close(); });
      ws.on("close", () => { conn.end(); });

      sendJson(ws, { type: "status", status: "connecting" });
      conn.connect({
        host: host.hostname,
        port: host.port,
        username,
        readyTimeout: 20_000,
        hostVerifier: () => true, // TOFU (consistent with the SSH gateway)
        ...auth,
      });
    });
  };
}
