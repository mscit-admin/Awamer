/**
 * SEC-RESET-001 — Trusted public base URL for security-sensitive links.
 *
 * Password-reset (and any other security-sensitive) links must be built ONLY
 * from a trusted, operator-configured base URL — never from request headers
 * (Origin/Referer/Host/X-Forwarded-*), which an attacker can spoof to poison a
 * reset link and take over an account.
 *
 * Precedence for the trusted base URL:
 *   1. APP_PUBLIC_BASE_URL (environment/deployment config) — authoritative.
 *   2. the admin-configured DB setting `app_base_url` (if present AND valid).
 * Request headers are never consulted.
 */

export interface BaseUrlPolicy {
  /** Allow plain http:// (development/test only). Production requires https. */
  allowHttp: boolean;
}

/**
 * Validate a candidate public base URL.
 * Requires: http(s) scheme (https unless allowHttp), a real hostname, and NO
 * embedded credentials. Rejects javascript:/file:/data:/ftp:/etc. by only
 * accepting http(s).
 */
export function isSafePublicBaseUrl(raw: string | null | undefined, policy: BaseUrlPolicy): boolean {
  if (!raw || typeof raw !== "string") return false;
  if (/\s/.test(raw)) return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  const scheme = u.protocol.toLowerCase();
  if (scheme === "https:") {
    // ok
  } else if (scheme === "http:") {
    if (!policy.allowHttp) return false;
  } else {
    return false; // javascript:, file:, data:, ftp:, gopher:, …
  }
  // No embedded credentials (https://user:pass@host).
  if (u.username || u.password) return false;
  // A real hostname is required (URL keeps a non-empty host for http(s)).
  if (!u.hostname) return false;
  return true;
}

/** Strip trailing slashes for consistent link construction. */
export function normalizeBaseUrl(raw: string): string {
  return raw.replace(/\/+$/, "");
}

/**
 * Resolve the trusted base URL from the allowed sources, or null if none is
 * valid. NEVER falls back to request-derived values.
 */
export function resolveTrustedBaseUrl(opts: {
  envBaseUrl?: string | null;
  dbBaseUrl?: string | null;
  allowHttp: boolean;
}): string | null {
  const policy: BaseUrlPolicy = { allowHttp: opts.allowHttp };
  for (const candidate of [opts.envBaseUrl, opts.dbBaseUrl]) {
    if (candidate && isSafePublicBaseUrl(candidate, policy)) {
      return normalizeBaseUrl(candidate);
    }
  }
  return null;
}

/**
 * Fail-closed startup assertion (§5): if password-reset/email is enabled in
 * production and no trusted public base URL is configured, refuse to start
 * rather than silently fall back to request headers.
 */
export function assertResetEmailBaseUrl(opts: {
  isProd: boolean;
  emailEnabled: boolean;
  trustedBase: string | null;
}): void {
  if (opts.isProd && opts.emailEnabled && !opts.trustedBase) {
    throw new Error(
      "APP_PUBLIC_BASE_URL (or a valid app_base_url setting) is required in production " +
        "when email/password-reset is enabled — refusing to derive reset links from request headers.",
    );
  }
}
