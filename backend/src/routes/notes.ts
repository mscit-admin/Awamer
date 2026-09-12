/**
 * User notes — personal, per-user, optionally tied to a host.
 *
 *   GET    /api/v1/notes            list (filters: host_id, search)
 *   POST   /api/v1/notes            create
 *   PATCH  /api/v1/notes/:id        update (title/body/pinned)
 *   DELETE /api/v1/notes/:id        delete
 *
 * Self-scoped to the authenticated user; available to any signed-in user.
 */
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { JwtService } from "../jwt/index.js";
import { makeAuthMiddleware } from "../middleware/auth.js";
import type { NotesRepository } from "../repos/notesRepo.js";

interface Deps {
  notes: NotesRepository;
  jwt: JwtService;
  users: import("../repos/userRepo.js").UserRepository;
}

export function makeNotesRoutes(deps: Deps): FastifyPluginAsync {
  return async function (app: FastifyInstance) {
    app.addHook("preHandler", makeAuthMiddleware(deps.jwt, deps.users));

    const listQuery = z.object({
      host_id: z.string().uuid().optional(),
      search: z.string().max(200).optional(),
    });

    const view = (n: Awaited<ReturnType<NotesRepository["create"]>>) => ({
      id: n.id, owner_id: n.ownerId, owner_username: n.ownerUsername, is_owner: n.isOwner,
      is_shared: n.isShared, host_id: n.hostId, host_label: n.hostLabel,
      title: n.title, body: n.body, pinned: n.pinned, created_at: n.createdAt, updated_at: n.updatedAt,
    });

    app.get("/", async (req, reply) => {
      const parsed = listQuery.safeParse(req.query);
      if (!parsed.success) return reply.code(400).send({ error: { code: "validation_failed", message: parsed.error.message } });
      const notes = await deps.notes.list(req.auth!.sub, { hostId: parsed.data.host_id, search: parsed.data.search?.trim() || undefined });
      return reply.send({ data: notes.map(view) });
    });

    const createBody = z.object({
      title: z.string().max(200).nullable().optional(),
      body: z.string().max(20000).default(""),
      host_id: z.string().uuid().nullable().optional(),
      host_label: z.string().max(200).nullable().optional(),
    });

    app.post("/", async (req, reply) => {
      const parsed = createBody.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: { code: "validation_failed", message: parsed.error.message } });
      if (!parsed.data.body.trim() && !parsed.data.title?.trim()) {
        return reply.code(400).send({ error: { code: "empty_note", message: "note is empty" } });
      }
      const note = await deps.notes.create(req.auth!.sub, {
        title: parsed.data.title ?? null,
        body: parsed.data.body,
        hostId: parsed.data.host_id ?? null,
        hostLabel: parsed.data.host_label ?? null,
      });
      return reply.code(201).send(view(note));
    });

    const idSchema = z.object({ id: z.string().regex(/^\d+$/) });
    const patchBody = z.object({
      title: z.string().max(200).nullable().optional(),
      body: z.string().max(20000).optional(),
      pinned: z.boolean().optional(),
      is_shared: z.boolean().optional(),
    });

    app.patch("/:id", async (req, reply) => {
      const idP = idSchema.safeParse(req.params);
      const bodyP = patchBody.safeParse(req.body);
      if (!idP.success || !bodyP.success) return reply.code(400).send({ error: { code: "validation_failed", message: "" } });
      const note = await deps.notes.update(req.auth!.sub, idP.data.id, {
        title: bodyP.data.title, body: bodyP.data.body, pinned: bodyP.data.pinned, isShared: bodyP.data.is_shared,
      });
      if (!note) return reply.code(404).send({ error: { code: "not_found", message: "note not found, or you don't own it" } });
      return reply.send(view(note));
    });

    app.delete("/:id", async (req, reply) => {
      const idP = idSchema.safeParse(req.params);
      if (!idP.success) return reply.code(400).send({ error: { code: "validation_failed", message: "" } });
      const ok = await deps.notes.delete(req.auth!.sub, idP.data.id);
      if (!ok) return reply.code(404).send({ error: { code: "not_found", message: "note not found" } });
      return reply.send({ ok: true });
    });

    // ---- per-user sharing (owner only) ----
    app.get("/:id/shares", async (req, reply) => {
      const idP = idSchema.safeParse(req.params);
      if (!idP.success) return reply.code(400).send({ error: { code: "validation_failed", message: "" } });
      const ids = await deps.notes.getShareUserIds(req.auth!.sub, idP.data.id);
      if (ids === null) return reply.code(404).send({ error: { code: "not_found", message: "note not found, or you don't own it" } });
      return reply.send({ user_ids: ids });
    });

    const sharesBody = z.object({ user_ids: z.array(z.string().uuid()).max(500) });
    app.put("/:id/shares", async (req, reply) => {
      const idP = idSchema.safeParse(req.params);
      const bodyP = sharesBody.safeParse(req.body);
      if (!idP.success || !bodyP.success) return reply.code(400).send({ error: { code: "validation_failed", message: "" } });
      const ok = await deps.notes.setShares(req.auth!.sub, idP.data.id, bodyP.data.user_ids);
      if (!ok) return reply.code(404).send({ error: { code: "not_found", message: "note not found, or you don't own it" } });
      return reply.send({ ok: true });
    });
  };
}
