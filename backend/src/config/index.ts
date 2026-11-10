import { z } from "zod";
import { isSafePublicBaseUrl, normalizeBaseUrl } from "../usecases/publicBaseUrl.js";
import { parseCidrList, type NetworkDiagnosticPolicy } from "../usecases/networkPolicy.js";
import { makeVpnPortPolicy, type VpnPortPolicy } from "../domain/vpnPortPolicy.js";

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
 * SEC-PROXY-001 — reject a TRUST_PROXY value that would trust every client (which
 * would let any client spoof X-Forwarded-*). Fail-closed: the config throws rather
 * than silently falling back to broad trust. A "trust nothing" value ("false"/
 * empty) is also rejected because an empty trust set is a configuration mistake,
 * not a safe state — the intended minimum is `loopback`.
 */
export function isDangerousTrustProxy(raw: string): boolean {
  const entries = raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (entries.length === 0) return true; // empty / whitespace only
  const BROAD = new Set(["true", "false", "*", "0.0.0.0/0", "::/0", "0.0.0.0", "::"]);
  return entries.some((e) => BROAD.has(e));
}

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
  // SEC-PROXY-001 — which upstream hops Fastify may trust for X-Forwarded-*.
  // Passed straight to Fastify's `trustProxy` (proxy-addr syntax): keywords, IPs,
  // or CIDRs (comma-separated). The shipped architecture is Nginx → 127.0.0.1:8081,
  // so the secure DEFAULT trusts ONLY the loopback proxy hop. A private/LAN client
  // is a CLIENT, not a proxy: `uniquelocal`/`linklocal`/broad private ranges are
  // NOT trusted by default (that would let a LAN client rotate X-Forwarded-For to
  // poison req.ip / rate limiting / audit). Add an explicit exact proxy CIDR (e.g.
  // "loopback,172.20.0.5/32") only for a real reverse proxy / load balancer.
  // FAIL-CLOSED: values that would trust every client ("true", "*", "0.0.0.0/0",
  // "::/0", "false") are REJECTED — an invalid trust config never widens silently.
  TRUST_PROXY: z.string().default("loopback")
    .refine((v) => !isDangerousTrustProxy(v), "TRUST_PROXY must be a specific proxy address/CIDR/keyword list — never \"true\", \"false\", \"*\", \"0.0.0.0/0\" or \"::/0\" (those trust every client)"),

  // Database
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  DATABASE_MAX_CONNS: z.coerce.number().int().positive().default(25),

  // JWT
  JWT_ACCESS_SECRET: z.string().min(32, "JWT_ACCESS_SECRET must be ≥32 chars"),
  JWT_REFRESH_SECRET: z.string().min(32, "JWT_REFRESH_SECRET must be ≥32 chars"),
  JWT_ACCESS_TTL: z.string().default("15m"),
  JWT_REFRESH_TTL: z.string().default("168h"),
  // SEC-SESSION-ABS-001 (ASVS V7.3.2): absolute session lifetime. Refresh
  // rotation slides by JWT_REFRESH_TTL, but never past this long after the
  // original sign-in — then the user must authenticate again.
  SESSION_ABSOLUTE_LIFETIME: z.string().default("168h"),
  // SEC-PW-TEMP-001 (ASVS V6.4.1): an admin-set (temporary) password must be
  // replaced at first sign-in and stops working if unused for this long.
  TEMP_PASSWORD_TTL: z.string().default("72h"),
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
  // SEC-AUDIT-EXPORT-001 (ASVS V16.4.3): also write every audit event to stdout
  // as a structured `event:"audit"` line, so the container log driver (syslog,
  // fluentd, a SIEM agent…) ships it OFF the host. Default on; "false" disables.
  AUDIT_LOG_STDOUT: z.string().optional().transform((v) => v !== "false"),

  // DB-LEAST-PRIVILEGE: emergency override ONLY — lets production start while
  // DATABASE_URL is still an over-privileged role (superuser / migration
  // owner). Logged as an error on every start; never set it in a normal deploy.
  DB_ALLOW_PRIVILEGED_RUNTIME: z.string().optional().transform((v) => v === "true"),

  // RDP gateway → guacd (Apache Guacamole proxy daemon), which speaks RDP to
  // the target host. In production guacd is its own container (service
  // "guacd") on the internal network.
  GUACD_HOST: z.string().default("127.0.0.1"),
  GUACD_PORT: z.coerce.number().int().positive().default(4822),

  // CORS
  CORS_ALLOWED_ORIGINS: z.string().default("http://localhost:1420,tauri://localhost,https://tauri.localhost"),

  // SEC-RESET-001: trusted public base URL for security-sensitive links
  // (password reset). MUST be the real public origin, e.g.
  // https://awamer.example.com or https://awamer.example.com:6655. Reset links
  // are built ONLY from this (or a valid app_base_url setting), never headers.
  APP_PUBLIC_BASE_URL: z.string().optional(),

  // Network diagnostics allow/deny lists (focused fix — Network CIDR
  // hardening). Comma/space separated IPv4 CIDRs. Diagnostics to a private /
  // internal address are permitted ONLY when the address is inside an ALLOWED
  // CIDR; with no allow list, all private targets are denied (fail-closed).
  // DENY takes precedence and is for the app's own infra (Docker/PG/Redis).
  // Example: NETWORK_DIAGNOSTIC_ALLOWED_CIDRS=192.168.10.0/24,192.168.20.0/24
  NETWORK_DIAGNOSTIC_ALLOWED_CIDRS: z.string().optional(),
  NETWORK_DIAGNOSTIC_DENY_CIDRS: z.string().optional(),

  // SEC-REMOTE-DEST-001 — remote-session destinations (SSH/SFTP/Telnet/VNC and
  // the SSH hop of tunnels). Private/internal hosts are ALWAYS allowed (that is
  // the product); link-local/cloud-metadata, unspecified and multicast are
  // ALWAYS denied. Loopback (the backend's own host/container) is denied unless
  // explicitly enabled. DENY_CIDRS adds IPv4 ranges to refuse, e.g. the Docker
  // network holding PostgreSQL: REMOTE_SESSION_DENY_CIDRS=172.18.0.0/16
  REMOTE_SESSION_ALLOW_LOOPBACK: z.string().optional().transform((v) => v === "true"),
  REMOTE_SESSION_DENY_CIDRS: z.string().optional(),
  REMOTE_SESSION_DENY_LOCAL_SUBNETS: z.string().optional().transform((v) => v === "true"),

  // SEC-INFRA-001 — privileged VPN helper IPC. The backend never spawns
  // OpenVPN; it talks to the isolated awamer-vpn-helper over this Unix socket,
  // authenticated with a high-entropy shared secret. The secret is REQUIRED in
  // production (checked in loadConfig); optional in dev where VPN isn't used.
  VPN_HELPER_SOCKET: z.string().default("/run/awamer/ipc/vpn-helper.sock"),
  VPN_HELPER_SECRET: z.string().optional(),

  // Multi-VPN-Server dynamic ports. Each VPN Server is assigned its OWN port +
  // protocol from this range (the DB record is authoritative — there is no
  // single deployment-wide OpenVPN port). Validated 1<=min<=max<=65535 (fail
  // closed). VPN_RESERVED_PORTS adds extra infra ports (e.g. the HTTPS port) to
  // the built-in reserved set (22/80/443/backend/PostgreSQL/Redis).
  VPN_SERVER_PORT_MIN: z.coerce.number().int().default(20000),
  VPN_SERVER_PORT_MAX: z.coerce.number().int().default(30000),
  VPN_RESERVED_PORTS: z.string().optional(),
  // Host firewall backend the privileged helper uses for per-server rules:
  // "iptables" (default; works under iptables-legacy and iptables-nft), or
  // "none" to disable automatic firewall management (report FIREWALL_ACTION_REQUIRED).
  VPN_FIREWALL_BACKEND: z.enum(["iptables", "none"]).default("iptables"),

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
  /** SEC-SESSION-ABS-001: max seconds from sign-in to the end of the session. */
  sessionAbsoluteLifetimeSec: number;
  /** SEC-PW-TEMP-001: lifetime of an unused admin-set password. */
  tempPasswordTtlSec: number;
  corsOrigins: string[];
  /** SEC-PROXY-001: Fastify `trustProxy` value (proxy-addr syntax). */
  trustProxy: string;
  /** SEC-RESET-001: validated trusted public base URL (or null if unset). */
  publicBaseUrl: string | null;
  /** Network CIDR hardening: parsed allow/deny lists for network diagnostics. */
  networkDiagnostic: NetworkDiagnosticPolicy;
  /** Multi-VPN-Server port assignment policy (range + reserved ports). */
  vpnPortPolicy: VpnPortPolicy;
  /** Host firewall backend for per-server VPN rules ("iptables" | "none"). */
  vpnFirewallBackend: "iptables" | "none";
}

/** Parse the PostgreSQL port out of DATABASE_URL (default 5432). */
function pgPort(dbUrl: string): number {
  try { return Number(new URL(dbUrl).port) || 5432; } catch { return 5432; }
}

/**
 * GO-LIVE production hardening (fail closed at startup):
 *  - API docs (Swagger UI) are development-only — they enumerate the admin API
 *    surface and pull in @fastify/static; production refuses ENABLE_API_DOCS.
 *  - CORS: credentials are allowed, so no wildcard, no "null", and no plain-http
 *    web origin (http://tauri.localhost — the Windows Tauri origin — excepted).
 *  - The vpn-helper IPC secret must be present and high-entropy-length.
 */
export function assertProductionHardening(env: {
  ENABLE_API_DOCS?: boolean; CORS_ALLOWED_ORIGINS: string; VPN_HELPER_SECRET?: string;
}): void {
  if (env.ENABLE_API_DOCS) {
    throw new Error("ENABLE_API_DOCS must not be enabled in production (API docs are development-only)");
  }
  const origins = env.CORS_ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean);
  if (origins.length === 0) throw new Error("CORS_ALLOWED_ORIGINS must list at least one origin in production");
  for (const o of origins) {
    if (o === "*" || o.toLowerCase() === "null" || o.includes("*")) {
      throw new Error(`CORS_ALLOWED_ORIGINS: wildcard/null origin "${o}" is not allowed in production`);
    }
    if (/^http:\/\//i.test(o) && o.toLowerCase() !== "http://tauri.localhost") {
      throw new Error(`CORS_ALLOWED_ORIGINS: plain-http origin "${o}" is not allowed in production (use https)`);
    }
    if (!/^(https:\/\/|tauri:\/\/|http:\/\/tauri\.localhost$)/i.test(o)) {
      throw new Error(`CORS_ALLOWED_ORIGINS: unsupported origin "${o}" in production`);
    }
  }
  if (!env.VPN_HELPER_SECRET || env.VPN_HELPER_SECRET.length < 32) {
    throw new Error("VPN_HELPER_SECRET is required in production and must be at least 32 characters");
  }
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
    assertProductionHardening(env);
  }

  // SEC-RESET-001: if a public base URL is provided, it MUST be a valid, safe
  // URL (https in production; no embedded credentials; no non-http schemes).
  // An invalid value fails startup rather than silently degrading.
  const isProd = env.APP_ENV === "production";
  let publicBaseUrl: string | null = null;
  if (env.APP_PUBLIC_BASE_URL && env.APP_PUBLIC_BASE_URL.trim() !== "") {
    if (!isSafePublicBaseUrl(env.APP_PUBLIC_BASE_URL, { allowHttp: !isProd })) {
      throw new Error(
        "APP_PUBLIC_BASE_URL must be a valid " +
          (isProd ? "https" : "http(s)") +
          " URL with a hostname and no embedded credentials",
      );
    }
    publicBaseUrl = normalizeBaseUrl(env.APP_PUBLIC_BASE_URL);
  }

  return {
    env,
    isProd,
    isDev: env.APP_ENV === "development",
    jwtAccessTtlSec: parseDuration(env.JWT_ACCESS_TTL),
    jwtRefreshTtlSec: parseDuration(env.JWT_REFRESH_TTL),
    sessionAbsoluteLifetimeSec: parseDuration(env.SESSION_ABSOLUTE_LIFETIME),
    tempPasswordTtlSec: parseDuration(env.TEMP_PASSWORD_TTL),
    corsOrigins: env.CORS_ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean),
    trustProxy: env.TRUST_PROXY.trim(),
    publicBaseUrl,
    networkDiagnostic: {
      allowed: parseCidrList(env.NETWORK_DIAGNOSTIC_ALLOWED_CIDRS),
      deny: parseCidrList(env.NETWORK_DIAGNOSTIC_DENY_CIDRS),
    },
    // Centralized reserved ports: SSH/HTTP/HTTPS, the backend, PostgreSQL (from
    // DATABASE_URL), Redis, plus any operator-configured extras (e.g. the real
    // HTTPS port). makeVpnPortPolicy throws (fail closed) on an invalid range.
    vpnPortPolicy: makeVpnPortPolicy({
      min: env.VPN_SERVER_PORT_MIN,
      max: env.VPN_SERVER_PORT_MAX,
      reserved: [
        22, 80, 443,
        env.AUTH_HTTP_PORT,
        pgPort(env.DATABASE_URL),
        6379,
        ...(env.VPN_RESERVED_PORTS ?? "")
          .split(/[,\s]+/).map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0),
      ],
    }),
    vpnFirewallBackend: env.VPN_FIREWALL_BACKEND,
  };
}
