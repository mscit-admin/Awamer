import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { AuditRepository } from "../repos/otherRepos.js";
import type { JwtService } from "../jwt/index.js";
import { makeAuthMiddleware, requirePermission } from "../middleware/auth.js";

interface Deps {
  audit: AuditRepository;
  jwt: JwtService;
}

/** Audit-log read API. Requires the `audit:read` permission (admin / auditor). */
export function makeAuditRoutes(deps: Deps): FastifyPluginAsync {
  return async function (app: FastifyInstance) {
    app.addHook("preHandler", makeAuthMiddleware(deps.jwt));
    app.addHook("preHandler", requirePermission("audit:read"));

    const query = z.object({
      limit: z.coerce.number().int().min(1).max(200).default(50),
      offset: z.coerce.number().int().min(0).default(0),
      action: z.string().max(64).optional(),
      success: z.enum(["true", "false"]).optional(),
      user_id: z.string().uuid().optional(),
    });

    app.get("/", async (req, reply) => {
      const parsed = query.safeParse(req.query);
      if (!parsed.success) {
        return reply.code(400).send({ error: { code: "validation_failed", message: parsed.error.message } });
      }
      const { limit, offset, action, success, user_id } = parsed.data;
      const { entries, total } = await deps.audit.list({
        limit, offset, action,
        success: success === undefined ? undefined : success === "true",
        userId: user_id,
      });
      return reply.send({
        data: entries.map((e) => ({
          id: e.id,
          timestamp: e.timestamp,
          user_id: e.userId,
          username: e.username,
          action: e.action,
          resource_type: e.resourceType,
          resource_id: e.resourceId,
          ip_address: e.ipAddress,
          success: e.success,
          details: e.details,
        })),
        total, limit, offset,
      });
    });
  };
}
