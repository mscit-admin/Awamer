/**
 * Session settings (Administration) — instance-wide SSH session behavior.
 * Installation-wide, so gated by `settings:manage` (Super Admin only —
 * SEC-INSTANCE-001); a company admin must not change other tenants' policy.
 *
 *   GET /api/v1/admin/session-settings
 *   PUT /api/v1/admin/session-settings   { ssh_idle_timeout_minutes }
 */
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { JwtService } from "../jwt/index.js";
import type { AppSettingsRepository } from "../repos/appSettings.js";
import { makeAuthMiddleware, requirePermission } from "../middleware/auth.js";
import type { AuditRepository } from "../repos/otherRepos.js";

interface Deps {
  settings: AppSettingsRepository;
  jwt: JwtService;
  users: import("../repos/userRepo.js").UserRepository;
  audit: AuditRepository;
}

const KEY_IDLE = "ssh_idle_timeout_minutes";

export function makeSessionSettingsRoutes(deps: Deps): FastifyPluginAsync {
  return async function (app: FastifyInstance) {
    app.addHook("preHandler", makeAuthMiddleware(deps.jwt, deps.users));
    app.addHook("preHandler", requirePermission("settings:manage"));

    app.get("/", async (_req, reply) => {
      const s = await deps.settings.getMany([KEY_IDLE]);
      return reply.send({ ssh_idle_timeout_minutes: s[KEY_IDLE] ? Number(s[KEY_IDLE]) : 0 });
    });

    const putSchema = z.object({
      // 0 = no idle timeout; otherwise 1..1440 minutes (24h max).
      ssh_idle_timeout_minutes: z.coerce.number().int().min(0).max(1440),
    });

    app.put("/", async (req, reply) => {
      const parsed = putSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: { code: "validation_failed", message: parsed.error.message } });
      }
      const v = parsed.data.ssh_idle_timeout_minutes;
      await deps.settings.set(KEY_IDLE, v > 0 ? String(v) : null);
      await deps.audit.log({
        userId: req.auth!.sub, action: "config_change", resourceType: "session_settings", success: true,
        ipAddress: req.ip, details: { op: "session_settings_update", ssh_idle_timeout_minutes: v },
      });
      return reply.send({ ssh_idle_timeout_minutes: v });
    });
  };
}
