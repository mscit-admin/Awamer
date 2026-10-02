import pino from "pino";
import type { Config } from "../config/index.js";

export type Logger = pino.Logger;

/**
 * Paths pino censors before writing a log line. This service handles SSH/VPN
 * credentials, JWTs and encrypted secrets, so redaction is defence-in-depth
 * against an accidental `log.info({ credential })` leaking secret material.
 */
const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "headers.authorization",
  "password", "*.password",
  "secret", "*.secret",
  "secretData", "*.secretData",
  "secret_data", "*.secret_data",
  "token", "*.token",
  "accessToken", "*.accessToken",
  "refreshToken", "*.refreshToken",
  "privateKey", "*.privateKey",
  "private_key", "*.private_key",
  "passphrase", "*.passphrase",
  "apiKey", "*.apiKey",
  "api_key", "*.api_key",
  "credential", "*.credential",
  "password_hash", "*.password_hash",
  "otp", "*.otp",
  "config", "*.config", // VPN .ovpn config text
  // GO-LIVE logging review: token / secret field names used by the auth, MFA,
  // reset and step-up flows, raw headers, and DB connection strings.
  "authorization", "*.authorization",
  "cookie", "*.cookie", "headers.cookie", "headers[\"set-cookie\"]", "*.headers[\"set-cookie\"]",
  "req.headers[\"x-step-up-token\"]", "headers[\"x-step-up-token\"]",
  "refresh_token", "*.refresh_token",
  "access_token", "*.access_token",
  "mfa_token", "*.mfa_token", "mfaToken", "*.mfaToken",
  "mfa_code", "*.mfa_code",
  "step_up_token", "*.step_up_token", "stepUpToken", "*.stepUpToken",
  "reset_token", "*.reset_token", "resetToken", "*.resetToken",
  "ticket", "*.ticket",
  "secret_enc", "*.secret_enc", "secretEnc", "*.secretEnc",
  "databaseUrl", "*.databaseUrl", "DATABASE_URL", "*.DATABASE_URL",
  "connectionString", "*.connectionString",
];

/** Drop the query string: one-time tickets / reset tokens can ride in it. */
export function redactUrl(url: unknown): unknown {
  return typeof url === "string" ? url.split("?")[0] : url;
}

/**
 * Request serializer: method + path only (no query string, no headers, no
 * body). Fastify logs `{ req }` on every request; this keeps one-time tokens
 * in query strings (VNC ticket, reset link) out of the logs.
 */
function reqSerializer(req: { method?: string; url?: string; id?: unknown }) {
  return { id: req.id, method: req.method, url: redactUrl(req.url) };
}

/** Shared pino options (exported for the redaction regression test). */
export function loggerOptions(cfg: Config): pino.LoggerOptions {
  return {
    level: cfg.env.LOG_LEVEL,
    base: cfg.isProd ? { service: "auth-service", env: cfg.env.APP_ENV } : { service: "auth-service" },
    ...(cfg.isProd ? { timestamp: pino.stdTimeFunctions.isoTime } : {}),
    redact: { paths: REDACT_PATHS, censor: "[redacted]" },
    serializers: { req: reqSerializer },
  };
}

export function createLogger(cfg: Config): Logger {
  if (cfg.isProd) {
    return pino(loggerOptions(cfg));
  }
  return pino({
    ...loggerOptions(cfg),
    transport: {
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "HH:MM:ss.l",
        ignore: "pid,hostname,service",
      },
    },
  });
}
