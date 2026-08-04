import { z } from "zod";

const envSchema = z.object({
  // App
  APP_ENV: z.enum(["development", "staging", "production"]).default("development"),
  APP_NAME: z.string().default("netsphere"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  // HTTP
  AUTH_HTTP_HOST: z.string().default("0.0.0.0"),
  AUTH_HTTP_PORT: z.coerce.number().int().positive().default(8081),

  // Database
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  DATABASE_MAX_CONNS: z.coerce.number().int().positive().default(25),

  // JWT
  JWT_ACCESS_SECRET: z.string().min(32, "JWT_ACCESS_SECRET must be ≥32 chars"),
  JWT_REFRESH_SECRET: z.string().min(32, "JWT_REFRESH_SECRET must be ≥32 chars"),
  JWT_ACCESS_TTL: z.string().default("15m"),
  JWT_REFRESH_TTL: z.string().default("168h"),
  JWT_ISSUER: z.string().default("netsphere"),

  // Credential encryption (Phase 10) — 32 bytes, base64 or hex.
  // Optional in dev (derived from JWT_REFRESH_SECRET); required in production.
  CREDENTIAL_ENCRYPTION_KEY: z.string().optional(),

  // Argon2id
  ARGON2_MEMORY_KB: z.coerce.number().int().positive().default(65536),
  ARGON2_ITERATIONS: z.coerce.number().int().positive().default(3),
  ARGON2_PARALLELISM: z.coerce.number().int().positive().default(4),

  // Limits
  RATE_LIMIT_LOGIN_PER_MIN: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_API_PER_MIN: z.coerce.number().int().positive().default(120),
  ACCOUNT_LOCKOUT_THRESHOLD: z.coerce.number().int().positive().default(5),
  // Minutes an account is auto-locked after hitting the failed-attempt
  // threshold, then it unlocks itself (temporary lockout).
  ACCOUNT_LOCKOUT_MINUTES: z.coerce.number().int().positive().default(15),
  // Expose the OpenAPI docs UI at /docs (off by default; it lists the API
  // surface, so enable it deliberately — e.g. in staging/dev).
  ENABLE_API_DOCS: z.string().optional().transform((v) => v === "true"),

  // CORS
  CORS_ALLOWED_ORIGINS: z.string().default("http://localhost:1420,tauri://localhost,https://tauri.localhost"),

  // Bootstrap admin (created on first startup if no users exist)
  BOOTSTRAP_ADMIN_USERNAME: z.string().default("admin"),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().min(8).default("ChangeMe!2026"),
  BOOTSTRAP_ADMIN_EMAIL: z.string().email().default("admin@netsphere.local"),
});

export type Env = z.infer<typeof envSchema>;

function parseDuration(s: string): number {
  // Returns seconds.
  const m = /^(\d+)([smhd])$/.exec(s);
  if (!m) throw new Error(`invalid duration: ${s}`);
  const [, n, unit] = m;
  const mult = { s: 1, m: 60, h: 3600, d: 86400 }[unit as "s" | "m" | "h" | "d"];
  return Number(n) * mult;
}

export interface Config {
  env: Env;
  isProd: boolean;
  isDev: boolean;
  jwtAccessTtlSec: number;
  jwtRefreshTtlSec: number;
  corsOrigins: string[];
}

export function loadConfig(): Config {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  const env = parsed.data;

  if (env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET) {
    throw new Error("JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must differ");
  }
  if (env.APP_ENV === "production") {
    const lower = (s: string) => s.toLowerCase();
    if (lower(env.JWT_ACCESS_SECRET).includes("dev") || lower(env.JWT_REFRESH_SECRET).includes("dev")) {
      throw new Error("Dev-only JWT secrets detected in production");
    }
  }

  return {
    env,
    isProd: env.APP_ENV === "production",
    isDev: env.APP_ENV === "development",
    jwtAccessTtlSec: parseDuration(env.JWT_ACCESS_TTL),
    jwtRefreshTtlSec: parseDuration(env.JWT_REFRESH_TTL),
    corsOrigins: env.CORS_ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean),
  };
}
