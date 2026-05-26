import pino from "pino";
import type { Config } from "../config/index.js";

export type Logger = pino.Logger;

export function createLogger(cfg: Config): Logger {
  if (cfg.isProd) {
    return pino({
      level: cfg.env.LOG_LEVEL,
      base: { service: "auth-service", env: cfg.env.APP_ENV },
      timestamp: pino.stdTimeFunctions.isoTime,
    });
  }
  return pino({
    level: cfg.env.LOG_LEVEL,
    base: { service: "auth-service" },
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
