/**
 * SMTP configuration (Administration). Installation-wide infrastructure, so
 * it is gated by `settings:manage` (Super Admin only — SEC-INSTANCE-001): the
 * relay carries EVERY tenant's password-reset links, so a company admin who
 * could repoint it would capture reset tokens for users in other companies.
 *
 *   GET  /api/v1/admin/smtp        current config (never the password)
 *   PUT  /api/v1/admin/smtp        update config
 *   POST /api/v1/admin/smtp/test   { to } — send a test email
 */
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { JwtService } from "../jwt/index.js";
import type { MailService } from "../email/mailer.js";
import { makeAuthMiddleware, requirePermission } from "../middleware/auth.js";
import type { AuditRepository } from "../repos/otherRepos.js";

interface Deps {
  mailer: MailService;
  jwt: JwtService;
  users: import("../repos/userRepo.js").UserRepository;
  audit: AuditRepository;
}

export function makeSmtpRoutes(deps: Deps): FastifyPluginAsync {
  return async function (app: FastifyInstance) {
    app.addHook("preHandler", makeAuthMiddleware(deps.jwt, deps.users));
    app.addHook("preHandler", requirePermission("settings:manage"));

    app.get("/", async (_req, reply) => {
      return reply.send(await deps.mailer.getPublicConfig());
    });

    const putSchema = z.object({
      host: z.string().max(255).nullable().optional(),
      port: z.coerce.number().int().min(1).max(65535).nullable().optional(),
      secure: z.boolean().nullable().optional(),
      user: z.string().max(255).nullable().optional(),
      password: z.string().max(512).nullable().optional(),
      from: z.string().max(320).nullable().optional(),
      base_url: z.string().max(512).nullable().optional(),
      allow_invalid_certs: z.boolean().nullable().optional(),
      reset_ttl_minutes: z.coerce.number().int().min(5).max(1440).nullable().optional(),
      reset_subject: z.string().max(200).nullable().optional(),
      reset_body: z.string().max(5000).nullable().optional(),
    });

    app.put("/", async (req, reply) => {
      const parsed = putSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: { code: "validation_failed", message: parsed.error.message } });
      }
      await deps.mailer.update(parsed.data);
      // Field NAMES only — never the password or other values.
      await deps.audit.log({
        userId: req.auth!.sub, action: "config_change", resourceType: "smtp", success: true,
        ipAddress: req.ip, details: { op: "smtp_update", fields: Object.keys(parsed.data).filter((k) => (parsed.data as Record<string, unknown>)[k] !== undefined) },
      });
      return reply.send(await deps.mailer.getPublicConfig());
    });

    const testSchema = z.object({ to: z.string().email() });
    app.post("/test", async (req, reply) => {
      const parsed = testSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: { code: "validation_failed", message: parsed.error.message } });
      }
      try {
        await deps.mailer.sendTest(parsed.data.to);
        return reply.send({ ok: true });
      } catch (e) {
        return reply.code(400).send({ error: { code: "smtp_error", message: e instanceof Error ? e.message : "send failed" } });
      }
    });
  };
}
