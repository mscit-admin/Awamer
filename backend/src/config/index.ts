import { z } from "zod";

/**
 * Development-only default bootstrap password. Never accepted in production
 * (AWM-CFG-001) — production must supply an explicit strong secret.
 */
export const DEV_BOOTSTRAP_PASSWORD = "ChangeMe!2026";

/** Minimum length required of a production bootstrap admin password. */
export const PROD_BOOTSTRAP_MIN_LEN = 16;

/**
 * Known weak / placeholder bootstrap passwords rejected in production. Compared
 * case-insensitively; the substring guard below also catches "change me"
 * variants. This is a reasonable deny policy, not an exhaustive dictionary.
 */
const BOOTSTRAP_PLACEHOLDERS = new Set([
  "changeme!2026", "changeme", "change_me", "change-me", "change_me_in_production",
  "password", "password123", "passw0rd", "admin", "admin123", "administrator",
  "default", "secret", "letmein", "root", "toor", "welcome", "welcome1",
]);

/**
 * Validate a production bootstrap admin password. Throws (fail-closed) when the
 * value is missing/empty, too short, or a known placeholder. NEVER includes the
 * password itself in the error message or logs (AWM-CFG-001 §19).
 */
export function assertProductionBootstrapPassword(pw: string): void {
  const trimmed = (pw ?? "").trim();
  if (trimmed.length === 0) {
    throw new Error("BOOTSTRAP_ADMIN_PASSWORD must be set to a strong secret in production");
  }
  if (trimmed.length < PROD_BOOTSTRAP_MIN_LEN) {
    throw new Error(`BOOTSTRAP_ADMIN_PASSWORD must be at least ${PROD_BOOTSTRAP_MIN_LEN} characters in production`);
  }
  const lower = trimmed.toLowerCase();
  if (BOOTSTRAP_PLACEHOLDERS.has(lower) || lower.includes("changeme") || lower.includes("change_me") || lower.includes("change-me")) {
    throw new Error("BOOTSTRAP_ADMIN_PASSWORD is a known/placeholder value; set a unique strong secret in production");
  }
}

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

  // Bootstrap admin (created on first startup if no users exist).
  // The password default below is a DEVELOPMENT convenience only; production
  // rejects it (and other weak/placeholder values) — see loadConfig (AWM-CFG-001).
  BOOTSTRAP_ADMIN_USERNAME: z.string().default("admin"),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().min(8).default(DEV_BOOTSTRAP_PASSWORD),
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
    // AWM-CFG-001: never let production bootstrap a Super Admin with the dev
    // default or any weak/placeholder password. Fail closed before startup.
    assertProductionBootstrapPassword(env.BOOTSTRAP_ADMIN_PASSWORD);
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
