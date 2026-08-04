/**
 * Browser/desktop RDP gateway (Phase 6 — remote desktop).
 *
 * RDP can't be a transparent byte relay the way VNC/Telnet are — a browser
 * can't speak RDP. Instead this WebSocket endpoint bridges the Guacamole client
 * (guacamole-common-js, in the web app / desktop webview) to **guacd**, Apache
 * Guacamole's proxy daemon, which speaks RDP to the target host.
 *
 * Flow:
 *   1. Authenticate to NetSphere (token + host_id) and resolve the host.
 *   2. Pull the host's credential server-side (username/password/domain) — the
 *      browser never sees it.
 *   3. Open a TCP connection to guacd and perform the Guacamole handshake
 *      (select → args → size/audio/video/image → connect), injecting the RDP
 *      connection parameters.
 *   4. Relay the guacd instruction stream ↔ the browser as UTF-8 text frames.
 *
 * Gated by `sessions:connect` (same as VNC/SSH/Telnet).
 */
import net from "node:net";
import { StringDecoder } from "node:string_decoder";
import type { FastifyInstance } from "fastify";
import type { JwtService } from "../jwt/index.js";
import { can } from "../domain/permissions.js";
import type { Logger } from "../logger/index.js";
import type { HostRepository, ConnectionHistoryRepository, CredentialRepository } from "../repos/sessionRepos.js";
import {
  encodeInstruction, parseInstruction, buildConnectInstruction, rdpParamMap,
  type RdpConnectionSettings,
} from "./guacamole.js";

export interface RdpGatewayDeps {
  jwt: JwtService;
  hosts: HostRepository;
  credentials: CredentialRepository;
  history: ConnectionHistoryRepository;
  guacd: { host: string; port: number };
  log: Logger;
}

const HANDSHAKE_TIMEOUT_MS = 15_000;

function clampDim(v: string | undefined, def: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** Extract RDP-specific overrides a user may have stored on the host. */
function rdpOptions(options: Record<string, unknown>): { security?: string; ignoreCert?: boolean; extra?: Record<string, string> } {
  const raw = (options?.rdp && typeof options.rdp === "object") ? (options.rdp as Record<string, unknown>) : {};
  const extra: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (["security", "ignore_cert", "ignoreCert"].includes(k)) continue;
    if (v == null) continue;
    extra[k] = typeof v === "boolean" ? String(v) : String(v);
  }
  const security = typeof raw.security === "string" ? raw.security : undefined;
  const ignoreCert = typeof raw.ignore_cert === "boolean" ? raw.ignore_cert
    : typeof raw.ignoreCert === "boolean" ? raw.ignoreCert : undefined;
  return { security, ignoreCert, extra: Object.keys(extra).length ? extra : undefined };
}

export function makeRdpGateway(deps: RdpGatewayDeps) {
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

      // Pull the credential server-side (never sent to the client).
      let username: string | null = null;
      let password: string | null = null;
      let domain: string | null = null;
      if (host.credentialId) {
        try {
          const cred = await deps.credentials.getById(host.userId, host.credentialId);
          username = cred.username;
          const secret = cred.secretData ?? {};
          if (typeof secret["password"] === "string") password = secret["password"] as string;
          if (typeof secret["domain"] === "string") domain = secret["domain"] as string;
          // A "domain" custom field is also honored.
          const domField = cred.fields?.find((f) => f.label.toLowerCase() === "domain");
          if (!domain && domField && typeof domField.value === "string") domain = domField.value;
        } catch (e) {
          deps.log.warn({ err: e instanceof Error ? e.message : String(e) }, "rdp gateway: credential load failed");
        }
      }

      const opts = rdpOptions(host.options ?? {});
      const settings: RdpConnectionSettings = {
        hostname: host.hostname,
        port: host.port,
        username, password, domain,
        security: opts.security,
        ignoreCert: opts.ignoreCert,
        width: clampDim(q.width, 1024, 640, 4096),
        height: clampDim(q.height, 768, 480, 2160),
        dpi: clampDim(q.dpi, 96, 72, 240),
        extra: opts.extra,
      };
      const params = rdpParamMap(settings);

      // ---- connect to guacd + handshake -----------------------------
      let historyId: number | null = null;
      let bytesIn = 0;
      let bytesOut = 0;
      let phase: "handshake" | "relay" = "handshake";
      const decoder = new StringDecoder("utf8");
      let inbuf = "";

      const sock = net.connect({ host: deps.guacd.host, port: deps.guacd.port });
      sock.setTimeout(HANDSHAKE_TIMEOUT_MS);

      const endHistory = (status: "closed" | "failed", errorMessage?: string) => {
        if (historyId == null) return;
        const id = historyId; historyId = null;
        void deps.history.end(id, status, { errorMessage: errorMessage ?? null, bytesIn, bytesOut }).catch(() => {});
      };

      const sendToGuacd = (text: string) => { if (!sock.destroyed) sock.write(text); };

      sock.on("connect", () => {
        // Begin the handshake: select the rdp protocol.
        sendToGuacd(encodeInstruction("select", "rdp"));
      });

      const completeHandshake = (argsElements: string[]) => {
        // Advertise our display size + supported stream mimetypes, then connect.
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
        // Forward anything already buffered past the args instruction.
        if (inbuf && ws.readyState === ws.OPEN) { ws.send(inbuf); inbuf = ""; }
      };

      sock.on("data", (chunk: Buffer) => {
        bytesOut += chunk.length;
        inbuf += decoder.write(chunk);
        if (phase === "relay") {
          if (inbuf && ws.readyState === ws.OPEN) ws.send(inbuf);
          inbuf = "";
          return;
        }
        // Handshake: parse instructions until we see guacd's `args`.
        try {
          for (;;) {
            const inst = parseInstruction(inbuf);
            if (!inst) break;
            const opcode = inst.elements[0];
            if (opcode === "args") {
              inbuf = inbuf.slice(inst.consumed);
              completeHandshake(inst.elements);
              break;
            }
            if (opcode === "error") {
              const msg = inst.elements[1] ?? "guacd error";
              deps.log.warn({ msg }, "rdp gateway: guacd handshake error");
              endHistory("failed", msg);
              sock.destroy();
              return closeWs(4502, "rdp handshake failed");
            }
            // Some other pre-args instruction — drop it and keep scanning.
            inbuf = inbuf.slice(inst.consumed);
          }
        } catch (e) {
          deps.log.warn({ err: e instanceof Error ? e.message : String(e) }, "rdp gateway: guacd parse error");
          sock.destroy();
          closeWs(4502, "rdp protocol error");
        }
      });

      sock.on("timeout", () => { sock.destroy(); endHistory("failed", "guacd timeout"); closeWs(4504, "guacd timed out"); });
      sock.on("error", (e: NodeJS.ErrnoException) => {
        deps.log.warn({ err: e.message, guacd: deps.guacd.host }, "rdp gateway: guacd tcp error");
        endHistory("failed", e.message);
        closeWs(4502, e.code === "ECONNREFUSED" ? "guacd unavailable" : "rdp gateway error");
      });
      sock.on("close", () => { endHistory("closed"); closeWs(1000, "closed"); });

      ws.on("message", (raw: Buffer) => {
        bytesIn += raw.length;
        // guacamole-common-js sends UTF-8 text instructions; forward verbatim.
        sendToGuacd(raw.toString("utf8"));
      });
      ws.on("close", () => { endHistory("closed"); sock.destroy(); });
      ws.on("error", () => sock.destroy());
    });
  };
}
