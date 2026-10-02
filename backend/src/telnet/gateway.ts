/**
 * Browser Telnet gateway.
 *
 * Like the SSH gateway but for plain Telnet: a WebSocket endpoint relays bytes
 * between a browser xterm.js terminal and a raw TCP connection to the target.
 * Telnet option negotiation (IAC sequences) is handled here so the terminal
 * only ever sees clean application data; the interactive login happens inside
 * the stream as usual.
 *
 *   client → server: binary = keystrokes; text JSON = {type:"resize",...} (ignored — telnet has no window-size channel by default)
 *   server → client: binary = output; text JSON = {type:"status"|"error",...}
 */
import net from "node:net";
import { resolveRemoteDestination, RemoteDestinationDenied } from "../usecases/remoteDestination.js";
import type { FastifyInstance } from "fastify";
import type { JwtService } from "../jwt/index.js";
import { can } from "../domain/permissions.js";
import { verifyCurrentAccessToken } from "../middleware/auth.js";
import { v4 as uuid } from "uuid";
import type { Logger } from "../logger/index.js";
import type { HostRepository, ConnectionHistoryRepository } from "../repos/sessionRepos.js";
import { awaitAuthFrame } from "../ssh/gateway.js";

export interface TelnetGatewayDeps {
  jwt: JwtService;
  users: import("../repos/userRepo.js").UserRepository;
  sessions: import("../session/activeSessions.js").ActiveSessionManager;
  hosts: HostRepository;
  history: ConnectionHistoryRepository;
  log: Logger;
}

// Telnet protocol bytes.
const IAC = 255, DONT = 254, DO = 253, WONT = 252, WILL = 251, SB = 250, SE = 240;
const OPT_ECHO = 1, OPT_SGA = 3;

/**
 * Stateful filter that strips Telnet IAC negotiation from the server stream and
 * produces the appropriate replies. Accepting ECHO/SGA puts us in the common
 * "server echoes" interactive mode; everything else is refused.
 */
export class TelnetNegotiator {
  private state: "data" | "iac" | "opt" | "sb" | "sb_iac" = "data";
  private cmd = 0;

  process(chunk: Buffer): { data: Buffer; reply: Buffer } {
    const out: number[] = [];
    const reply: number[] = [];
    for (const b of chunk) {
      switch (this.state) {
        case "data":
          if (b === IAC) this.state = "iac";
          else out.push(b);
          break;
        case "iac":
          if (b === IAC) { out.push(IAC); this.state = "data"; }       // escaped 0xFF
          else if (b === DO || b === DONT || b === WILL || b === WONT) { this.cmd = b; this.state = "opt"; }
          else if (b === SB) this.state = "sb";
          else this.state = "data";                                    // standalone command, ignore
          break;
        case "opt":
          if (this.cmd === WILL) {
            // Server offers an option.
            if (b === OPT_ECHO || b === OPT_SGA) reply.push(IAC, DO, b);
            else reply.push(IAC, DONT, b);
          } else if (this.cmd === DO) {
            // Server asks us to enable an option.
            if (b === OPT_SGA) reply.push(IAC, WILL, b);
            else reply.push(IAC, WONT, b);
          }
          // WONT/DONT need no response.
          this.state = "data";
          break;
        case "sb":
          if (b === IAC) this.state = "sb_iac";                        // possible end of subnegotiation
          break;
        case "sb_iac":
          this.state = b === SE ? "data" : "sb";
          break;
      }
    }
    return { data: Buffer.from(out), reply: Buffer.from(reply) };
  }
}

function sendJson(ws: import("ws").WebSocket, obj: unknown): void {
  try { ws.send(JSON.stringify(obj)); } catch { /* closing */ }
}

export function makeTelnetGateway(deps: TelnetGatewayDeps) {
  return async function plugin(app: FastifyInstance) {
    app.get("/connect", { websocket: true }, async (connection, req) => {
      const ws = connection;
      const q = req.query as Record<string, string | undefined>;
      const hostId = q.host_id;

      const fail = (code: string, message: string) => {
        sendJson(ws, { type: "error", code, message });
        try { ws.close(); } catch { /* ignore */ }
      };

      if (!hostId) return fail("bad_request", "host_id is required");

      // SEC-018: token arrives over the channel (first frame), never the URL.
      sendJson(ws, { type: "status", status: "authenticating" });
      const authFrame = await awaitAuthFrame(ws);
      if (!authFrame) return fail("auth_required", "no authentication frame received");
      const token = authFrame.token;

      let userId: string;
      try {
        // SEC-SESSION-002: verify token + live account state + auth_version, so a
        // stale token from before a password/MFA change cannot open a new session.
        const { claims, live } = await verifyCurrentAccessToken(deps.jwt, deps.users, token);
        userId = claims.sub;
        if (!can(live.role, "sessions:connect")) return fail("forbidden", "your role cannot open sessions");
      } catch {
        return fail("invalid_token", "token is invalid or expired");
      }

      let host: Awaited<ReturnType<HostRepository["getById"]>>;
      try {
        host = await deps.hosts.getById(userId, hostId);
      } catch {
        return fail("host_not_found", "host not found");
      }

      // SEC-REMOTE-DEST-001: raw TCP relay — never to metadata/loopback/etc.
      let targetIp: string;
      try { targetIp = await resolveRemoteDestination(host.hostname); }
      catch (e) {
        if (e instanceof RemoteDestinationDenied) return fail("destination_denied", e.message);
        return fail("destination_denied", "destination could not be resolved");
      }

      const negotiator = new TelnetNegotiator();
      let historyId: number | null = null;
      let bytesIn = 0;
      let bytesOut = 0;

      const endHistory = (status: "closed" | "failed", errorMessage?: string) => {
        if (historyId == null) return;
        const id = historyId; historyId = null;
        void deps.history.end(id, status, { errorMessage: errorMessage ?? null, bytesIn, bytesOut }).catch(() => {});
      };

      sendJson(ws, { type: "status", status: "connecting" });
      const sock = net.connect({ host: targetIp, port: host.port });
      sock.setTimeout(20_000);

      // AWM-SEC-022: register for active revocation (disable/lock/delete/role
      // change terminate this live Telnet session). Idempotent close of WS + TCP.
      const sessionId = uuid();
      let revoked = false;
      const closeSession = () => {
        if (revoked) return; revoked = true;
        try { sock.destroy(); } catch { /* ignore */ }
        try { if (ws.readyState === ws.OPEN) ws.close(4403, "authorization revoked"); else ws.terminate(); } catch { /* ignore */ }
      };
      deps.sessions.register({ sessionId, userId, kind: "telnet", requiredPermission: "sessions:connect", close: closeSession });

      sock.on("connect", () => {
        sock.setTimeout(0);
        sendJson(ws, { type: "status", status: "connected" });
        void deps.history
          .start({
            userId, hostId: host.id, hostNameSnapshot: host.name,
            hostnameSnapshot: host.hostname, portSnapshot: host.port, protocol: "telnet",
          })
          .then((id) => { historyId = id; })
          .catch(() => {});
      });

      sock.on("data", (d: Buffer) => {
        const { data, reply } = negotiator.process(d);
        if (reply.length) sock.write(reply);
        if (data.length && ws.readyState === ws.OPEN) { bytesOut += data.length; ws.send(data); }
      });
      sock.on("timeout", () => { sock.destroy(); fail("timeout", "connection timed out"); });
      sock.on("error", (e: NodeJS.ErrnoException) => {
        deps.log.warn({ err: e.message, host: host.hostname }, "telnet gateway: tcp error");
        endHistory("failed", e.message);
        fail("telnet_error", e.code === "ECONNREFUSED" ? "connection refused" : "telnet connection error");
      });
      sock.on("close", () => { endHistory("closed"); if (ws.readyState === ws.OPEN) ws.close(); });

      ws.on("message", (raw: Buffer, isBinary: boolean) => {
        if (!isBinary) return; // ignore control JSON (resize etc.)
        bytesIn += raw.length;
        sock.write(raw);
      });
      ws.on("close", () => { deps.sessions.unregister(sessionId); endHistory("closed"); sock.destroy(); });
      ws.on("error", () => { deps.sessions.unregister(sessionId); sock.destroy(); });
    });
  };
}
