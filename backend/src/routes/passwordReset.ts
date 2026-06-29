/**
 * Public forgot/reset-password endpoints.
 *
 *   POST /api/v1/auth/forgot-password  { email }            → always 200
 *   POST /api/v1/auth/reset-password   { token, password }  → set new password
 */
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import type { PasswordResetUseCase } from "../usecases/passwordReset.js";
import { DomainError } from "../domain/index.js";

interface Deps {
  reset: PasswordResetUseCase;
}

function originOf(req: FastifyRequest): string {
  // The Origin header (sent on this POST) carries the full scheme+host+port the
  // user actually loaded — the most reliable source behind a proxy on a
  // non-default port. Referer is the next best. Forwarded host (often portless)
  // is the last resort.
  const origin = req.headers.origin;
  if (origin && /^https?:\/\//.test(origin)) return origin;
  const ref = req.headers.referer;
  if (ref) { try { return new URL(ref).origin; } catch { /* ignore */ } }
  const proto = (req.headers["x-forwarded-proto"] as string)?.split(",")[0] || req.protocol || "https";
  const host = (req.headers["x-forwarded-host"] as string) || req.headers.host || "";
  return host ? `${proto}://${host}` : "";
}

export function makePasswordResetRoutes(deps: Deps): FastifyPluginAsync {
  return async function (app: FastifyInstance) {
    const forgotSchema = z.object({ email: z.string().email() });

    app.post("/forgot-password", async (req, reply) => {
      const parsed = forgotSchema.safeParse(req.body);
      // Always respond 200 — never reveal whether the email exists.
      if (parsed.success) {
        try { await deps.reset.requestReset(parsed.data.email, originOf(req)); } catch { /* swallow */ }
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
