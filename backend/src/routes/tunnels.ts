/**
 * SSH port-forwarding (tunnels) — server-managed local forwarding (`ssh -L`).
 *
 *   GET    /api/v1/tunnels        list the caller's active tunnels
 *   POST   /api/v1/tunnels        create + start a tunnel
 *   DELETE /api/v1/tunnels/:id    stop + remove a tunnel
 *
 * Self-scoped to the authenticated user, gated by `sessions:connect`. Binding a
 * tunnel to all interfaces (0.0.0.0) is restricted to admins; everyone else is
 * confined to localhost (127.0.0.1).
 */
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { JwtService } from "../jwt/index.js";
import { makeAuthMiddleware, requirePermission } from "../middleware/auth.js";
import { TunnelManager, TunnelError } from "../ssh/tunnelManager.js";

interface Deps {
  tunnels: TunnelManager;
  jwt: JwtService;
  users: import("../repos/userRepo.js").UserRepository;
}

const ADMIN_ROLES = new Set(["admin", "super_admin"]);
const DST_HOST_RE = /^[a-zA-Z0-9._-]+$/;

export function makeTunnelRoutes(deps: Deps): FastifyPluginAsync {
  return async function (app: FastifyInstance) {
    app.addHook("preHandler", makeAuthMiddleware(deps.jwt, deps.users));
    app.addHook("preHandler", requirePermission("tunnels:manage"));

    app.get("/", async (req, reply) => {
      return reply.send({ data: deps.tunnels.list(req.auth!.sub) });
    });

    const createBody = z.object({
      host_id: z.string().uuid(),
      listen_port: z.coerce.number().int().min(1024).max(65535),
      dst_host: z.string().min(1).max(253).regex(DST_HOST_RE, "invalid destination host"),
      dst_port: z.coerce.number().int().min(1).max(65535),
      bind_public: z.boolean().optional().default(false),
    });

    app.post("/", async (req, reply) => {
      const parsed = createBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: { code: "validation_failed", message: parsed.error.message } });
      }
      const { host_id, listen_port, dst_host, dst_port, bind_public } = parsed.data;
      if (bind_public && !ADMIN_ROLES.has(req.auth!.role)) {
        return reply.code(403).send({ error: { code: "forbidden", message: "only admins may bind a tunnel publicly" } });
      }
      try {
        const t = await deps.tunnels.create(req.auth!.sub, {
          hostId: host_id,
          listenPort: listen_port,
          dstHost: dst_host,
          dstPort: dst_port,
          bindPublic: bind_public,
        });
        return reply.code(201).send(t);
      } catch (e) {
        if (e instanceof TunnelError) {
          const status = e.code === "too_many" ? 409 : e.code === "port_in_use" ? 409 : 400;
          return reply.code(status).send({ error: { code: e.code, message: e.message } });
        }
        // resolveSshConnection throws SshResolveError (has .code) on auth/host issues.
        const code = (e as { code?: string })?.code;
        if (code) {
          return reply.code(400).send({ error: { code, message: (e as Error).message } });
        }
        throw e;
      }
    });

    app.delete("/:id", async (req, reply) => {
      const id = (req.params as { id: string }).id;
      const ok = deps.tunnels.remove(req.auth!.sub, id);
      if (!ok) {
        return reply.code(404).send({ error: { code: "not_found", message: "tunnel not found" } });
      }
      return reply.send({ ok: true });
    });
  };
}
