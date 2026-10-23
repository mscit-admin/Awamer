/**
 * SEC-CACHE-001 (ASVS V14.3.2 / V14.2.5) — API responses must never be stored by
 * a browser, proxy or CDN cache. They carry secrets (credential reveal, TOTP
 * seeds, VPN profiles, backups) and per-user data. A route that deliberately
 * sets its own Cache-Control keeps it.
 */
import type { FastifyInstance } from "fastify";

// Generic over the server/logger types so it accepts the app built with the
// project's pino logger as well as a plain Fastify() in tests.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerNoStoreHeaders(app: FastifyInstance<any, any, any, any>): void {
  app.addHook("onSend", async (_req, reply, payload) => {
    if (!reply.hasHeader("cache-control")) {
      reply.header("Cache-Control", "no-store");
      reply.header("Pragma", "no-cache");
    }
    return payload;
  });
}
