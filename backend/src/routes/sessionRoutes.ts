import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  type HostRepository,
  type ConnectionHistoryRepository,
} from "../repos/sessionRepos.js";
import {
  HOST_PROTOCOLS, DEFAULT_PORTS, CONNECTION_STATUSES,
  type Host, type HostProtocol, type Tag,
} from "../domain/session.js";
import { DomainError } from "../domain/index.js";
import type { AuditRepository } from "../repos/otherRepos.js";
import { makeAuthMiddleware } from "../middleware/auth.js";
import type { JwtService } from "../jwt/index.js";

const protocolEnum = z.enum(HOST_PROTOCOLS as unknown as [string, ...string[]]);
const statusEnum = z.enum(CONNECTION_STATUSES as unknown as [string, ...string[]]);

function serializeHost(h: Host, tags: Tag[] = []) {
  return {
    id: h.id,
    name: h.name,
    hostname: h.hostname,
    port: h.port,
    protocol: h.protocol,
    folder_id: h.folderId,
    credential_id: h.credentialId,
    description: h.description,
    is_favorite: h.isFavorite,
    options: h.options,
    last_used_at: h.lastUsedAt,
    use_count: h.useCount,
    created_at: h.createdAt,
    updated_at: h.updatedAt,
    tags: tags.map((t) => ({ id: t.id, name: t.name, color: t.color })),
  };
}

// =====================================================================
// Host routes
// =====================================================================

interface HostDeps {
  hosts: HostRepository;
  audit: AuditRepository;
  jwt: JwtService;
}

export function makeHostRoutes(deps: HostDeps): FastifyPluginAsync {
  return async function (app: FastifyInstance) {
    app.addHook("preHandler", makeAuthMiddleware(deps.jwt));

    // --- List ----------------------------------------------------------
    const listQuery = z.object({
      folder_id: z.string().optional(),  // uuid or "root"
      tag_ids: z.string().optional(),    // comma-separated
      protocol: protocolEnum.optional(),
      q: z.string().max(200).optional(),
      favorites_only: z.coerce.boolean().optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
      offset: z.coerce.number().int().min(0).default(0),
    });

    app.get("/", async (req, reply) => {
      const parsed = listQuery.safeParse(req.query);
      if (!parsed.success) return reply.code(400).send({ error: { code: "validation_failed", message: parsed.error.message } });

      let folderId: string | "root" | undefined;
      if (parsed.data.folder_id === "root") folderId = "root";
      else if (parsed.data.folder_id) folderId = parsed.data.folder_id;

      const tagIds = parsed.data.tag_ids ? parsed.data.tag_ids.split(",").filter(Boolean) : undefined;

      const { hosts, total } = await deps.hosts.list(req.auth!.sub, {
        folderId,
        tagIds,
        protocol: parsed.data.protocol as HostProtocol | undefined,
        q: parsed.data.q,
        favoritesOnly: parsed.data.favorites_only,
        limit: parsed.data.limit,
        offset: parsed.data.offset,
      });
      const tagsByHost = await deps.hosts.tagsForHosts(req.auth!.sub, hosts.map((h) => h.id));
      return reply.send({
        data: hosts.map((h) => serializeHost(h, tagsByHost.get(h.id) ?? [])),
        total,
        limit: parsed.data.limit,
        offset: parsed.data.offset,
      });
    });

    // --- Create --------------------------------------------------------
    const createSchema = z.object({
      name: z.string().min(1).max(100),
      hostname: z.string().min(1).max(253),
      port: z.number().int().min(1).max(65535).optional(),  // defaults from protocol
      protocol: protocolEnum,
      folder_id: z.string().uuid().nullable().optional(),
      credential_id: z.string().uuid().nullable().optional(),
      description: z.string().max(1000).nullable().optional(),
      options: z.record(z.unknown()).optional(),
      tag_ids: z.array(z.string().uuid()).optional(),
    });

    app.post("/", async (req, reply) => {
      const parsed = createSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: { code: "validation_failed", message: parsed.error.message } });
      const proto = parsed.data.protocol as HostProtocol;
      const port = parsed.data.port ?? DEFAULT_PORTS[proto] ?? 0;

      try {
        const host = await deps.hosts.create({
          userId: req.auth!.sub,
          name: parsed.data.name,
          hostname: parsed.data.hostname,
          port,
          protocol: proto,
          folderId: parsed.data.folder_id ?? null,
          credentialId: parsed.data.credential_id ?? null,
          description: parsed.data.description ?? null,
          options: parsed.data.options ?? {},
        });
        let tags: Tag[] = [];
        if (parsed.data.tag_ids?.length) {
          tags = await deps.hosts.setTags(req.auth!.sub, host.id, parsed.data.tag_ids);
        }
        await deps.audit.log({ userId: req.auth!.sub, action: "host_create", success: true, resourceType: "host", resourceId: host.id });
        return reply.code(201).send(serializeHost(host, tags));
      } catch (e) {
        if (e instanceof DomainError) {
          return reply.code(e.code === "host_name_taken" ? 409 : 400).send({ error: { code: e.code, message: e.message } });
        }
        throw e;
      }
    });

    // --- Get -----------------------------------------------------------
    app.get("/:id", async (req, reply) => {
      const { id } = req.params as { id: string };
      try {
        const host = await deps.hosts.getById(req.auth!.sub, id);
        const tags = await deps.hosts.tagsOf(req.auth!.sub, host.id);
        return reply.send(serializeHost(host, tags));
      } catch (e) {
        if (e instanceof DomainError) return reply.code(404).send({ error: { code: e.code, message: e.message } });
        throw e;
      }
    });

    // --- Update --------------------------------------------------------
    const updateSchema = z.object({
      name: z.string().min(1).max(100).optional(),
      hostname: z.string().min(1).max(253).optional(),
      port: z.number().int().min(1).max(65535).optional(),
      protocol: protocolEnum.optional(),
      folder_id: z.string().uuid().nullable().optional(),
      credential_id: z.string().uuid().nullable().optional(),
      description: z.string().max(1000).nullable().optional(),
      options: z.record(z.unknown()).optional(),
      is_favorite: z.boolean().optional(),
      tag_ids: z.array(z.string().uuid()).optional(),
    });

    app.patch("/:id", async (req, reply) => {
      const { id } = req.params as { id: string };
      const parsed = updateSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: { code: "validation_failed", message: parsed.error.message } });

      try {
        const host = await deps.hosts.update(req.auth!.sub, id, {
          name: parsed.data.name,
          hostname: parsed.data.hostname,
          port: parsed.data.port,
          protocol: parsed.data.protocol as HostProtocol | undefined,
          folderId: parsed.data.folder_id,
          credentialId: parsed.data.credential_id,
          description: parsed.data.description,
          options: parsed.data.options,
          isFavorite: parsed.data.is_favorite,
        });
        let tags: Tag[];
        if (parsed.data.tag_ids !== undefined) {
          tags = await deps.hosts.setTags(req.auth!.sub, host.id, parsed.data.tag_ids);
        } else {
          tags = await deps.hosts.tagsOf(req.auth!.sub, host.id);
        }
        await deps.audit.log({ userId: req.auth!.sub, action: "host_update", success: true, resourceType: "host", resourceId: host.id });
        return reply.send(serializeHost(host, tags));
      } catch (e) {
        if (e instanceof DomainError) {
          const status = e.code === "host_not_found" || e.code === "tag_not_found" ? 404 : e.code === "host_name_taken" ? 409 : 400;
          return reply.code(status).send({ error: { code: e.code, message: e.message } });
        }
        throw e;
      }
    });

    // --- Delete --------------------------------------------------------
    app.delete("/:id", async (req, reply) => {
      const { id } = req.params as { id: string };
      try {
        await deps.hosts.delete(req.auth!.sub, id);
        await deps.audit.log({ userId: req.auth!.sub, action: "host_delete", success: true, resourceType: "host", resourceId: id });
        return reply.code(204).send();
      } catch (e) {
        if (e instanceof DomainError) return reply.code(404).send({ error: { code: e.code, message: e.message } });
        throw e;
      }
    });

    // --- Touch (used by Phase 3+ on connect) --------------------------
    app.post("/:id/touch", async (req, reply) => {
      const { id } = req.params as { id: string };
      try {
        await deps.hosts.touch(req.auth!.sub, id);
        return reply.code(204).send();
      } catch (e) {
        if (e instanceof DomainError) return reply.code(404).send({ error: { code: e.code, message: e.message } });
        throw e;
      }
    });

    // --- Favorite toggle ----------------------------------------------
    app.post("/:id/favorite", async (req, reply) => {
      const { id } = req.params as { id: string };
      try {
        const current = await deps.hosts.getById(req.auth!.sub, id);
        const updated = await deps.hosts.update(req.auth!.sub, id, { isFavorite: !current.isFavorite });
        return reply.send({ is_favorite: updated.isFavorite });
      } catch (e) {
        if (e instanceof DomainError) return reply.code(404).send({ error: { code: e.code, message: e.message } });
        throw e;
      }
    });
  };
}

// =====================================================================
// Connection history routes
// =====================================================================

interface HistoryDeps {
  history: ConnectionHistoryRepository;
  hosts: HostRepository;
  audit: AuditRepository;
  jwt: JwtService;
}

export function makeHistoryRoutes(deps: HistoryDeps): FastifyPluginAsync {
  return async function (app: FastifyInstance) {
    app.addHook("preHandler", makeAuthMiddleware(deps.jwt));

    const listQuery = z.object({
      host_id: z.string().uuid().optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
      offset: z.coerce.number().int().min(0).default(0),
    });

    app.get("/", async (req, reply) => {
      const parsed = listQuery.safeParse(req.query);
      if (!parsed.success) return reply.code(400).send({ error: { code: "validation_failed", message: parsed.error.message } });
      const { entries, total } = await deps.history.list(req.auth!.sub, {
        limit: parsed.data.limit,
        offset: parsed.data.offset,
        hostId: parsed.data.host_id,
      });
      return reply.send({
        data: entries.map((e) => ({
          id: e.id,
          host_id: e.hostId,
          host_name: e.hostNameSnapshot,
          hostname: e.hostnameSnapshot,
          port: e.portSnapshot,
          protocol: e.protocol,
          started_at: e.startedAt,
          ended_at: e.endedAt,
          duration_ms: e.durationMs,
          status: e.status,
          error_message: e.errorMessage,
          client_ip: e.clientIp,
          bytes_in: e.bytesIn,
          bytes_out: e.bytesOut,
        })),
        total,
        limit: parsed.data.limit,
        offset: parsed.data.offset,
      });
    });

    /**
     * Phase 3+ will use this to record a new connection attempt.
     * Phase 2 exposes the endpoint so the desktop can show synthetic entries
     * for testing.
     */
    const startSchema = z.object({
      host_id: z.string().uuid(),
    });

    app.post("/start", async (req, reply) => {
      const parsed = startSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: { code: "validation_failed", message: parsed.error.message } });
      try {
        const host = await deps.hosts.getById(req.auth!.sub, parsed.data.host_id);
        const id = await deps.history.start({
          userId: req.auth!.sub,
          hostId: host.id,
          hostNameSnapshot: host.name,
          hostnameSnapshot: host.hostname,
          portSnapshot: host.port,
          protocol: host.protocol,
          clientIp: req.ip,
        });
        await deps.hosts.touch(req.auth!.sub, host.id);
        await deps.audit.log({ userId: req.auth!.sub, action: "connection_start", success: true, resourceType: "host", resourceId: host.id });
        return reply.code(201).send({ id });
      } catch (e) {
        if (e instanceof DomainError) return reply.code(404).send({ error: { code: e.code, message: e.message } });
        throw e;
      }
    });

    const endSchema = z.object({
      status: statusEnum,
      error_message: z.string().nullable().optional(),
      bytes_in: z.number().int().min(0).optional(),
      bytes_out: z.number().int().min(0).optional(),
    });

    app.post("/:id/end", async (req, reply) => {
      const idStr = (req.params as { id: string }).id;
      const id = Number(idStr);
      if (!Number.isFinite(id)) return reply.code(400).send({ error: { code: "invalid_id", message: "" } });
      const parsed = endSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: { code: "validation_failed", message: parsed.error.message } });

      try {
        // Ownership check by fetching entry first
        await deps.history.getById(req.auth!.sub, id);
        await deps.history.end(id, parsed.data.status as any, {
          errorMessage: parsed.data.error_message ?? null,
          bytesIn: parsed.data.bytes_in,
          bytesOut: parsed.data.bytes_out,
        });
        await deps.audit.log({ userId: req.auth!.sub, action: "connection_end", success: parsed.data.status === "closed", details: { status: parsed.data.status } });
        return reply.code(204).send();
      } catch (e) {
        if (e instanceof DomainError) return reply.code(404).send({ error: { code: e.code, message: e.message } });
        throw e;
      }
    });

    /** Bulk delete by age. */
    app.delete("/", async (req, reply) => {
      const olderThan = (req.query as { older_than?: string }).older_than;
      if (!olderThan) return reply.code(400).send({ error: { code: "missing_param", message: "older_than (ISO date) is required" } });
      const cutoff = new Date(olderThan);
      if (Number.isNaN(cutoff.getTime())) return reply.code(400).send({ error: { code: "invalid_date", message: "invalid ISO date" } });
      const removed = await deps.history.deleteOlderThan(req.auth!.sub, cutoff);
      return reply.send({ removed });
    });
  };
}
