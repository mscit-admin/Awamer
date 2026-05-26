import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { userView } from "./auth.js";
import { ALL_ROLES, DomainError } from "../domain/index.js";
import type { UserRepository } from "../repos/userRepo.js";
import type { RegisterUseCase } from "../usecases/register.js";
import type { JwtService } from "../jwt/index.js";
import { makeAuthMiddleware, requireRole } from "../middleware/auth.js";

interface Deps {
  users: UserRepository;
  register: RegisterUseCase;
  jwt: JwtService;
}

export function makeAdminRoutes(deps: Deps): FastifyPluginAsync {
  return async function (app: FastifyInstance) {
    app.addHook("preHandler", makeAuthMiddleware(deps.jwt));
    app.addHook("preHandler", requireRole("super_admin", "admin"));

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
      const { users, total } = await deps.users.list(parsed.data.limit, parsed.data.offset);
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
      role: z.enum(ALL_ROLES as [string, ...string[]]),
    });

    app.post("/users", async (req, reply) => {
      const parsed = createSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: { code: "validation_failed", message: parsed.error.message } });
      }
      try {
        const user = await deps.register.execute({
          username: parsed.data.username,
          email: parsed.data.email,
          password: parsed.data.password,
          fullName: parsed.data.full_name ?? null,
          role: parsed.data.role,
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
        return reply.send(userView(u));
      } catch (e) {
        if (e instanceof DomainError) return reply.code(404).send({ error: { code: e.code, message: e.message } });
        throw e;
      }
    });

    const updateSchema = z.object({
      full_name: z.string().max(120).nullable().optional(),
      email: z.string().email().optional(),
      role: z.enum(ALL_ROLES as [string, ...string[]]).optional(),
      is_active: z.boolean().optional(),
      is_locked: z.boolean().optional(),
    });

    app.patch("/users/:id", async (req, reply) => {
      const idP = idSchema.safeParse(req.params);
      const bodyP = updateSchema.safeParse(req.body);
      if (!idP.success || !bodyP.success) {
        return reply.code(400).send({ error: { code: "validation_failed", message: "" } });
      }
      try {
        const u = await deps.users.getById(idP.data.id);
        if (bodyP.data.full_name !== undefined) u.fullName = bodyP.data.full_name;
        if (bodyP.data.email !== undefined) u.email = bodyP.data.email;
        if (bodyP.data.role !== undefined) u.role = bodyP.data.role as typeof u.role;
        if (bodyP.data.is_active !== undefined) u.isActive = bodyP.data.is_active;
        if (bodyP.data.is_locked !== undefined) u.isLocked = bodyP.data.is_locked;
        await deps.users.update(u);
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
        await deps.users.delete(parsed.data.id);
        return reply.code(204).send();
      } catch (e) {
        if (e instanceof DomainError) return reply.code(404).send({ error: { code: e.code, message: e.message } });
        throw e;
      }
    });
  };
}
