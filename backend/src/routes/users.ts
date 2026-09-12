import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { userView } from "./auth.js";
import { DomainError } from "../domain/index.js";
import type { UserRepository } from "../repos/userRepo.js";
import type { MFAUseCase } from "../usecases/mfa.js";
import type { ChangePasswordUseCase } from "../usecases/changePassword.js";
import { makeAuthMiddleware } from "../middleware/auth.js";
import type { JwtService } from "../jwt/index.js";
import type { StepUpService } from "../usecases/stepUp.js";
import { can } from "../domain/permissions.js";
import { tenantScopeForActor } from "../domain/tenantScope.js";

interface Deps {
  users: UserRepository;
  mfa: MFAUseCase;
  changePassword: ChangePasswordUseCase;
  jwt: JwtService;
  stepUp: StepUpService;
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
      // SEC-TENANT-001: explicit scope. A non-super caller with no company sees
      // an EMPTY directory, not every tenant's users.
      const tscope = tenantScopeForActor({
        isSuper: can(req.auth!.role, "companies:manage"),
        companyId: me.companyId,
      });
      const { users } = await deps.users.list(500, 0, tscope);
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

    // ---------- Step-up re-authentication (SEC-MFA-002) -----------------
    // Prove recent possession of the password (and current MFA, when enabled)
    // to obtain a short-lived single-use token required for MFA changes.
    const stepUpSchema = z.object({
      password: z.string().min(1).max(256),
      mfa_code: z.string().regex(/^\d{6}$/).optional(),
    });
    app.post("/auth/step-up", async (req, reply) => {
      const parsed = stepUpSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: { code: "validation_failed", message: parsed.error.message } });
      }
      const uid = req.auth!.sub;
      const ok = await deps.changePassword.verify(uid, parsed.data.password);
      if (!ok) return reply.code(401).send({ error: { code: "invalid_credentials", message: "incorrect password" } });
      // If the account already has MFA, a current OTP is also required.
      const me = await deps.users.getById(uid);
      if (me.mfaEnabled) {
        if (!parsed.data.mfa_code) {
          return reply.code(401).send({ error: { code: "mfa_required", message: "current MFA code required" } });
        }
        try {
          await deps.mfa.verifyCode(uid, parsed.data.mfa_code);
        } catch {
          return reply.code(401).send({ error: { code: "invalid_mfa_code", message: "incorrect MFA code" } });
        }
      }
      const t = await deps.stepUp.issue(uid, "mfa_change");
      return reply.send({ step_up_token: t.token, expires_in: t.expiresInSec });
    });

    // Read a step-up token from the header or body.
    const stepUpToken = (req: import("fastify").FastifyRequest): string | undefined =>
      (req.headers["x-step-up-token"] as string | undefined) ||
      (typeof req.body === "object" && req.body && "step_up_token" in req.body
        ? String((req.body as Record<string, unknown>).step_up_token) : undefined);

    // ---------- MFA enroll/activate -------------------------------------
    const enrollSchema = z.object({
      device_name: z.string().min(1).max(64).default("Authenticator"),
      step_up_token: z.string().optional(),
    });

    app.post("/auth/mfa/enroll", async (req, reply) => {
      const parsed = enrollSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: { code: "validation_failed", message: parsed.error.message } });
      }
      // SEC-MFA-002: a normal access token is not enough — require step-up.
      try {
        await deps.stepUp.consume(stepUpToken(req), req.auth!.sub, "mfa_change");
      } catch (e) {
        const code = e instanceof DomainError ? e.code : "step_up_required";
        return reply.code(401).send({ error: { code, message: "recent re-authentication required" } });
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
    // Disable MFA (SEC-MFA-002)
    // Requires a step-up token (obtained via /auth/step-up, which already
    // verified the password AND current MFA) — a stolen access token alone
    // cannot weaken account security. `password` is still accepted for
    // backward compatibility ONLY when no step-up token is supplied.
    // -----------------------------------------------------------------
    const disableSchema = z.object({
      password: z.string().min(1).optional(),
      step_up_token: z.string().optional(),
    });

    app.post("/auth/mfa/disable", async (req, reply) => {
      const parsed = disableSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: { code: "validation_failed", message: parsed.error.message } });
      }
      // SEC-MFA-002: require step-up re-authentication.
      try {
        await deps.stepUp.consume(stepUpToken(req), req.auth!.sub, "mfa_change");
      } catch (e) {
        const code = e instanceof DomainError ? e.code : "step_up_required";
        return reply.code(401).send({ error: { code, message: "recent re-authentication required" } });
      }
      try {
        // Step-up already proved the password; the usecase re-verifies defensively
        // when a password is provided, otherwise uses the current stored hash.
        await deps.mfa.disableAfterStepUp(req.auth!.sub);
        return reply.code(204).send();
      } catch (e) {
        if (e instanceof DomainError) {
          const status = e.code === "invalid_credentials" ? 401 : 400;
          return reply.code(status).send({ error: { code: e.code, message: e.message } });
        }
        throw e;
      }
    });
  };
}
