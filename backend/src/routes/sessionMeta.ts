import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  type FolderRepository,
  type TagRepository,
  type CredentialRepository,
} from "../repos/sessionRepos.js";
import type { CredentialTotpRepository, CredentialAttachmentRepository } from "../repos/vaultRepos.js";
import { CREDENTIAL_TYPES, type Folder, toCredentialPublic, serializeAttachmentMeta } from "../domain/session.js";
import { parseTotpInput } from "../domain/totp.js";
import { DomainError } from "../domain/index.js";
import type { AuditRepository } from "../repos/otherRepos.js";
import { makeAuthMiddleware, requireWrite } from "../middleware/auth.js";
import { can } from "../domain/permissions.js";
import type { JwtService } from "../jwt/index.js";

/** Max attachment size (plaintext). Mirrored in the multipart plugin limits. */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

/** Strip path separators / control chars from an uploaded filename. */
function sanitizeFilename(name: string): string {
  const base = name.replace(/[\\/]/g, "_").replace(/[\u0000-\u001f]/g, "").trim();
  return (base || "attachment").slice(0, 255);
}

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
    app.addHook("preHandler", requireWrite());

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
    app.addHook("preHandler", requireWrite());

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
  totp: CredentialTotpRepository;
  attachments: CredentialAttachmentRepository;
  audit: AuditRepository;
  jwt: JwtService;
}

const credentialTypeEnum = z.enum(CREDENTIAL_TYPES as unknown as [string, ...string[]]);

// KeePass-style custom fields (vault Phase 1). Values are encrypted at rest.
const fieldSchema = z.object({
  label: z.string().min(1).max(120),
  value: z.string().max(20000),
  is_secret: z.boolean().optional(),
  sort_order: z.number().int().optional(),
});
const fieldsSchema = z.array(fieldSchema).max(50);

function mapFields(fields: z.infer<typeof fieldsSchema>) {
  return fields.map((f, i) => ({
    label: f.label,
    value: f.value,
    isSecret: f.is_secret ?? true,
    sortOrder: f.sort_order ?? i,
  }));
}

export function makeCredentialRoutes(deps: CredDeps): FastifyPluginAsync {
  return async function (app: FastifyInstance) {
    app.addHook("preHandler", makeAuthMiddleware(deps.jwt));
    app.addHook("preHandler", requireWrite());

    app.get("/", async (req, reply) => {
      const q = req.query as { folder_id?: string; favorites_only?: string };
      const list = await deps.credentials.listForUser(req.auth!.sub, {
        folderId: q.folder_id === "root" ? "root" : q.folder_id,
        favoritesOnly: q.favorites_only === "true",
      });
      return reply.send({ data: list.map((c) => toCredentialPublic(c)) });
    });

    /** GET /:id?reveal=true returns secret_data + secret field values; without, just metadata. */
    app.get("/:id", async (req, reply) => {
      const { id } = req.params as { id: string };
      const reveal = (req.query as { reveal?: string }).reveal === "true";
      if (reveal && !can(req.auth!.role, "credentials:reveal")) {
        return reply.code(403).send({ error: { code: "forbidden", message: "your role cannot reveal secrets" } });
      }
      try {
        const c = await deps.credentials.getById(req.auth!.sub, id);
        if (reveal) {
          await deps.audit.log({ userId: req.auth!.sub, action: "credential_read", success: true, resourceType: "credential", resourceId: c.id });
          return reply.send({
            ...toCredentialPublic(c, true),
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
      folder_id: z.string().uuid().nullable().optional(),
      favorite: z.boolean().optional(),
      expires_at: z.string().datetime().nullable().optional(),
      fields: fieldsSchema.optional(),
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
          folderId: parsed.data.folder_id ?? null,
          favorite: parsed.data.favorite,
          expiresAt: parsed.data.expires_at ? new Date(parsed.data.expires_at) : null,
          fields: parsed.data.fields ? mapFields(parsed.data.fields) : undefined,
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
      folder_id: z.string().uuid().nullable().optional(),
      favorite: z.boolean().optional(),
      expires_at: z.string().datetime().nullable().optional(),
      fields: fieldsSchema.optional(),
    });

    app.patch("/:id", async (req, reply) => {
      const { id } = req.params as { id: string };
      const parsed = updateSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: { code: "validation_failed", message: parsed.error.message } });
      try {
        const b = parsed.data;
        const c = await deps.credentials.update(req.auth!.sub, id, {
          name: b.name,
          username: b.username,
          secretData: b.secret_data,
          description: b.description,
          folderId: b.folder_id,
          favorite: b.favorite,
          expiresAt: b.expires_at === undefined ? undefined : (b.expires_at === null ? null : new Date(b.expires_at)),
          // undefined => keep existing fields; any array (incl. empty) => full replace.
          fields: b.fields === undefined ? undefined : mapFields(b.fields),
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

    // =================================================================
    // TOTP sub-resource (vault Phase 2). The rolling code is computed on
    // the client; the server only stores/reveals the seed.
    // =================================================================

    function serializeTotp(cfg: { algorithm: string; digits: number; period: number; updatedAt: Date }) {
      return { enabled: true, algorithm: cfg.algorithm, digits: cfg.digits, period: cfg.period, updated_at: cfg.updatedAt };
    }

    /** GET /:id/totp — non-secret config; ?reveal=true adds the base32 seed. */
    app.get("/:id/totp", async (req, reply) => {
      const { id } = req.params as { id: string };
      const reveal = (req.query as { reveal?: string }).reveal === "true";
      if (reveal && !can(req.auth!.role, "credentials:reveal")) {
        return reply.code(403).send({ error: { code: "forbidden", message: "your role cannot reveal secrets" } });
      }
      try {
        if (reveal) {
          const full = await deps.totp.reveal(req.auth!.sub, id);
          await deps.audit.log({ userId: req.auth!.sub, action: "credential_totp_read", success: true, resourceType: "credential", resourceId: id });
          return reply.send({ ...serializeTotp(full), secret: full.secret });
        }
        const cfg = await deps.totp.getConfig(req.auth!.sub, id);
        return reply.send(cfg ? serializeTotp(cfg) : { enabled: false });
      } catch (e) {
        if (e instanceof DomainError) {
          return reply.code(e.code === "credential_not_found" ? 404 : e.code === "totp_not_found" ? 404 : 400)
            .send({ error: { code: e.code, message: e.message } });
        }
        throw e;
      }
    });

    const totpSchema = z.object({
      secret: z.string().max(512).optional(),
      otpauth_uri: z.string().max(2048).optional(),
      algorithm: z.string().max(10).optional(),
      digits: z.number().int().optional(),
      period: z.number().int().optional(),
    });

    /** PUT /:id/totp — set/replace the OTP seed. */
    app.put("/:id/totp", async (req, reply) => {
      const { id } = req.params as { id: string };
      const parsed = totpSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: { code: "validation_failed", message: parsed.error.message } });
      try {
        const p = parseTotpInput({
          secret: parsed.data.secret,
          otpauthUri: parsed.data.otpauth_uri,
          algorithm: parsed.data.algorithm,
          digits: parsed.data.digits,
          period: parsed.data.period,
        });
        const cfg = await deps.totp.set(req.auth!.sub, id, p);
        await deps.audit.log({ userId: req.auth!.sub, action: "credential_totp_set", success: true, resourceType: "credential", resourceId: id });
        return reply.send(serializeTotp(cfg));
      } catch (e) {
        if (e instanceof DomainError) {
          return reply.code(e.code === "credential_not_found" ? 404 : e.code === "invalid_totp_secret" ? 400 : 400)
            .send({ error: { code: e.code, message: e.message } });
        }
        throw e;
      }
    });

    app.delete("/:id/totp", async (req, reply) => {
      const { id } = req.params as { id: string };
      try {
        await deps.totp.delete(req.auth!.sub, id);
        await deps.audit.log({ userId: req.auth!.sub, action: "credential_totp_delete", success: true, resourceType: "credential", resourceId: id });
        return reply.code(204).send();
      } catch (e) {
        if (e instanceof DomainError) return reply.code(404).send({ error: { code: e.code, message: e.message } });
        throw e;
      }
    });

    // =================================================================
    // Attachment sub-resource (vault Phase 3). Encrypted blobs in Postgres.
    // =================================================================

    app.get("/:id/attachments", async (req, reply) => {
      const { id } = req.params as { id: string };
      try {
        const list = await deps.attachments.list(req.auth!.sub, id);
        return reply.send({ data: list.map(serializeAttachmentMeta) });
      } catch (e) {
        if (e instanceof DomainError) return reply.code(404).send({ error: { code: e.code, message: e.message } });
        throw e;
      }
    });

    /** POST /:id/attachments — multipart upload (single file field "file"). */
    app.post("/:id/attachments", async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!req.isMultipart()) {
        return reply.code(400).send({ error: { code: "not_multipart", message: "expected multipart/form-data" } });
      }
      const data = await req.file();
      if (!data) return reply.code(400).send({ error: { code: "no_file", message: "no file in request" } });
      let bytes: Buffer;
      try {
        bytes = await data.toBuffer();
      } catch {
        return reply.code(413).send({ error: { code: "attachment_too_large", message: `attachment exceeds ${MAX_ATTACHMENT_BYTES} bytes` } });
      }
      // Guard again in case the plugin limit is higher than ours.
      if (data.file.truncated || bytes.length > MAX_ATTACHMENT_BYTES) {
        return reply.code(413).send({ error: { code: "attachment_too_large", message: `attachment exceeds ${MAX_ATTACHMENT_BYTES} bytes` } });
      }
      if (bytes.length === 0) return reply.code(400).send({ error: { code: "empty_file", message: "attachment is empty" } });
      try {
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        const meta = await deps.attachments.add(req.auth!.sub, id, {
          filename: sanitizeFilename(data.filename || "attachment"),
          mimeType: data.mimetype || "application/octet-stream",
          bytes, sha256,
        });
        await deps.audit.log({ userId: req.auth!.sub, action: "credential_attachment_add", success: true, resourceType: "credential", resourceId: id, details: { attachment_id: meta.id, filename: meta.filename, size: meta.sizeBytes } });
        return reply.code(201).send(serializeAttachmentMeta(meta));
      } catch (e) {
        if (e instanceof DomainError) return reply.code(404).send({ error: { code: e.code, message: e.message } });
        throw e;
      }
    });

    /** GET /:id/attachments/:aid — download decrypted bytes (requires reveal). */
    app.get("/:id/attachments/:aid", async (req, reply) => {
      const { id, aid } = req.params as { id: string; aid: string };
      if (!can(req.auth!.role, "credentials:reveal")) {
        return reply.code(403).send({ error: { code: "forbidden", message: "your role cannot download attachments" } });
      }
      try {
        const { meta, bytes } = await deps.attachments.getWithBytes(req.auth!.sub, id, aid);
        await deps.audit.log({ userId: req.auth!.sub, action: "credential_attachment_read", success: true, resourceType: "credential", resourceId: id, details: { attachment_id: meta.id, filename: meta.filename } });
        return reply
          .header("Content-Type", meta.mimeType)
          .header("Content-Length", String(bytes.length))
          .header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(meta.filename)}`)
          .send(bytes);
      } catch (e) {
        if (e instanceof DomainError) return reply.code(404).send({ error: { code: e.code, message: e.message } });
        throw e;
      }
    });

    app.delete("/:id/attachments/:aid", async (req, reply) => {
      const { id, aid } = req.params as { id: string; aid: string };
      try {
        await deps.attachments.delete(req.auth!.sub, id, aid);
        await deps.audit.log({ userId: req.auth!.sub, action: "credential_attachment_delete", success: true, resourceType: "credential", resourceId: id, details: { attachment_id: aid } });
        return reply.code(204).send();
      } catch (e) {
        if (e instanceof DomainError) return reply.code(404).send({ error: { code: e.code, message: e.message } });
        throw e;
      }
    });
  };
}
