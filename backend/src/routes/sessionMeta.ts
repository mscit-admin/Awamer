import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  type FolderRepository,
  type TagRepository,
  type CredentialRepository,
} from "../repos/sessionRepos.js";
import { CREDENTIAL_TYPES, type Folder, toCredentialPublic } from "../domain/session.js";
import { DomainError } from "../domain/index.js";
import type { AuditRepository } from "../repos/otherRepos.js";
import { makeAuthMiddleware } from "../middleware/auth.js";
import type { JwtService } from "../jwt/index.js";

// =====================================================================
// Folder routes
// =====================================================================

interface FolderDeps {
  folders: FolderRepository;
  audit: AuditRepository;
  jwt: JwtService;
}

function serializeFolder(f: Folder) {
  return {
    id: f.id,
    parent_id: f.parentId,
    name: f.name,
    color: f.color,
    icon: f.icon,
    sort_order: f.sortOrder,
    created_at: f.createdAt,
    updated_at: f.updatedAt,
  };
}

export function makeFolderRoutes(deps: FolderDeps): FastifyPluginAsync {
  return async function (app: FastifyInstance) {
    app.addHook("preHandler", makeAuthMiddleware(deps.jwt));

    app.get("/", async (req, reply) => {
      const folders = await deps.folders.listForUser(req.auth!.sub);
      // Return flat list AND tree structure for clients that prefer either.
      const map = new Map<string, ReturnType<typeof serializeFolder> & { children: any[] }>();
      const flat = folders.map((f) => {
        const o = { ...serializeFolder(f), children: [] as any[] };
        map.set(f.id, o);
        return o;
      });
      const tree: any[] = [];
      for (const node of flat) {
        if (node.parent_id && map.has(node.parent_id)) {
          map.get(node.parent_id)!.children.push(node);
        } else {
          tree.push(node);
        }
      }
      return reply.send({ data: flat, tree });
    });

    const createSchema = z.object({
      name: z.string().min(1).max(80),
      parent_id: z.string().uuid().nullable().optional(),
      color: z.string().max(20).nullable().optional(),
      icon: z.string().max(40).nullable().optional(),
      sort_order: z.number().int().optional(),
    });

    app.post("/", async (req, reply) => {
      const parsed = createSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: { code: "validation_failed", message: parsed.error.message } });
      try {
        const folder = await deps.folders.create({
          userId: req.auth!.sub,
          name: parsed.data.name,
          parentId: parsed.data.parent_id ?? null,
          color: parsed.data.color ?? null,
          icon: parsed.data.icon ?? null,
          sortOrder: parsed.data.sort_order,
        });
        await deps.audit.log({ userId: req.auth!.sub, action: "folder_create", success: true, resourceType: "folder", resourceId: folder.id });
        return reply.code(201).send(serializeFolder(folder));
      } catch (e) {
        if (e instanceof DomainError) {
          return reply.code(e.code === "folder_name_taken" ? 409 : 400).send({ error: { code: e.code, message: e.message } });
        }
        throw e;
      }
    });

    const updateSchema = z.object({
      name: z.string().min(1).max(80).optional(),
      parent_id: z.string().uuid().nullable().optional(),
      color: z.string().max(20).nullable().optional(),
      icon: z.string().max(40).nullable().optional(),
      sort_order: z.number().int().optional(),
    });

    app.patch("/:id", async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!/^[0-9a-f-]{36}$/i.test(id)) return reply.code(400).send({ error: { code: "invalid_id", message: "" } });
      const parsed = updateSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: { code: "validation_failed", message: parsed.error.message } });

      try {
        const folder = await deps.folders.update(req.auth!.sub, id, {
          name: parsed.data.name,
          parentId: parsed.data.parent_id,
          color: parsed.data.color,
          icon: parsed.data.icon,
          sortOrder: parsed.data.sort_order,
        });
        await deps.audit.log({ userId: req.auth!.sub, action: "folder_update", success: true, resourceType: "folder", resourceId: folder.id });
        return reply.send(serializeFolder(folder));
      } catch (e) {
        if (e instanceof DomainError) {
          const status = e.code === "folder_not_found" ? 404 : e.code === "folder_name_taken" ? 409 : 400;
          return reply.code(status).send({ error: { code: e.code, message: e.message } });
        }
        throw e;
      }
    });

    app.delete("/:id", async (req, reply) => {
      const { id } = req.params as { id: string };
      try {
        await deps.folders.delete(req.auth!.sub, id);
        await deps.audit.log({ userId: req.auth!.sub, action: "folder_delete", success: true, resourceType: "folder", resourceId: id });
        return reply.code(204).send();
      } catch (e) {
        if (e instanceof DomainError) return reply.code(404).send({ error: { code: e.code, message: e.message } });
        throw e;
      }
    });
  };
}

// =====================================================================
// Tag routes
// =====================================================================

interface TagDeps {
  tags: TagRepository;
  audit: AuditRepository;
  jwt: JwtService;
}

export function makeTagRoutes(deps: TagDeps): FastifyPluginAsync {
  return async function (app: FastifyInstance) {
    app.addHook("preHandler", makeAuthMiddleware(deps.jwt));

    app.get("/", async (req, reply) => {
      const tags = await deps.tags.listForUser(req.auth!.sub);
      return reply.send({ data: tags.map((t) => ({ id: t.id, name: t.name, color: t.color, created_at: t.createdAt })) });
    });

    const createSchema = z.object({
      name: z.string().min(1).max(40),
      color: z.string().max(20).nullable().optional(),
    });

    app.post("/", async (req, reply) => {
      const parsed = createSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: { code: "validation_failed", message: parsed.error.message } });
      try {
        const tag = await deps.tags.create({
          userId: req.auth!.sub,
          name: parsed.data.name,
          color: parsed.data.color ?? null,
        });
        await deps.audit.log({ userId: req.auth!.sub, action: "tag_create", success: true, resourceType: "tag", resourceId: tag.id });
        return reply.code(201).send({ id: tag.id, name: tag.name, color: tag.color, created_at: tag.createdAt });
      } catch (e) {
        if (e instanceof DomainError) {
          return reply.code(e.code === "tag_name_taken" ? 409 : 400).send({ error: { code: e.code, message: e.message } });
        }
        throw e;
      }
    });

    const updateSchema = z.object({
      name: z.string().min(1).max(40).optional(),
      color: z.string().max(20).nullable().optional(),
    });

    app.patch("/:id", async (req, reply) => {
      const { id } = req.params as { id: string };
      const parsed = updateSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: { code: "validation_failed", message: parsed.error.message } });
      try {
        const tag = await deps.tags.update(req.auth!.sub, id, { name: parsed.data.name, color: parsed.data.color });
        await deps.audit.log({ userId: req.auth!.sub, action: "tag_update", success: true, resourceType: "tag", resourceId: tag.id });
        return reply.send({ id: tag.id, name: tag.name, color: tag.color });
      } catch (e) {
        if (e instanceof DomainError) {
          const status = e.code === "tag_not_found" ? 404 : e.code === "tag_name_taken" ? 409 : 400;
          return reply.code(status).send({ error: { code: e.code, message: e.message } });
        }
        throw e;
      }
    });

    app.delete("/:id", async (req, reply) => {
      const { id } = req.params as { id: string };
      try {
        await deps.tags.delete(req.auth!.sub, id);
        await deps.audit.log({ userId: req.auth!.sub, action: "tag_delete", success: true, resourceType: "tag", resourceId: id });
        return reply.code(204).send();
      } catch (e) {
        if (e instanceof DomainError) return reply.code(404).send({ error: { code: e.code, message: e.message } });
        throw e;
      }
    });
  };
}

// =====================================================================
// Credential routes
// =====================================================================

interface CredDeps {
  credentials: CredentialRepository;
  audit: AuditRepository;
  jwt: JwtService;
}

const credentialTypeEnum = z.enum(CREDENTIAL_TYPES as unknown as [string, ...string[]]);

export function makeCredentialRoutes(deps: CredDeps): FastifyPluginAsync {
  return async function (app: FastifyInstance) {
    app.addHook("preHandler", makeAuthMiddleware(deps.jwt));

    app.get("/", async (req, reply) => {
      const list = await deps.credentials.listForUser(req.auth!.sub);
      return reply.send({ data: list.map(toCredentialPublic) });
    });

    /** GET /:id?reveal=true returns secret_data; without, just metadata. */
    app.get("/:id", async (req, reply) => {
      const { id } = req.params as { id: string };
      const reveal = (req.query as { reveal?: string }).reveal === "true";
      try {
        const c = await deps.credentials.getById(req.auth!.sub, id);
        if (reveal) {
          await deps.audit.log({ userId: req.auth!.sub, action: "credential_read", success: true, resourceType: "credential", resourceId: c.id });
          return reply.send({
            ...toCredentialPublic(c),
            secret_data: c.secretData,
          });
        }
        return reply.send(toCredentialPublic(c));
      } catch (e) {
        if (e instanceof DomainError) return reply.code(404).send({ error: { code: e.code, message: e.message } });
        throw e;
      }
    });

    const createSchema = z.object({
      name: z.string().min(1).max(80),
      credential_type: credentialTypeEnum,
      username: z.string().max(120).nullable().optional(),
      secret_data: z.record(z.unknown()).optional(),
      description: z.string().max(500).nullable().optional(),
    });

    app.post("/", async (req, reply) => {
      const parsed = createSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: { code: "validation_failed", message: parsed.error.message } });
      try {
        const c = await deps.credentials.create({
          userId: req.auth!.sub,
          name: parsed.data.name,
          credentialType: parsed.data.credential_type as any,
          username: parsed.data.username ?? null,
          secretData: parsed.data.secret_data ?? {},
          description: parsed.data.description ?? null,
        });
        await deps.audit.log({ userId: req.auth!.sub, action: "credential_create", success: true, resourceType: "credential", resourceId: c.id });
        return reply.code(201).send(toCredentialPublic(c));
      } catch (e) {
        if (e instanceof DomainError) {
          return reply.code(e.code === "credential_name_taken" ? 409 : 400).send({ error: { code: e.code, message: e.message } });
        }
        throw e;
      }
    });

    const updateSchema = z.object({
      name: z.string().min(1).max(80).optional(),
      username: z.string().max(120).nullable().optional(),
      secret_data: z.record(z.unknown()).optional(),
      description: z.string().max(500).nullable().optional(),
    });

    app.patch("/:id", async (req, reply) => {
      const { id } = req.params as { id: string };
      const parsed = updateSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: { code: "validation_failed", message: parsed.error.message } });
      try {
        const c = await deps.credentials.update(req.auth!.sub, id, {
          name: parsed.data.name,
          username: parsed.data.username,
          secretData: parsed.data.secret_data,
          description: parsed.data.description,
        });
        await deps.audit.log({ userId: req.auth!.sub, action: "credential_update", success: true, resourceType: "credential", resourceId: c.id });
        return reply.send(toCredentialPublic(c));
      } catch (e) {
        if (e instanceof DomainError) {
          const status = e.code === "credential_not_found" ? 404 : e.code === "credential_name_taken" ? 409 : 400;
          return reply.code(status).send({ error: { code: e.code, message: e.message } });
        }
        throw e;
      }
    });

    app.delete("/:id", async (req, reply) => {
      const { id } = req.params as { id: string };
      try {
        await deps.credentials.delete(req.auth!.sub, id);
        await deps.audit.log({ userId: req.auth!.sub, action: "credential_delete", success: true, resourceType: "credential", resourceId: id });
        return reply.code(204).send();
      } catch (e) {
        if (e instanceof DomainError) return reply.code(404).send({ error: { code: e.code, message: e.message } });
        throw e;
      }
    });
  };
}
