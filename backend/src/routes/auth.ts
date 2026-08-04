import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { LoginUseCase, completeMFALogin } from "../usecases/login.js";
import type { RefreshUseCase } from "../usecases/refresh.js";
import type { MFAUseCase } from "../usecases/mfa.js";
import type { UserRepository } from "../repos/userRepo.js";
import type { JwtService } from "../jwt/index.js";
import type { User } from "../domain/index.js";
import { DomainError } from "../domain/index.js";
import { permissionsFor } from "../domain/permissions.js";

interface Deps {
  login: LoginUseCase;
  refresh: RefreshUseCase;
  mfa: MFAUseCase;
  users: UserRepository;
  jwt: JwtService;
  /** Per-IP requests/minute for the auth endpoints (stricter than the global API limit). */
  loginRateMax: number;
}

export function userView(u: User) {
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    full_name: u.fullName,
    role: u.role,
    permissions: permissionsFor(u.role),
    is_active: u.isActive,
    is_locked: u.isLocked,
    mfa_enabled: u.mfaEnabled,
    company_id: u.companyId,
    org_unit_id: u.orgUnitId,
    last_login_at: u.lastLoginAt,
    created_at: u.createdAt,
  };
}

export function makeAuthRoutes(deps: Deps): FastifyPluginAsync {
  return async function (app: FastifyInstance) {
    // Stricter per-IP throttle for the credential-taking endpoints than the
    // global API limit — this is the online password-guessing surface.
    const authRateLimit = { config: { rateLimit: { max: deps.loginRateMax, timeWindow: "1 minute" } } };

    // ----- POST /login --------------------------------------------------
    const loginSchema = z.object({
      username: z.string().min(3).max(64),
      password: z.string().min(8).max(256),
    });

    app.post("/login", authRateLimit, async (req, reply) => {
      const parsed = loginSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: { code: "validation_failed", message: parsed.error.message } });
      }
      try {
        const result = await deps.login.execute({
          username: parsed.data.username,
          password: parsed.data.password,
          ip: req.ip,
          ua: String(req.headers["user-agent"] ?? ""),
        });
        if (result.mfaRequired) {
          // Look up the user so the client can show their name on the MFA prompt.
          // (Returned without sensitive fields via userView.)
          let userPayload: ReturnType<typeof userView> | undefined;
          try {
            const u = await deps.users.getByUsername(parsed.data.username);
            userPayload = userView(u);
          } catch { /* never block MFA flow on this */ }
          return reply.send({
            mfa_required: true,
            mfa_token: result.mfaToken,
            user: userPayload,
          });
        }
        return reply.send({
          access_token: result.accessToken,
          refresh_token: result.refreshToken,
          token_type: "Bearer",
          expires_at: result.expiresAt,
          user: result.user ? userView(result.user) : undefined,
        });
      } catch (e) {
        if (e instanceof DomainError) {
          const status = e.code === "account_inactive" || e.code === "account_locked" ? 403 : 401;
          return reply.code(status).send({ error: { code: e.code, message: e.message } });
        }
        req.log.error({ err: e }, "login failed unexpectedly");
        return reply.code(500).send({ error: { code: "internal_error", message: "" } });
      }
    });

    // ----- POST /mfa/verify --------------------------------------------
    const mfaVerifySchema = z.object({
      code: z.string().regex(/^\d{6}$/, "code must be 6 digits"),
    });

    app.post("/mfa/verify", authRateLimit, async (req, reply) => {
      const auth = req.headers.authorization;
      if (!auth?.startsWith("Bearer ")) {
        return reply.code(401).send({ error: { code: "missing_mfa_token", message: "" } });
      }
      const mfaToken = auth.slice("Bearer ".length);

      let claims;
      try { claims = await deps.jwt.verifyAccess(mfaToken); }
      catch { return reply.code(401).send({ error: { code: "invalid_mfa_token", message: "" } }); }

      if (claims.role !== "mfa_pending") {
        return reply.code(401).send({ error: { code: "invalid_mfa_token", message: "" } });
      }

      const parsed = mfaVerifySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: { code: "validation_failed", message: parsed.error.message } });
      }

      try {
        await deps.mfa.verifyCode(claims.sub, parsed.data.code);
      } catch {
        return reply.code(401).send({ error: { code: "invalid_code", message: "invalid mfa code" } });
      }

      const result = await completeMFALogin(deps.login, deps.users, claims.sub, req.ip, String(req.headers["user-agent"] ?? ""));
      return reply.send({
        access_token: result.accessToken,
        refresh_token: result.refreshToken,
        token_type: "Bearer",
        expires_at: result.expiresAt,
        user: result.user ? userView(result.user) : undefined,
      });
    });

    // ----- POST /refresh -----------------------------------------------
    const refreshSchema = z.object({ refresh_token: z.string().min(1) });

    app.post("/refresh", authRateLimit, async (req, reply) => {
      const parsed = refreshSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: { code: "validation_failed", message: parsed.error.message } });
      }
      try {
        const r = await deps.refresh.execute(parsed.data.refresh_token, req.ip, String(req.headers["user-agent"] ?? ""));
        return reply.send({
          access_token: r.accessToken,
          refresh_token: r.refreshToken,
          token_type: "Bearer",
          expires_at: r.expiresAt,
        });
      } catch {
        return reply.code(401).send({ error: { code: "invalid_refresh", message: "refresh token invalid or reused" } });
      }
    });

    // ----- POST /logout -------------------------------------------------
    app.post("/logout", async (_req, reply) => {
      // Phase 1: best-effort; the client clears its tokens.
      return reply.code(204).send();
    });
  };
}
