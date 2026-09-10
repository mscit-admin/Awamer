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
];

export function createLogger(cfg: Config): Logger {
  if (cfg.isProd) {
    return pino({
      level: cfg.env.LOG_LEVEL,
      base: { service: "auth-service", env: cfg.env.APP_ENV },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: { paths: REDACT_PATHS, censor: "[redacted]" },
    });
  }
  return pino({
    level: cfg.env.LOG_LEVEL,
    base: { service: "auth-service" },
    redact: { paths: REDACT_PATHS, censor: "[redacted]" },
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
