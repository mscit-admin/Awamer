/**
 * Command history — per-user, opt-in record of shell commands run in browser
 * SSH sessions.
 *
 *   GET    /api/v1/command-history          list the caller's commands
 *   POST   /api/v1/command-history          append one command
 *   DELETE /api/v1/command-history          clear the caller's commands
 *
 * Always self-scoped to the authenticated user (req.auth.sub) — there is no way
 * to read or clear another user's history. Gated by `sessions:connect`: if you
 * may open a session, you may record what you typed in it. Whether anything is
 * actually sent here is the client's choice (the "Save command history" toggle,
 * which is off by default).
 */
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { CommandHistoryRepository } from "../repos/commandHistoryRepo.js";
import type { JwtService } from "../jwt/index.js";
import { makeAuthMiddleware, requirePermission } from "../middleware/auth.js";

interface Deps {
  commands: CommandHistoryRepository;
  jwt: JwtService;
}

export function makeCommandHistoryRoutes(deps: Deps): FastifyPluginAsync {
  return async function (app: FastifyInstance) {
    app.addHook("preHandler", makeAuthMiddleware(deps.jwt));
    app.addHook("preHandler", requirePermission("sessions:connect"));

    const listQuery = z.object({
      limit: z.coerce.number().int().min(1).max(500).default(200),
      host_id: z.string().uuid().optional(),
      search: z.string().max(200).optional(),
    });

    app.get("/", async (req, reply) => {
      const parsed = listQuery.safeParse(req.query);
      if (!parsed.success) {
        return reply.code(400).send({ error: { code: "validation_failed", message: parsed.error.message } });
      }
      const { limit, host_id, search } = parsed.data;
      const { entries, total } = await deps.commands.list(req.auth!.sub, {
        limit, hostId: host_id, search: search?.trim() || undefined,
      });
      return reply.send({
        data: entries.map((e) => ({
          id: e.id,
          host_id: e.hostId,
          host_label: e.hostLabel,
          command: e.command,
          created_at: e.createdAt,
        })),
        total, limit,
      });
    });

    const postBody = z.object({
      command: z.string().min(1).max(4000),
      host_id: z.string().uuid().nullable().optional(),
      host_label: z.string().max(200).nullable().optional(),
    });

    app.post("/", async (req, reply) => {
      const parsed = postBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: { code: "validation_failed", message: parsed.error.message } });
      }
      const command = parsed.data.command.trim();
      if (!command) {
        return reply.code(400).send({ error: { code: "empty_command", message: "command is empty" } });
      }
      const entry = await deps.commands.add(req.auth!.sub, {
        command,
        hostId: parsed.data.host_id ?? null,
        hostLabel: parsed.data.host_label ?? null,
      });
      return reply.code(201).send({
        id: entry.id,
        host_id: entry.hostId,
        host_label: entry.hostLabel,
        command: entry.command,
        created_at: entry.createdAt,
      });
    });

    const delQuery = z.object({ host_id: z.string().uuid().optional() });

    app.delete("/", async (req, reply) => {
      const parsed = delQuery.safeParse(req.query);
      if (!parsed.success) {
        return reply.code(400).send({ error: { code: "validation_failed", message: parsed.error.message } });
      }
      const deleted = await deps.commands.clear(req.auth!.sub, { hostId: parsed.data.host_id });
      return reply.send({ deleted });
    });
  };
}
