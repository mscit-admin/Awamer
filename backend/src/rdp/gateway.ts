/**
 * Browser/desktop RDP gateway (remote desktop over Apache Guacamole).
 *
 * A browser cannot speak RDP, so this WebSocket endpoint bridges the Guacamole
 * client (guacamole-common-js) to **guacd**, Guacamole's proxy daemon, which
 * speaks RDP to the target host.
 *
 *   1. `POST /ticket` (Authorization header): live auth state, `sessions:connect`
 *      and host access (ownership / sharing / tenant) are checked, then a
 *      short-lived single-use ticket is minted. guacamole-common-js puts its
 *      connect data in the WS URL, so a ticket — never the JWT — goes there
 *      (SEC-018, same as VNC).
 *   2. `GET /connect?ticket=…&width=…&height=…&dpi=…` (WebSocket): the ticket is
 *      redeemed, auth state is re-checked, the destination policy resolves the
 *      host (SEC-REMOTE-DEST-001) and guacd is told to connect to that resolved
 *      IP. The handshake (select → args → size/audio/video/image → connect) is
 *      done here with the host's credential, which never reaches the client.
 *   3. After the handshake the guacd instruction stream is relayed both ways.
 *      Client data is not forwarded until then, so a client cannot inject its
 *      own `connect`. Tunnel-internal instructions (the client's keep-alive
 *      pings) are answered by the gateway and never forwarded.
 *
 * Host RDP options are allow-listed (rdpHostOptions): no RD Gateway, drive
 * redirection or recording paths. Sessions register for active revocation
 * (AWM-SEC-022).
 */
import net from "node:net";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { JwtService } from "../jwt/index.js";
import { can } from "../domain/permissions.js";
import { makeAuthMiddleware, assertAuthState } from "../middleware/auth.js";
import { resolveRemoteDestination } from "../usecases/remoteDestination.js";
import type { Logger } from "../logger/index.js";
import type { HostRepository, ConnectionHistoryRepository, CredentialRepository } from "../repos/sessionRepos.js";
import { VncTicketStore } from "../vnc/ticketStore.js";
import {
  encodeInstruction, parseInstruction, buildConnectInstruction, rdpParamMap, rdpHostOptions,
  type RdpConnectionSettings,
} from "./guacamole.js";

export interface RdpGatewayDeps {
  jwt: JwtService;
  users: import("../repos/userRepo.js").UserRepository;
  sessions: import("../session/activeSessions.js").ActiveSessionManager;
  hosts: HostRepository;
  credentials: CredentialRepository;
  history: ConnectionHistoryRepository;
  guacd: { host: string; port: number };
  log: Logger;
}

const HANDSHAKE_TIMEOUT_MS = 15_000;
/** Bytes guacd may send before its `args` reply. */
const MAX_HANDSHAKE_BUFFER = 64 * 1024;
/** Largest single client WebSocket message forwarded to guacd. */
const MAX_CLIENT_MESSAGE = 4 * 1024 * 1024;

export function clampDim(v: string | undefined, def: number, min: number, max: number): number {
  const n = Number(v);
  if (v === undefined || v === "" || !Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** Username, password and domain of the host's credential (password credentials only). */
async function loadRdpCredential(deps: RdpGatewayDeps, host: Awaited<ReturnType<HostRepository["getById"]>>) {
  const out = { username: null as string | null, password: null as string | null, domain: null as string | null };
  if (!host.credentialId) return out;
  // Shared hosts use the OWNER's credential, as the SSH gateway does.
  const cred = await deps.credentials.getById(host.userId, host.credentialId);
  out.username = cred.username || null;
  const secret = cred.secretData ?? {};
  if (typeof secret["password"] === "string") out.password = secret["password"] as string;
  if (typeof secret["domain"] === "string") out.domain = secret["domain"] as string;
  const domField = cred.fields?.find((f) => f.label.toLowerCase() === "domain");
  if (!out.domain && domField && typeof domField.value === "string") out.domain = domField.value;
  return out;
}

export function makeRdpGateway(deps: RdpGatewayDeps) {
  const tickets = new VncTicketStore();
  return async function plugin(app: FastifyInstance) {
    const ticketSchema = z.object({ host_id: z.string().min(1) });
    app.post("/ticket", { preHandler: makeAuthMiddleware(deps.jwt, deps.users) }, async (req, reply) => {
      const parsed = ticketSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: { code: "validation_failed", message: "host_id required" } });
      if (!can(req.auth!.role, "sessions:connect")) return reply.code(403).send({ error: { code: "forbidden", message: "your role cannot open sessions" } });
      try {
        const host = await deps.hosts.getById(req.auth!.sub, parsed.data.host_id); // ownership/sharing + tenant
        if (host.protocol !== "rdp") return reply.code(400).send({ error: { code: "wrong_protocol", message: "host is not an RDP host" } });
      } catch {
        return reply.code(404).send({ error: { code: "host_not_found", message: "host not found" } });
      }
      return reply.send({ ticket: tickets.issue({ userId: req.auth!.sub, hostId: parsed.data.host_id }) });
    });

    app.get("/connect", { websocket: true }, async (connection, req) => {
      const ws = connection;
      const q = req.query as Record<string, string | undefined>;
      const closeWs = (code: number, reason: string) => {
        try { ws.close(code, reason); } catch { /* already closing */ }
      };

      const claimed = q.ticket ? tickets.consume(q.ticket) : null;
      if (!claimed) return closeWs(4401, "invalid or expired ticket");
      const { userId, hostId } = claimed;

      // AWM-SEC-021: re-check the account at redemption (disabled/locked/role).
      try {
        const live = await assertAuthState(deps.users, userId);
        if (!can(live.role, "sessions:connect")) return closeWs(4403, "forbidden");
      } catch {
        return closeWs(4401, "session no longer valid");
      }

      let host: Awaited<ReturnType<HostRepository["getById"]>>;
      try {
        host = await deps.hosts.getById(userId, hostId);
      } catch {
        return closeWs(4404, "host not found");
      }

      // SEC-REMOTE-DEST-001: guacd connects to the IP resolved here (DNS is
      // resolved once), never to metadata/loopback/link-local addresses.
      let targetIp: string;
      try { targetIp = await resolveRemoteDestination(host.hostname); }
      catch { return closeWs(4403, "destination not allowed"); }

      let cred: Awaited<ReturnType<typeof loadRdpCredential>>;
      try {
        cred = await loadRdpCredential(deps, host);
      } catch (e) {
        deps.log.warn({ err: e instanceof Error ? e.message : String(e) }, "rdp gateway: credential load failed");
        return closeWs(4502, "could not load the host credential");
      }

      const opts = rdpHostOptions(host.options);
      const settings: RdpConnectionSettings = {
        hostname: targetIp,
        port: host.port,
        username: cred.username, password: cred.password, domain: cred.domain,
        security: opts.security,
        ignoreCert: opts.ignoreCert,
        width: clampDim(q.width, 1024, 640, 4096),
        height: clampDim(q.height, 768, 480, 2160),
        dpi: clampDim(q.dpi, 96, 72, 240),
        extra: opts.extra,
      };
      const params = rdpParamMap(settings);

      let historyId: number | null = null;
      let bytesIn = 0;
      let bytesOut = 0;
      let phase: "handshake" | "relay" = "handshake";
      const decoder = new StringDecoder("utf8");
      let inbuf = "";

      const sock = net.connect({ host: deps.guacd.host, port: deps.guacd.port });
      sock.setTimeout(HANDSHAKE_TIMEOUT_MS);

      const sessionId = randomUUID();
      let closed = false;
      const closeSession = () => {
        if (closed) return; closed = true;
        try { sock.destroy(); } catch { /* ignore */ }
        try { if (ws.readyState === ws.OPEN) ws.close(4403, "authorization revoked"); else ws.terminate(); } catch { /* ignore */ }
      };
      deps.sessions.register({ sessionId, userId, kind: "rdp", requiredPermission: "sessions:connect", close: closeSession });

      const endHistory = (status: "closed" | "failed", errorMessage?: string) => {
        if (historyId == null) return;
        const id = historyId; historyId = null;
        void deps.history.end(id, status, { errorMessage: errorMessage ?? null, bytesIn, bytesOut }).catch(() => {});
      };
      const sendToGuacd = (text: string) => { if (!sock.destroyed) sock.write(text); };
      const fail = (code: number, reason: string, logMsg?: string) => {
        if (logMsg) deps.log.warn({ host: host.hostname }, `rdp gateway: ${logMsg}`);
        endHistory("failed", reason);
        sock.destroy();
        closeWs(code, reason);
      };

      // guacamole-common-js expects the tunnel's internal UUID instruction first.
      if (ws.readyState === ws.OPEN) ws.send(encodeInstruction("", randomUUID()));
      sock.on("connect", () => sendToGuacd(encodeInstruction("select", "rdp")));

      const completeHandshake = (argsElements: string[]) => {
        sendToGuacd(encodeInstruction("size", String(settings.width), String(settings.height), String(settings.dpi)));
        sendToGuacd(encodeInstruction("audio", "audio/L16"));
        sendToGuacd(encodeInstruction("video"));
        sendToGuacd(encodeInstruction("image", "image/png", "image/jpeg"));
        sendToGuacd(buildConnectInstruction(argsElements, params));
        phase = "relay";
        sock.setTimeout(0);
        void deps.history
          .start({
            userId, hostId: host.id, hostNameSnapshot: host.name,
            hostnameSnapshot: host.hostname, portSnapshot: host.port, protocol: "rdp",
          })
          .then((id) => { historyId = id; })
          .catch(() => {});
        if (inbuf && ws.readyState === ws.OPEN) ws.send(inbuf);
        inbuf = "";
      };

      sock.on("data", (chunk: Buffer) => {
        bytesOut += chunk.length;
        inbuf += decoder.write(chunk);
        if (phase === "relay") {
          if (inbuf && ws.readyState === ws.OPEN) ws.send(inbuf);
          inbuf = "";
          return;
        }
        if (inbuf.length > MAX_HANDSHAKE_BUFFER) return fail(4502, "rdp protocol error", "oversized handshake");
        try {
          for (;;) {
            const inst = parseInstruction(inbuf);
            if (!inst) break;
            inbuf = inbuf.slice(inst.consumed);
            const opcode = inst.elements[0];
            if (opcode === "args") { completeHandshake(inst.elements); break; }
            if (opcode === "error") return fail(4502, "rdp handshake failed", `guacd error: ${inst.elements[1] ?? "unknown"}`);
            // Any other pre-args instruction is dropped.
          }
        } catch {
          fail(4502, "rdp protocol error", "guacd parse error");
        }
      });

      sock.on("timeout", () => fail(4504, "guacd timed out"));
      sock.on("error", (e: NodeJS.ErrnoException) => {
        deps.log.warn({ err: e.message, guacd: deps.guacd.host }, "rdp gateway: guacd tcp error");
        endHistory("failed", e.message);
        closeWs(4502, e.code === "ECONNREFUSED" ? "guacd unavailable" : "rdp gateway error");
      });
      sock.on("close", () => { endHistory("closed"); closeWs(1000, "closed"); });

      ws.on("message", (raw: Buffer) => {
        if (raw.length > MAX_CLIENT_MESSAGE) return fail(1009, "message too large");
        const text = raw.toString("utf8");
        // Tunnel-internal instructions (empty opcode, e.g. the client's keep-alive
        // ping) are answered here and never reach guacd — as Guacamole's own
        // server does. The client sends one instruction per message.
        if (text.startsWith("0.,")) {
          try {
            const inst = parseInstruction(text);
            if (inst?.elements[1] === "ping" && ws.readyState === ws.OPEN) ws.send(encodeInstruction(...inst.elements));
          } catch { /* malformed internal instruction — ignore */ }
          return;
        }
        if (phase !== "relay") return; // never let the client drive the handshake
        bytesIn += raw.length;
        sendToGuacd(text);
      });
      ws.on("close", () => { deps.sessions.unregister(sessionId); endHistory("closed"); sock.destroy(); });
      ws.on("error", () => { deps.sessions.unregister(sessionId); sock.destroy(); });
    });
  };
}
