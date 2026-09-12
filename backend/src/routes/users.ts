import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { userView } from "./auth.js";
import { DomainError } from "../domain/index.js";
import type { UserRepository } from "../repos/userRepo.js";
import type { MFAUseCase } from "../usecases/mfa.js";
import type { ChangePasswordUseCase } from "../usecases/changePassword.js";
import { makeAuthMiddleware } from "../middleware/auth.js";
import type { JwtService } from "../jwt/index.js";

interface Deps {
  users: UserRepository;
  mfa: MFAUseCase;
  changePassword: ChangePasswordUseCase;
  jwt: JwtService;
}

export function makeAuthedRoutes(deps: Deps): FastifyPluginAsync {
  return async function (app: FastifyInstance) {
    app.addHook("preHandler", makeAuthMiddleware(deps.jwt, deps.users));

    // ---------- /users/me -----------------------------------------------
    app.get("/users/me", async (req, reply) => {
      try {
        const user = await deps.users.getById(req.auth!.sub);
        return reply.send(userView(user));
      } catch (e) {
        if (e instanceof DomainError) {
          return reply.code(404).send({ error: { code: e.code, message: e.message } });
        }
        throw e;
      }
    });

    const updateMeSchema = z.object({
      full_name: z.string().max(120).optional(),
      email: z.string().email().optional(),
    });

    app.patch("/users/me", async (req, reply) => {
      const parsed = updateMeSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: { code: "validation_failed", message: parsed.error.message } });
      }
      const user = await deps.users.getById(req.auth!.sub);
      if (parsed.data.full_name !== undefined) user.fullName = parsed.data.full_name;
      if (parsed.data.email !== undefined) user.email = parsed.data.email;
      await deps.users.update(user);
      return reply.send(userView(user));
    });

    // ---------- User directory (minimal, for share pickers) -------------
    // Scoped to the caller's company so you can only share with people in your
    // own organization (tenant isolation).
    app.get("/users/directory", async (req, reply) => {
      const me = await deps.users.getById(req.auth!.sub);
      const { users } = await deps.users.list(500, 0, me.companyId);
      return reply.send({
        data: users.map((u) => ({ id: u.id, username: u.username, full_name: u.fullName })),
      });
    });

    // ---------- Self-service password change ----------------------------
    const changePwSchema = z.object({
      current_password: z.string().min(1),
      new_password: z.string().min(1),
    });

    app.post("/auth/change-password", async (req, reply) => {
      const parsed = changePwSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: { code: "validation_failed", message: parsed.error.message } });
      }
      try {
        await deps.changePassword.execute(
          req.auth!.sub,
          parsed.data.current_password,
          parsed.data.new_password,
        );
        return reply.send({ status: "ok" });
      } catch (e) {
        if (e instanceof DomainError) {
          const status =
            e.code === "invalid_credentials" ? 401 :
            e.code === "weak_password" ? 422 :
            e.code === "password_unchanged" ? 409 : 400;
          return reply.code(status).send({ error: { code: e.code, message: e.message } });
        }
        throw e;
      }
    });

    // ---------- Verify password (idle-lock unlock) ----------------------
    const verifySchema = z.object({ password: z.string().min(1).max(256) });
    app.post("/auth/verify-password", async (req, reply) => {
      const parsed = verifySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: { code: "validation_failed", message: parsed.error.message } });
      }
      const ok = await deps.changePassword.verify(req.auth!.sub, parsed.data.password);
      if (!ok) return reply.code(401).send({ error: { code: "invalid_credentials", message: "incorrect password" } });
      return reply.send({ ok: true });
    });

    // ---------- MFA enroll/activate -------------------------------------
    const enrollSchema = z.object({
      device_name: z.string().min(1).max(64).default("Authenticator"),
    });

    app.post("/auth/mfa/enroll", async (req, reply) => {
      const parsed = enrollSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: { code: "validation_failed", message: parsed.error.message } });
      }
      const r = await deps.mfa.enroll(req.auth!.sub, parsed.data.device_name);
      return reply.send({
        device_id: r.deviceId,
        secret: r.secret,
        otpauth_url: r.otpauthUrl,
        qr_code_png: r.qrPngBase64,
      });
    });

    const activateSchema = z.object({
      device_id: z.string().uuid(),
      code: z.string().regex(/^\d{6}$/),
    });

    app.post("/auth/mfa/activate", async (req, reply) => {
      const parsed = activateSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: { code: "validation_failed", message: parsed.error.message } });
      }
      try {
        await deps.mfa.verifyAndActivate(req.auth!.sub, parsed.data.device_id, parsed.data.code);
        return reply.code(204).send();
      } catch (e) {
        if (e instanceof DomainError) {
          return reply.code(400).send({ error: { code: e.code, message: e.message } });
        }
        throw e;
      }
    });

    // -----------------------------------------------------------------
    // Disable MFA (1.3.1)
    // Requires the current password as a re-authentication step so a
    // stolen access token alone cannot weaken account security.
    // -----------------------------------------------------------------
    const disableSchema = z.object({
      password: z.string().min(1),
    });

    app.post("/auth/mfa/disable", async (req, reply) => {
      const parsed = disableSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: { code: "validation_failed", message: parsed.error.message } });
      }
      try {
        await deps.mfa.disable(req.auth!.sub, parsed.data.password);
        return reply.code(204).send();
      } catch (e) {
        if (e instanceof DomainError) {
          // invalid_credentials maps to 401, anything else stays 400
          const status = e.code === "invalid_credentials" ? 401 : 400;
          return reply.code(status).send({ error: { code: e.code, message: e.message } });
        }
        throw e;
      }
    });
  };
}
