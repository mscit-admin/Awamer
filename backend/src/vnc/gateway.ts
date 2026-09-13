/**
 * Browser VNC gateway (Phase 6 — remote desktop).
 *
 * The browser can't open a raw TCP socket to a VNC server, so this WebSocket
 * endpoint is a transparent byte relay (websockify-style): it forwards bytes
 * between the browser's noVNC client and the target VNC server's TCP port.
 * The RFB protocol itself (including VNC auth) runs end-to-end between noVNC
 * and the server — the gateway just shuttles bytes.
 *
 * Auth to *Awamer* (token + host) is checked before the relay starts; the
 * VNC password is handled by noVNC on the client.
 */
import net from "node:net";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { JwtService } from "../jwt/index.js";
import { can } from "../domain/permissions.js";
import { makeAuthMiddleware, assertAuthState } from "../middleware/auth.js";
import { v4 as uuid } from "uuid";
import type { Logger } from "../logger/index.js";
import type { HostRepository, ConnectionHistoryRepository } from "../repos/sessionRepos.js";
import { VncTicketStore } from "./ticketStore.js";

export interface VncGatewayDeps {
  jwt: JwtService;
  users: import("../repos/userRepo.js").UserRepository;
  sessions: import("../session/activeSessions.js").ActiveSessionManager;
  hosts: HostRepository;
  history: ConnectionHistoryRepository;
  log: Logger;
}

export function makeVncGateway(deps: VncGatewayDeps) {
  const tickets = new VncTicketStore();
  return async function plugin(app: FastifyInstance) {
    // SEC-018: mint a short-lived single-use ticket (Authorization-header
    // authenticated). The browser then opens the WS with ?ticket=… — no JWT in
    // the URL. Access to the host is verified here, before any ticket is issued.
    const ticketSchema = z.object({ host_id: z.string().min(1) });
    app.post("/ticket", { preHandler: makeAuthMiddleware(deps.jwt, deps.users) }, async (req, reply) => {
      const parsed = ticketSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: { code: "validation_failed", message: "host_id required" } });
      if (!can(req.auth!.role, "sessions:connect")) return reply.code(403).send({ error: { code: "forbidden", message: "your role cannot open sessions" } });
      try {
        await deps.hosts.getById(req.auth!.sub, parsed.data.host_id); // ownership/sharing + tenant check
      } catch {
        return reply.code(404).send({ error: { code: "host_not_found", message: "host not found" } });
      }
      const ticket = tickets.issue({ userId: req.auth!.sub, hostId: parsed.data.host_id });
      return reply.send({ ticket });
    });

    app.get("/connect", { websocket: true }, async (connection, req) => {
      const ws = connection;
      const q = req.query as Record<string, string | undefined>;

      const closeWs = (code: number, reason: string) => {
        try { ws.close(code, reason); } catch { /* already closing */ }
      };

      // SEC-018: authenticate with a one-time ticket, not a URL JWT.
      const claimed = q.ticket ? tickets.consume(q.ticket) : null;
      if (!claimed) return closeWs(4401, "invalid or expired ticket");
      const userId = claimed.userId;
      const hostId = claimed.hostId;

      // AWM-SEC-021: a ticket is minted only after a live auth-state check, but
      // re-validate at redemption so a user disabled/locked/deleted between issue
      // and connect cannot ride an outstanding ticket into a session.
      try {
        await assertAuthState(deps.users, userId);
      } catch {
        return closeWs(4401, "session no longer valid");
      }

      // Resolve the host (honors ownership + sharing).
      let host: Awaited<ReturnType<HostRepository["getById"]>>;
      try {
        host = await deps.hosts.getById(userId, hostId);
      } catch {
        return closeWs(4404, "host not found");
      }

      // Connect to the target VNC server and relay bytes both ways.
      let historyId: number | null = null;
      let bytesIn = 0;
      let bytesOut = 0;

      const sock = net.connect({ host: host.hostname, port: host.port });
      sock.setTimeout(20_000);

      // AWM-SEC-022: track this session so a later disable/lock/delete/role change
      // for the user terminates it. Idempotent close of BOTH the WS and the
      // upstream VNC socket; unregistered when the WS finally closes.
      const sessionId = uuid();
      let revoked = false;
      const closeSession = () => {
        if (revoked) return; revoked = true;
        try { sock.destroy(); } catch { /* ignore */ }
        try { if (ws.readyState === ws.OPEN) ws.close(4403, "authorization revoked"); else ws.terminate(); } catch { /* ignore */ }
      };
      deps.sessions.register({ sessionId, userId, kind: "vnc", requiredPermission: "sessions:connect", close: closeSession });

      const endHistory = (status: "closed" | "failed", errorMessage?: string) => {
        if (historyId == null) return;
        const id = historyId; historyId = null;
        void deps.history.end(id, status, { errorMessage: errorMessage ?? null, bytesIn, bytesOut }).catch(() => {});
      };

      sock.on("connect", () => {
        sock.setTimeout(0);
        void deps.history
          .start({
            userId, hostId: host.id, hostNameSnapshot: host.name,
            hostnameSnapshot: host.hostname, portSnapshot: host.port, protocol: "vnc",
          })
          .then((id) => { historyId = id; })
          .catch(() => {});
      });

      sock.on("data", (d: Buffer) => {
        bytesOut += d.length;
        if (ws.readyState === ws.OPEN) ws.send(d);
      });
      sock.on("timeout", () => { sock.destroy(); closeWs(4504, "connect timed out"); });
      sock.on("error", (e: NodeJS.ErrnoException) => {
        deps.log.warn({ err: e.message, host: host.hostname }, "vnc gateway: tcp error");
        endHistory("failed", e.message);
        closeWs(4502, e.code === "ECONNREFUSED" ? "connection refused" : "vnc connection error");
      });
      sock.on("close", () => { endHistory("closed"); closeWs(1000, "closed"); });

      ws.on("message", (raw: Buffer) => {
        bytesIn += raw.length;
        sock.write(raw);
      });
      ws.on("close", () => { deps.sessions.unregister(sessionId); endHistory("closed"); sock.destroy(); });
      ws.on("error", () => { deps.sessions.unregister(sessionId); sock.destroy(); });
    });
  };
}
