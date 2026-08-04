/**
 * Browser VNC gateway (Phase 6 — remote desktop).
 *
 * The browser can't open a raw TCP socket to a VNC server, so this WebSocket
 * endpoint is a transparent byte relay (websockify-style): it forwards bytes
 * between the browser's noVNC client and the target VNC server's TCP port.
 * The RFB protocol itself (including VNC auth) runs end-to-end between noVNC
 * and the server — the gateway just shuttles bytes.
 *
 * Auth to *NetSphere* (token + host) is checked before the relay starts; the
 * VNC password is handled by noVNC on the client.
 */
import net from "node:net";
import type { FastifyInstance } from "fastify";
import type { JwtService } from "../jwt/index.js";
import { can } from "../domain/permissions.js";
import type { Logger } from "../logger/index.js";
import type { HostRepository, ConnectionHistoryRepository } from "../repos/sessionRepos.js";

export interface VncGatewayDeps {
  jwt: JwtService;
  hosts: HostRepository;
  history: ConnectionHistoryRepository;
  log: Logger;
}

export function makeVncGateway(deps: VncGatewayDeps) {
  return async function plugin(app: FastifyInstance) {
    app.get("/connect", { websocket: true }, async (connection, req) => {
      const ws = connection;
      const q = req.query as Record<string, string | undefined>;
      const token = q.token;
      const hostId = q.host_id;

      const closeWs = (code: number, reason: string) => {
        try { ws.close(code, reason); } catch { /* already closing */ }
      };

      if (!token || !hostId) return closeWs(4400, "token and host_id required");

      // Authn + authz.
      let userId: string;
      try {
        const claims = await deps.jwt.verifyAccess(token);
        userId = claims.sub;
        if (!can(claims.role, "sessions:connect")) return closeWs(4403, "forbidden");
      } catch {
        return closeWs(4401, "invalid token");
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
      ws.on("close", () => { endHistory("closed"); sock.destroy(); });
      ws.on("error", () => sock.destroy());
    });
  };
}
