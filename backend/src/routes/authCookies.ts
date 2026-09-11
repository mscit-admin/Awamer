/**
 * Browser refresh-token cookie (AWM-SEC-019).
 *
 * The Tauri desktop app keeps the refresh token in the OS keyring and sends it
 * in request bodies — unchanged. The browser build cannot safely hold a
 * long-lived refresh token in JS-readable storage (localStorage → XSS-exfil),
 * so it opts into a cookie transport by sending `X-Awamer-Client: web`. For
 * those requests the server:
 *   - sets the refresh token as an HttpOnly, Secure, SameSite=Strict cookie
 *     scoped to the auth path (so JS can never read it and it is never sent
 *     cross-site — the CSRF control), and
 *   - omits the refresh token from the JSON body.
 * `/refresh` and `/logout` read the token from that cookie.
 *
 * SameSite=Strict + a header-gated, non-cookie access token (Authorization
 * header) means normal API calls are not cookie-driven and cross-site requests
 * never carry the refresh cookie, so no separate CSRF token is required.
 */
import type { FastifyReply, FastifyRequest } from "fastify";

export const REFRESH_COOKIE = "awamer_refresh";
const COOKIE_PATH = "/api/v1/auth";

/** True when the caller is the browser SPA opting into cookie transport. */
export function isWebClient(req: FastifyRequest): boolean {
  const h = req.headers["x-awamer-client"];
  return (Array.isArray(h) ? h[0] : h) === "web";
}

function serializeCookie(name: string, value: string, attrs: string[]): string {
  return `${name}=${encodeURIComponent(value)}; ${attrs.join("; ")}`;
}

export function setRefreshCookie(reply: FastifyReply, token: string, maxAgeSec: number): void {
  reply.header("Set-Cookie", serializeCookie(REFRESH_COOKIE, token, [
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
    `Path=${COOKIE_PATH}`,
    `Max-Age=${Math.max(0, Math.floor(maxAgeSec))}`,
  ]));
}

export function clearRefreshCookie(reply: FastifyReply): void {
  reply.header("Set-Cookie", serializeCookie(REFRESH_COOKIE, "", [
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
    `Path=${COOKIE_PATH}`,
    "Max-Age=0",
  ]));
}

/** Read the refresh cookie value from the request's Cookie header, if present. */
export function readRefreshCookie(req: FastifyRequest): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === REFRESH_COOKIE) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}
