import type { FastifyReply, FastifyRequest } from "fastify";
import type { JwtService, VerifiedClaims } from "../jwt/index.js";
import { can, type Permission } from "../domain/permissions.js";

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
    try {
      req.auth = await jwt.verifyAccess(token);
    } catch {
      return reply.code(401).send({ error: { code: "invalid_token", message: "token is invalid or expired" } });
    }
    // AWM-SEC-021: authorization must reflect the CURRENT account state, never
    // the stale token. Load the live user, reject deleted/disabled/locked
    // accounts immediately, and replace the token role with the live DB role so
    // a downgraded/moved user cannot exercise an old privilege until token expiry.
    try {
      const live = await assertAuthState(users, req.auth.sub);
      req.auth.role = live.role;
    } catch {
      return reply.code(401).send({ error: { code: "session_invalidated", message: "your session is no longer valid" } });
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
