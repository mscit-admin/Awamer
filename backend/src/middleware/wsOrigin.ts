/**
 * SEC-WS-ORIGIN-001 (ASVS V4.4.2) — Origin allowlist on every WebSocket upgrade.
 *
 * Browsers attach cookies/ambient credentials to cross-site WebSocket
 * handshakes and do not apply CORS to them, so a gateway must check `Origin`
 * itself (cross-site WebSocket hijacking). The first-frame token / one-time VNC
 * ticket already make a hijack hard; this closes it at the handshake.
 *
 * Allowed:
 *   - no Origin header (non-browser clients: the Tauri Rust side, CLI tools —
 *     CSWSH needs a browser, and every browser sends Origin on a WS handshake);
 *   - an Origin listed in CORS_ALLOWED_ORIGINS (Tauri webview, dev server);
 *   - same-origin: the Origin's host equals the request Host. Nginx forwards
 *     `Host $host` (no port), so when Host has no port only the hostname is
 *     compared; when it has one, host:port must match exactly.
 * Everything else (other sites, `null`, malformed) is refused with 403 before
 * the upgrade completes.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";

export function isAllowedWsOrigin(origin: string | undefined, hostHeader: string | undefined, allowlist: readonly string[]): boolean {
  if (origin === undefined) return true;
  if (allowlist.includes(origin)) return true;
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  const host = (hostHeader ?? "").trim().toLowerCase();
  if (!host) return false;
  // Host with an explicit port (IPv6 literals are bracketed: "[::1]:8443").
  const hasPort = /:\d+$/.test(host) && (!host.startsWith("[") || host.includes("]:"));
  return hasPort ? u.host.toLowerCase() === host : u.hostname.toLowerCase() === host;
}

function isWebSocketUpgrade(req: FastifyRequest): boolean {
  return String(req.headers.upgrade ?? "").toLowerCase() === "websocket";
}

// Generic over the server/logger types (project pino logger vs plain Fastify in tests).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerWsOriginCheck(app: FastifyInstance<any, any, any, any>, allowlist: readonly string[]): void {
  app.addHook("onRequest", async (req, reply) => {
    if (!isWebSocketUpgrade(req)) return;
    const origin = req.headers.origin;
    if (!isAllowedWsOrigin(origin, req.headers.host, allowlist)) {
      req.log.warn({ origin, url: req.url }, "websocket upgrade refused: origin not allowed");
      return reply.code(403).send({ error: { code: "origin_not_allowed", message: "websocket origin not allowed" } });
    }
  });
}
