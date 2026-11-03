import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { LoginUseCase, completeMFALogin } from "../usecases/login.js";
import type { RefreshUseCase } from "../usecases/refresh.js";
import type { MFAUseCase } from "../usecases/mfa.js";
import type { UserRepository } from "../repos/userRepo.js";
import type { JwtService } from "../jwt/index.js";
import type { User } from "../domain/index.js";
import { DomainError, isAccountLocked } from "../domain/index.js";
import { permissionsFor } from "../domain/permissions.js";
import { makeAuthMiddleware } from "../middleware/auth.js";
import { mfaRequiredForRole } from "../domain/mfaPolicy.js";
import { isWebClient, setRefreshCookie, clearRefreshCookie, readRefreshCookie } from "./authCookies.js";
import type { FastifyReply, FastifyRequest } from "fastify";

interface Deps {
  login: LoginUseCase;
  refresh: RefreshUseCase;
  mfa: MFAUseCase;
  users: UserRepository;
  jwt: JwtService;
  /** Per-IP requests/minute for the auth endpoints (stricter than the global API limit). */
  loginRateMax: number;
  /** Max-Age for the browser HttpOnly refresh cookie (SEC-019). */
  refreshCookieMaxAgeSec: number;
  /** Live remote sessions to terminate on logout-all (SEC-LOGOUT-ALL-001). */
  sessions?: Pick<import("../session/activeSessions.js").ActiveSessionManager, "revokeUser">;
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
    // SEC-MFA-POLICY-001: the role must have MFA (so it cannot be disabled);
    // when not yet enrolled the client routes the user to enrollment.
    mfa_policy_required: mfaRequiredForRole(u.role),
    // SEC-PW-TEMP-001: the password was set by an admin; replace it first.
    password_change_required: u.passwordMustChange,
    mfa_enrollment_required: !u.mfaEnabled && mfaRequiredForRole(u.role),
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

    // SEC-019: emit the token pair. For the browser SPA (X-Awamer-Client: web)
    // the refresh token goes into an HttpOnly cookie and is withheld from the
    // JSON body (JS can never read it). The Tauri client (no header) gets the
    // refresh token in the body for its OS keyring — unchanged.
    interface TokenResult { accessToken?: string; refreshToken?: string; expiresAt?: Date }
    const emitTokens = (req: FastifyRequest, reply: FastifyReply, result: TokenResult, extra: Record<string, unknown> = {}) => {
      const web = isWebClient(req);
      if (web && result.refreshToken) setRefreshCookie(reply, result.refreshToken, deps.refreshCookieMaxAgeSec);
      return reply.send({
        access_token: result.accessToken,
        refresh_token: web ? undefined : result.refreshToken,
        token_type: "Bearer",
        expires_at: result.expiresAt,
        ...extra,
      });
    };

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
        return emitTokens(req, reply, result, { user: result.user ? userView(result.user) : undefined });
      } catch (e) {
        if (e instanceof DomainError) {
          const status = e.code === "account_inactive" || e.code === "account_locked" || e.code === "temporary_password_expired" ? 403 : 401;
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
      try { claims = await deps.jwt.verifyMfaPending(mfaToken); }
      catch { return reply.code(401).send({ error: { code: "invalid_mfa_token", message: "" } }); }

      if (claims.role !== "mfa_pending") {
        return reply.code(401).send({ error: { code: "invalid_mfa_token", message: "" } });
      }

      const parsed = mfaVerifySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: { code: "validation_failed", message: parsed.error.message } });
      }

      // SEC-MFA-BRUTE-001: a (temporarily) locked or disabled account gets no
      // further code guesses, whatever IP they come from.
      let pending;
      try { pending = await deps.users.getById(claims.sub); }
      catch { return reply.code(401).send({ error: { code: "invalid_mfa_token", message: "" } }); }
      if (!pending.isActive) return reply.code(403).send({ error: { code: "account_inactive", message: "account is disabled" } });
      if (isAccountLocked(pending, new Date())) {
        return reply.code(403).send({ error: { code: "account_locked", message: "too many failed attempts; try again later" } });
      }

      const ua = String(req.headers["user-agent"] ?? "");
      try {
        await deps.mfa.verifyCode(claims.sub, parsed.data.code);
      } catch {
        await deps.login.recordMfaFailure(claims.sub, req.ip, ua);
        return reply.code(401).send({ error: { code: "invalid_code", message: "invalid mfa code" } });
      }

      const result = await completeMFALogin(deps.login, deps.users, claims.sub, req.ip, String(req.headers["user-agent"] ?? ""));
      return emitTokens(req, reply, result, { user: result.user ? userView(result.user) : undefined });
    });

    // ----- POST /refresh -----------------------------------------------
    // Token comes from the HttpOnly cookie (browser) or the body (Tauri).
    const refreshSchema = z.object({ refresh_token: z.string().min(1).optional() });

    app.post("/refresh", authRateLimit, async (req, reply) => {
      const parsed = refreshSchema.safeParse(req.body ?? {});
      const token = readRefreshCookie(req) ?? (parsed.success ? parsed.data.refresh_token : undefined);
      if (!token) {
        return reply.code(400).send({ error: { code: "validation_failed", message: "refresh token required" } });
      }
      try {
        const r = await deps.refresh.execute(token, req.ip, String(req.headers["user-agent"] ?? ""));
        return emitTokens(req, reply, r);
      } catch {
        return reply.code(401).send({ error: { code: "invalid_refresh", message: "refresh token invalid or reused" } });
      }
    });

    // ----- POST /logout -------------------------------------------------
    // SEC-017: revoke the current refresh session server-side (not just a
    // client-side token wipe), so the presented token — and any stolen copy —
    // can no longer be refreshed. The refresh token is accepted in the body.
    const logoutSchema = z.object({ refresh_token: z.string().min(1).optional() });
    app.post("/logout", async (req, reply) => {
      const parsed = logoutSchema.safeParse(req.body ?? {});
      const rt = readRefreshCookie(req) ?? (parsed.success ? parsed.data.refresh_token : undefined);
      if (rt) await deps.refresh.logout(rt, req.ip, String(req.headers["user-agent"] ?? ""));
      clearRefreshCookie(reply); // SEC-019: drop the browser cookie too
      return reply.code(204).send();
    });

    // ----- POST /logout-all --------------------------------------------
    // Revoke every active session for the authenticated user.
    app.post("/logout-all", { preHandler: makeAuthMiddleware(deps.jwt, deps.users) }, async (req, reply) => {
      await deps.refresh.logoutAll(req.auth!.sub, req.ip, String(req.headers["user-agent"] ?? ""));
      // "Sign out everywhere" must also evict an attacker's already-open shell.
      deps.sessions?.revokeUser(req.auth!.sub, "AUTHORIZATION_CHANGED");
      clearRefreshCookie(reply);
      return reply.code(204).send();
    });
  };
}
