import type { FastifyReply, FastifyRequest } from "fastify";
import type { JwtService, VerifiedClaims } from "../jwt/index.js";
import { can, type Permission } from "../domain/permissions.js";
import { mfaRequiredForRole } from "../domain/mfaPolicy.js";

declare module "fastify" {
  interface FastifyRequest {
    auth?: VerifiedClaims;
  }
}

/**
 * The current, security-relevant slice of a user's account. Structurally
 * satisfied by `UserRepository.getById`'s `User` — declared here so the auth
 * layer does not depend on the repository's concrete type.
 */
export interface AuthUserState {
  role: string;
  isActive: boolean;
  isLocked: boolean;
  lockedUntil: Date | null;
  companyId: string | null;
  /** SEC-SESSION-001 — live account security version. */
  authVersion: number;
  /** SEC-MFA-POLICY-001 — whether the account has an active TOTP device. */
  mfaEnabled: boolean;
  /** SEC-PW-TEMP-001 — the password was set by an admin and must be replaced. */
  passwordMustChange: boolean;
}
export interface AuthUserSource {
  getById(id: string): Promise<AuthUserState>;
}

/** Raised when the token is valid but the account's LIVE state is not. */
export class AuthStateError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "AuthStateError";
    this.code = code;
  }
}

/**
 * AWM-SEC-021 — resolve and validate the CURRENT security state of the token's
 * subject, so authorization never trusts a stale (up-to-15-minute) access token.
 * Rejects a deleted, disabled or locked account and returns the live user (whose
 * live `role` callers use for permission checks). Applied identically by the
 * HTTP middleware and every long-lived WS channel (SSH/Telnet/tunnel/VNC).
 */
export async function assertAuthState(users: AuthUserSource, sub: string): Promise<AuthUserState> {
  let user: AuthUserState;
  try {
    user = await users.getById(sub);
  } catch {
    throw new AuthStateError("account_invalid", "account no longer exists");
  }
  if (!user.isActive) throw new AuthStateError("account_disabled", "account is disabled");
  const tempLocked = user.lockedUntil != null && user.lockedUntil.getTime() > Date.now();
  if (user.isLocked || tempLocked) throw new AuthStateError("account_locked", "account is locked");
  return user;
}

/** Result of a full access-token validation: the verified claims + live state. */
export interface CurrentAccess {
  claims: VerifiedClaims;
  live: AuthUserState;
}

/**
 * SEC-SESSION-002 — the ONE authoritative access-token check used by every entry
 * point (HTTP middleware and the direct-token WebSocket gateways). It:
 *   1-3. verifies the JWT signature, type ("access") and expiry (`verifyAccess`);
 *   4-7. loads the live account and rejects a deleted/disabled/locked user
 *        (`assertAuthState`);
 *   8.   rejects a token minted before a security-sensitive change by comparing
 *        the token's `av` (auth_version) with the live account version;
 *   9.   rejects an account that must first replace a temporary password
 *        (SEC-PW-TEMP-001) or enroll MFA (SEC-MFA-POLICY-001) — except on the
 *        few HTTP routes that let it do exactly that (`route`);
 *   returns the live user so callers authorize on `live.role`, never the role
 *   embedded in the (possibly stale) token.
 *
 * Throws `JwtError`/`JwtExpired` for token problems and `AuthStateError`
 * (code `session_invalidated` for the version mismatch) for live-state problems,
 * so callers can map them to their own responses without re-implementing any of
 * the security logic.
 */
export async function verifyCurrentAccessToken(
  jwt: JwtService,
  users: AuthUserSource,
  token: string,
  /** The registered HTTP route, for the restricted-account allowlists. WS gateways omit it. */
  opts: { route?: { method: string; url: string | undefined } } = {},
): Promise<CurrentAccess> {
  const claims = await jwt.verifyAccess(token); // (1-3) signature + type + expiry
  const live = await assertAuthState(users, claims.sub); // (4-7) live account state
  // (8) reject tokens issued before a password/MFA change. `av` is inside the
  // signed token, so a client cannot forge or downgrade it.
  if (claims.av !== live.authVersion) {
    throw new AuthStateError("session_invalidated", "credentials changed; please sign in again");
  }
  // (9) A restricted account gets no access except the routes that lift the
  // restriction. Temporary password first, then MFA enrollment.
  const restriction = accountRestriction(live);
  if (restriction && !(opts.route && isRouteAllowedWhileRestricted(restriction, opts.route.method, opts.route.url))) {
    throw new AuthStateError(restriction, RESTRICTION_MESSAGE[restriction]);
  }
  return { claims, live };
}

export type AccountRestriction = "password_change_required" | "mfa_enrollment_required";

const RESTRICTION_MESSAGE: Record<AccountRestriction, string> = {
  password_change_required: "your password was set by an administrator; choose a new one first",
  mfa_enrollment_required: "your role requires two-factor authentication; enroll first",
};

/** What the account must do before it may use the API, or null. */
export function accountRestriction(live: Pick<AuthUserState, "role" | "mfaEnabled" | "passwordMustChange">): AccountRestriction | null {
  if (live.passwordMustChange) return "password_change_required";
  if (mfaEnrollmentRequired(live)) return "mfa_enrollment_required";
  return null;
}

/** True when the live account's role requires MFA and none is enrolled. */
export function mfaEnrollmentRequired(live: Pick<AuthUserState, "role" | "mfaEnabled">): boolean {
  return !live.mfaEnabled && mfaRequiredForRole(live.role);
}

/**
 * The only routes a restricted account may reach, matched on the registered
 * route pattern (method + URL incl. prefix), never on the raw request path.
 *   - temporary password (SEC-PW-TEMP-001): read itself, change the password,
 *     sign out.
 *   - MFA enrollment (SEC-MFA-POLICY-001): additionally re-authenticate,
 *     enroll/activate a device, and unlock the idle screen.
 */
const PASSWORD_CHANGE_ROUTES = [
  "GET /api/v1/users/me",
  "POST /api/v1/auth/change-password",
  "POST /api/v1/auth/logout-all",
];
const RESTRICTED_ROUTES: Record<AccountRestriction, ReadonlySet<string>> = {
  password_change_required: new Set(PASSWORD_CHANGE_ROUTES),
  mfa_enrollment_required: new Set([
    ...PASSWORD_CHANGE_ROUTES,
    "POST /api/v1/auth/step-up",
    "POST /api/v1/auth/mfa/enroll",
    "POST /api/v1/auth/mfa/activate",
    "POST /api/v1/auth/verify-password",
  ]),
};

export function isRouteAllowedWhileRestricted(r: AccountRestriction, method: string, routeUrl: string | undefined): boolean {
  return routeUrl !== undefined && RESTRICTED_ROUTES[r].has(`${method.toUpperCase()} ${routeUrl}`);
}

export function makeAuthMiddleware(jwt: JwtService, users: AuthUserSource) {
  return async function jwtAuth(req: FastifyRequest, reply: FastifyReply) {
    const header = req.headers.authorization;
    if (!header) {
      return reply.code(401).send({ error: { code: "missing_token", message: "Authorization header missing" } });
    }
    if (!header.startsWith("Bearer ")) {
      return reply.code(401).send({ error: { code: "malformed_token", message: "must be Bearer token" } });
    }
    const token = header.slice("Bearer ".length);
    // AWM-SEC-021 / SEC-SESSION-001/002: one shared check — verify the token AND
    // require current account state (not deleted/disabled/locked) AND a matching
    // auth_version. The live DB role replaces the (possibly stale) token role so a
    // downgraded/moved user cannot exercise an old privilege until token expiry.
    try {
      const route = { method: req.method, url: req.routeOptions?.url };
      const { claims, live } = await verifyCurrentAccessToken(jwt, users, token, { route });
      claims.role = live.role;
      req.auth = claims;
    } catch (e) {
      // SEC-MFA-POLICY-001 / SEC-PW-TEMP-001: valid session, but the account
      // must first enroll MFA or replace its temporary password. 403 (not 401)
      // so the client does not try to refresh, and can route the user there.
      if (e instanceof AuthStateError && (e.code === "mfa_enrollment_required" || e.code === "password_change_required")) {
        return reply.code(403).send({ error: { code: e.code, message: e.message } });
      }
      // Distinguish a bad/expired token (invalid_token) from a valid token whose
      // account state is no longer acceptable (session_invalidated), preserving
      // the existing response contract.
      if (e instanceof AuthStateError) {
        return reply.code(401).send({ error: { code: "session_invalidated", message: "your session is no longer valid" } });
      }
      return reply.code(401).send({ error: { code: "invalid_token", message: "token is invalid or expired" } });
    }
  };
}

export function requireRole(...allowed: string[]) {
  const set = new Set(allowed);
  return async function (req: FastifyRequest, reply: FastifyReply) {
    if (!req.auth) {
      return reply.code(401).send({ error: { code: "unauthenticated", message: "" } });
    }
    if (!set.has(req.auth.role)) {
      return reply.code(403).send({ error: { code: "forbidden", message: "insufficient privileges" } });
    }
  };
}

/** Require a specific RBAC permission for the authenticated user's role. */
export function requirePermission(perm: Permission) {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    if (!req.auth) {
      return reply.code(401).send({ error: { code: "unauthenticated", message: "" } });
    }
    if (!can(req.auth.role, perm)) {
      return reply.code(403).send({ error: { code: "forbidden", message: "insufficient permissions" } });
    }
  };
}

/**
 * Gate mutating requests (POST/PUT/PATCH/DELETE) behind `resources:write`.
 * Safe (GET/HEAD/OPTIONS) requests pass through so read-only roles can browse.
 */
export function requireWrite() {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const m = req.method.toUpperCase();
    if (m === "GET" || m === "HEAD" || m === "OPTIONS") return;
    if (!req.auth) {
      return reply.code(401).send({ error: { code: "unauthenticated", message: "" } });
    }
    if (!can(req.auth.role, "resources:write")) {
      return reply.code(403).send({ error: { code: "forbidden", message: "your role is read-only" } });
    }
  };
}
