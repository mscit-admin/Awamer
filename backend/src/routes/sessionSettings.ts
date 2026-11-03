/**
 * Session settings (Administration) — instance-wide SSH session behavior.
 * Installation-wide, so gated by `settings:manage` (Super Admin only —
 * SEC-INSTANCE-001); a company admin must not change other tenants' policy.
 *
 * Also holds the installation-wide MFA policy (SEC-MFA-POLICY-001): which
 * roles must have two-factor authentication.
 *
 *   GET /api/v1/admin/session-settings
 *   PUT /api/v1/admin/session-settings   { ssh_idle_timeout_minutes?, mfa_required_roles? }
 */
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { JwtService } from "../jwt/index.js";
import type { AppSettingsRepository } from "../repos/appSettings.js";
import { makeAuthMiddleware, requirePermission } from "../middleware/auth.js";
import type { AuditRepository } from "../repos/otherRepos.js";
import { MFA_POLICY_KEY, mfaRequiredRoles, setMfaRequiredRoles } from "../domain/mfaPolicy.js";

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

    const view = async () => {
      const s = await deps.settings.getMany([KEY_IDLE]);
      return {
        ssh_idle_timeout_minutes: s[KEY_IDLE] ? Number(s[KEY_IDLE]) : 0,
        mfa_required_roles: mfaRequiredRoles(),
      };
    };

    app.get("/", async (_req, reply) => reply.send(await view()));

    const putSchema = z.object({
      // 0 = no idle timeout; otherwise 1..1440 minutes (24h max).
      ssh_idle_timeout_minutes: z.coerce.number().int().min(0).max(1440).optional(),
      // Role keys whose members must enroll MFA. [] = no role requires it.
      mfa_required_roles: z.array(z.string().regex(/^[a-z0-9_]{1,64}$/)).max(200).optional(),
    }).refine((v) => v.ssh_idle_timeout_minutes !== undefined || v.mfa_required_roles !== undefined,
      "nothing to update");

    app.put("/", async (req, reply) => {
      const parsed = putSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: { code: "validation_failed", message: parsed.error.message } });
      }
      const { ssh_idle_timeout_minutes: v, mfa_required_roles: roles } = parsed.data;
      if (v !== undefined) {
        await deps.settings.set(KEY_IDLE, v > 0 ? String(v) : null);
        await deps.audit.log({
          userId: req.auth!.sub, action: "config_change", resourceType: "session_settings", success: true,
          ipAddress: req.ip, details: { op: "session_settings_update", ssh_idle_timeout_minutes: v },
        });
      }
      if (roles !== undefined) {
        const next = [...new Set(roles)].sort();
        await deps.settings.set(MFA_POLICY_KEY, JSON.stringify(next));
        setMfaRequiredRoles(next);
        await deps.audit.log({
          userId: req.auth!.sub, action: "config_change", resourceType: "session_settings", success: true,
          ipAddress: req.ip, details: { op: "mfa_policy_update", mfa_required_roles: next },
        });
      }
      return reply.send(await view());
    });
  };
}
