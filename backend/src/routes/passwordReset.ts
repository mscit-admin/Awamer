/**
 * Public forgot/reset-password endpoints.
 *
 *   POST /api/v1/auth/forgot-password  { email }            → always 200
 *   POST /api/v1/auth/reset-password   { token, password }  → set new password
 */
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { PasswordResetUseCase } from "../usecases/passwordReset.js";
import { DomainError } from "../domain/index.js";

interface Deps {
  reset: PasswordResetUseCase;
}

// SEC-RESET-001: request headers (Origin/Referer/Host/X-Forwarded-*) are
// deliberately NOT used to build reset links. The trusted base URL is resolved
// inside the usecase from APP_PUBLIC_BASE_URL / app_base_url only.

export function makePasswordResetRoutes(deps: Deps): FastifyPluginAsync {
  return async function (app: FastifyInstance) {
    const forgotSchema = z.object({ email: z.string().email() });

    app.post("/forgot-password", async (req, reply) => {
      const parsed = forgotSchema.safeParse(req.body);
      // Always respond 200 — never reveal whether the email exists (and never
      // reveal whether reset is unavailable). Errors are swallowed here.
      if (parsed.success) {
        try { await deps.reset.requestReset(parsed.data.email); } catch { /* swallow */ }
      }
      return reply.send({ ok: true });
    });

    const resetSchema = z.object({
      token: z.string().min(10).max(512),
      password: z.string().min(8).max(256),
    });

    app.post("/reset-password", async (req, reply) => {
      const parsed = resetSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: { code: "validation_failed", message: parsed.error.message } });
      }
      try {
        await deps.reset.resetPassword(parsed.data.token, parsed.data.password);
        return reply.send({ ok: true });
      } catch (e) {
        if (e instanceof DomainError) {
          return reply.code(400).send({ error: { code: e.code, message: e.message } });
        }
        throw e;
      }
    });
  };
}
