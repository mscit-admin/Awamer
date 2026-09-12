import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { userView } from "./auth.js";
import { DomainError } from "../domain/index.js";
import type { UserRepository } from "../repos/userRepo.js";
import type { RefreshRepository } from "../repos/otherRepos.js";
import type { RegisterUseCase } from "../usecases/register.js";
import type { ChangePasswordUseCase } from "../usecases/changePassword.js";
import type { MFAUseCase } from "../usecases/mfa.js";
import type { RoleService } from "../domain/roleService.js";
import type { JwtService } from "../jwt/index.js";
import { makeAuthMiddleware, requireRole } from "../middleware/auth.js";
import { can, permissionsFor } from "../domain/permissions.js";

interface Deps {
  users: UserRepository;
  register: RegisterUseCase;
  changePassword: ChangePasswordUseCase;
  mfa: MFAUseCase;
  roleService: RoleService;
  jwt: JwtService;
  refresh: RefreshRepository;
  sessions: import("../session/activeSessions.js").ActiveSessionManager;
}

export function makeAdminRoutes(deps: Deps): FastifyPluginAsync {
  return async function (app: FastifyInstance) {
    app.addHook("preHandler", makeAuthMiddleware(deps.jwt, deps.users));
    app.addHook("preHandler", requireRole("super_admin", "admin"));

    // Tenant scope: a Super Admin (companies:manage) sees/manages every
    // company; a company admin is confined to their own company. Returns the
    // caller's company (null for a global super-admin view) and a same-company
    // guard used before touching any target user.
    async function scope(req: import("fastify").FastifyRequest) {
      const isSuper = can(req.auth!.role, "companies:manage");
      const me = await deps.users.getById(req.auth!.sub);
      return { isSuper, companyId: me.companyId };
    }
    const sameCompany = (s: { isSuper: boolean; companyId: string | null }, target: { companyId: string | null }) =>
      s.isSuper || (s.companyId != null && s.companyId === target.companyId);

    // Privilege-escalation guard: a caller may only grant a role whose
    // permission set is a subset of their own. This blocks a company admin from
    // minting a `super_admin` (which carries `companies:manage`) or any custom
    // role that holds a permission the admin themselves lacks — the classic
    // "create an account more powerful than me, then log in as it" attack.
    const mayGrantRole = (callerRole: string, targetRole: string): boolean => {
      const mine = new Set(permissionsFor(callerRole));
      return permissionsFor(targetRole).every((p) => mine.has(p));
    };

    // SEC-016 Rule E / SEC-020: a role is assignable to a user in `targetCompany`
    // only if it's a global built-in, or a custom role OWNED BY THAT SAME
    // COMPANY. This holds for everyone (super-admin included): the invariant
    // custom_role.company_id == user.company_id must never be broken, even when
    // a super-admin assigns across companies. (The permission ceiling is a
    // separate check via mayGrantRole.)
    const mayAssignRoleTenant = (roleKey: string, targetCompany: string | null): boolean => {
      const t = deps.roleService.tenantOf(roleKey);
      if (!t) return false;
      if (t.isBuiltin) return true;
      return targetCompany != null && t.companyId === targetCompany;
    };

    // ---------- list users ----------------------------------------------
    const listQuerySchema = z.object({
      limit: z.coerce.number().int().min(1).max(200).default(50),
      offset: z.coerce.number().int().min(0).default(0),
    });

    app.get("/users", async (req, reply) => {
      const parsed = listQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return reply.code(400).send({ error: { code: "validation_failed", message: parsed.error.message } });
      }
      const s = await scope(req);
      const { users, total } = await deps.users.list(parsed.data.limit, parsed.data.offset, s.isSuper ? undefined : s.companyId);
      return reply.send({
        data: users.map(userView),
        total,
        limit: parsed.data.limit,
        offset: parsed.data.offset,
      });
    });

    // ---------- create user ---------------------------------------------
    const createSchema = z.object({
      username: z.string().min(3).max(64),
      email: z.string().email(),
      password: z.string().min(12).max(256),
      full_name: z.string().max(120).optional(),
      role: z.string().min(1).max(48),
    });

    app.post("/users", async (req, reply) => {
      const parsed = createSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: { code: "validation_failed", message: parsed.error.message } });
      }
      if (!deps.roleService.has(parsed.data.role)) {
        return reply.code(400).send({ error: { code: "invalid_role", message: "unknown role" } });
      }
      if (!mayGrantRole(req.auth!.role, parsed.data.role)) {
        return reply.code(403).send({ error: { code: "forbidden", message: "you cannot grant a role with more privileges than your own" } });
      }
      try {
        // New users join the creating admin's company (isolation). A Super
        // Admin's new users default to the super-admin's own company; they can
        // be moved afterward via the org assignment dialog.
        const s = await scope(req);
        // The new user joins the actor's company (s.companyId); a custom role
        // must belong to that same company.
        if (!mayAssignRoleTenant(parsed.data.role, s.companyId)) {
          return reply.code(403).send({ error: { code: "forbidden", message: "that role belongs to another company" } });
        }
        const user = await deps.register.execute({
          username: parsed.data.username,
          email: parsed.data.email,
          password: parsed.data.password,
          fullName: parsed.data.full_name ?? null,
          role: parsed.data.role,
          companyId: s.companyId,
        });
        return reply.code(201).send(userView(user));
      } catch (e) {
        if (e instanceof DomainError) {
          const status = e.code === "username_taken" || e.code === "email_taken" ? 409 : 400;
          return reply.code(status).send({ error: { code: e.code, message: e.message } });
        }
        throw e;
      }
    });

    // ---------- get / update / delete by id -----------------------------
    const idSchema = z.object({ id: z.string().uuid() });

    app.get("/users/:id", async (req, reply) => {
      const parsed = idSchema.safeParse(req.params);
      if (!parsed.success) return reply.code(400).send({ error: { code: "invalid_id", message: "" } });
      try {
        const u = await deps.users.getById(parsed.data.id);
        const s = await scope(req);
        if (!sameCompany(s, { companyId: u.companyId })) return reply.code(404).send({ error: { code: "user_not_found", message: "not found" } });
        return reply.send(userView(u));
      } catch (e) {
        if (e instanceof DomainError) return reply.code(404).send({ error: { code: e.code, message: e.message } });
        throw e;
      }
    });

    const updateSchema = z.object({
      full_name: z.string().max(120).nullable().optional(),
      email: z.string().email().optional(),
      role: z.string().min(1).max(48).optional(),
      is_active: z.boolean().optional(),
      is_locked: z.boolean().optional(),
    });

    app.patch("/users/:id", async (req, reply) => {
      const idP = idSchema.safeParse(req.params);
      const bodyP = updateSchema.safeParse(req.body);
      if (!idP.success || !bodyP.success) {
        return reply.code(400).send({ error: { code: "validation_failed", message: "" } });
      }
      if (bodyP.data.role !== undefined && !deps.roleService.has(bodyP.data.role)) {
        return reply.code(400).send({ error: { code: "invalid_role", message: "unknown role" } });
      }
      if (bodyP.data.role !== undefined && !mayGrantRole(req.auth!.role, bodyP.data.role)) {
        return reply.code(403).send({ error: { code: "forbidden", message: "you cannot grant a role with more privileges than your own" } });
      }
      try {
        const u = await deps.users.getById(idP.data.id);
        const s = await scope(req);
        if (!sameCompany(s, { companyId: u.companyId })) return reply.code(404).send({ error: { code: "user_not_found", message: "not found" } });
        // A custom role must belong to the TARGET user's company (u.companyId),
        // not the actor's — so a super-admin can't assign a foreign-tenant role.
        if (bodyP.data.role !== undefined && !mayAssignRoleTenant(bodyP.data.role, u.companyId)) {
          return reply.code(403).send({ error: { code: "forbidden", message: "that role belongs to another company" } });
        }
        const prevRole = u.role;
        if (bodyP.data.full_name !== undefined) u.fullName = bodyP.data.full_name;
        if (bodyP.data.email !== undefined) u.email = bodyP.data.email;
        if (bodyP.data.role !== undefined) u.role = bodyP.data.role as typeof u.role;
        if (bodyP.data.is_active !== undefined) u.isActive = bodyP.data.is_active;
        if (bodyP.data.is_locked !== undefined) u.isLocked = bodyP.data.is_locked;
        await deps.users.update(u);
        // SEC-007: security-relevant admin actions must not leave stale sessions
        // trusted. Disabling, locking, or changing a user's role revokes their
        // whole refresh-session chain so refresh stops immediately; combined
        // with the short (15m) access-token TTL, access is cut off promptly.
        const disabled = bodyP.data.is_active === false;
        const locked = bodyP.data.is_locked === true;
        const roleChanged = bodyP.data.role !== undefined && bodyP.data.role !== prevRole;
        if (disabled || locked || roleChanged) {
          await deps.refresh.revokeAllForUser(u.id);
          // AWM-SEC-022: terminate already-established remote sessions too — the
          // DB change is committed above, so revalidate against live state now
          // (closes all on disable/lock, permission-aware on a role change).
          await deps.sessions.revalidateUser(u.id);
        }
        return reply.send(userView(u));
      } catch (e) {
        if (e instanceof DomainError) return reply.code(404).send({ error: { code: e.code, message: e.message } });
        throw e;
      }
    });

    app.delete("/users/:id", async (req, reply) => {
      const parsed = idSchema.safeParse(req.params);
      if (!parsed.success) return reply.code(400).send({ error: { code: "invalid_id", message: "" } });
      if (parsed.data.id === req.auth!.sub) {
        return reply.code(400).send({ error: { code: "cannot_delete_self", message: "cannot delete your own account" } });
      }
      try {
        const u = await deps.users.getById(parsed.data.id);
        const s = await scope(req);
        if (!sameCompany(s, { companyId: u.companyId })) return reply.code(404).send({ error: { code: "user_not_found", message: "not found" } });
        await deps.users.delete(parsed.data.id);
        // AWM-SEC-022: no active remote session may survive deletion.
        deps.sessions.revokeUser(parsed.data.id, "USER_DELETED");
        return reply.code(204).send();
      } catch (e) {
        if (e instanceof DomainError) return reply.code(404).send({ error: { code: e.code, message: e.message } });
        throw e;
      }
    });

    // ---------- reset another user's password ---------------------------
    const resetSchema = z.object({ password: z.string().min(12).max(256) });
    app.post("/users/:id/reset-password", async (req, reply) => {
      const idP = idSchema.safeParse(req.params);
      const bodyP = resetSchema.safeParse(req.body);
      if (!idP.success || !bodyP.success) return reply.code(400).send({ error: { code: "validation_failed", message: "a password of at least 12 characters is required" } });
      try {
        const u = await deps.users.getById(idP.data.id);
        const s = await scope(req);
        if (!sameCompany(s, { companyId: u.companyId })) return reply.code(404).send({ error: { code: "user_not_found", message: "not found" } });
        await deps.changePassword.adminReset(req.auth!.sub, idP.data.id, bodyP.data.password);
        return reply.send({ ok: true });
      } catch (e) {
        if (e instanceof DomainError) {
          const status = e.code === "weak_password" ? 400 : 404;
          return reply.code(status).send({ error: { code: e.code, message: e.message } });
        }
        throw e;
      }
    });

    // ---------- disable another user's 2FA ------------------------------
    app.post("/users/:id/disable-mfa", async (req, reply) => {
      const idP = idSchema.safeParse(req.params);
      if (!idP.success) return reply.code(400).send({ error: { code: "invalid_id", message: "" } });
      try {
        const u = await deps.users.getById(idP.data.id);
        const s = await scope(req);
        if (!sameCompany(s, { companyId: u.companyId })) return reply.code(404).send({ error: { code: "user_not_found", message: "not found" } });
        await deps.mfa.adminDisable(req.auth!.sub, idP.data.id);
        return reply.send({ ok: true });
      } catch (e) {
        if (e instanceof DomainError) return reply.code(404).send({ error: { code: e.code, message: e.message } });
        throw e;
      }
    });
  };
}
