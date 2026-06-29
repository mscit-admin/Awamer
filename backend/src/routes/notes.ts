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
}

export function makeNotesRoutes(deps: Deps): FastifyPluginAsync {
  return async function (app: FastifyInstance) {
    app.addHook("preHandler", makeAuthMiddleware(deps.jwt));

    const listQuery = z.object({
      host_id: z.string().uuid().optional(),
      search: z.string().max(200).optional(),
    });

    app.get("/", async (req, reply) => {
      const parsed = listQuery.safeParse(req.query);
      if (!parsed.success) return reply.code(400).send({ error: { code: "validation_failed", message: parsed.error.message } });
      const notes = await deps.notes.list(req.auth!.sub, { hostId: parsed.data.host_id, search: parsed.data.search?.trim() || undefined });
      return reply.send({ data: notes });
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
      return reply.code(201).send(note);
    });

    const idSchema = z.object({ id: z.string().regex(/^\d+$/) });
    const patchBody = z.object({
      title: z.string().max(200).nullable().optional(),
      body: z.string().max(20000).optional(),
      pinned: z.boolean().optional(),
    });

    app.patch("/:id", async (req, reply) => {
      const idP = idSchema.safeParse(req.params);
      const bodyP = patchBody.safeParse(req.body);
      if (!idP.success || !bodyP.success) return reply.code(400).send({ error: { code: "validation_failed", message: "" } });
      const note = await deps.notes.update(req.auth!.sub, idP.data.id, bodyP.data);
      if (!note) return reply.code(404).send({ error: { code: "not_found", message: "note not found" } });
      return reply.send(note);
    });

    app.delete("/:id", async (req, reply) => {
      const idP = idSchema.safeParse(req.params);
      if (!idP.success) return reply.code(400).send({ error: { code: "validation_failed", message: "" } });
      const ok = await deps.notes.delete(req.auth!.sub, idP.data.id);
      if (!ok) return reply.code(404).send({ error: { code: "not_found", message: "note not found" } });
      return reply.send({ ok: true });
    });
  };
}
