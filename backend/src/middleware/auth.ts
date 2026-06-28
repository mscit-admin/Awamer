import type { FastifyReply, FastifyRequest } from "fastify";
import type { JwtService, VerifiedClaims } from "../jwt/index.js";
import { can, type Permission } from "../domain/permissions.js";

declare module "fastify" {
  interface FastifyRequest {
    auth?: VerifiedClaims;
  }
}

export function makeAuthMiddleware(jwt: JwtService) {
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
