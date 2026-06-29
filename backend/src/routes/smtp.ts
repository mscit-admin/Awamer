/**
 * SMTP configuration (Administration). Admin / super_admin only — instance
 * infrastructure, gated by role like Branding.
 *
 *   GET  /api/v1/admin/smtp        current config (never the password)
 *   PUT  /api/v1/admin/smtp        update config
 *   POST /api/v1/admin/smtp/test   { to } — send a test email
 */
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { JwtService } from "../jwt/index.js";
import type { MailService } from "../email/mailer.js";
import { makeAuthMiddleware, requireRole } from "../middleware/auth.js";

interface Deps {
  mailer: MailService;
  jwt: JwtService;
}

export function makeSmtpRoutes(deps: Deps): FastifyPluginAsync {
  return async function (app: FastifyInstance) {
    app.addHook("preHandler", makeAuthMiddleware(deps.jwt));
    app.addHook("preHandler", requireRole("admin", "super_admin"));

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
    });

    app.put("/", async (req, reply) => {
      const parsed = putSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: { code: "validation_failed", message: parsed.error.message } });
      }
      await deps.mailer.update(parsed.data);
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
