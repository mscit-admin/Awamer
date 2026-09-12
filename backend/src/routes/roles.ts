/**
 * Roles — list the role catalog and (for admins) create / edit / delete custom
 * roles. Built-in roles are locked. Permissions assigned to a role must come
 * from the fixed code-defined catalog (PERMISSIONS).
 *
 *   GET    /api/v1/roles        list roles + permission catalog (any auth user)
 *   POST   /api/v1/roles        create a custom role            (users:manage)
 *   PATCH  /api/v1/roles/:id    edit a custom role              (users:manage)
 *   DELETE /api/v1/roles/:id    delete a custom role            (users:manage)
 */
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { JwtService } from "../jwt/index.js";
import { makeAuthMiddleware, requirePermission } from "../middleware/auth.js";
import { PERMISSIONS, PERMISSION_META, isPermission, permissionsFor } from "../domain/permissions.js";
import { isBuiltinRole } from "../domain/index.js";
import { RoleRepository, RoleNotFound, RoleKeyTaken } from "../repos/roleRepo.js";
import type { RoleService } from "../domain/roleService.js";
import type { AuditRepository } from "../repos/otherRepos.js";
import type { UserRepository } from "../repos/userRepo.js";

interface Deps {
  roles: RoleRepository;
  roleService: RoleService;
  audit: AuditRepository;
  jwt: JwtService;
  users: UserRepository;
}

// SEC-016: permissions that cross tenant boundaries — grantable only by an
// actor who already holds them (in practice, a super-admin). The generic
// subset ceiling below already blocks these for a normal admin, but naming
// them explicitly is belt-and-suspenders against a future role misconfiguration.
const GLOBAL_ONLY_PERMISSIONS = new Set<string>(["companies:manage"]);

function slugify(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48);
}

const catalog = () => PERMISSIONS.map((p) => ({ key: p, label: PERMISSION_META[p].label, description: PERMISSION_META[p].description }));

export function makeRoleRoutes(deps: Deps): FastifyPluginAsync {
  return async function (app: FastifyInstance) {
    app.addHook("preHandler", makeAuthMiddleware(deps.jwt, deps.users));

    // Resolve the acting admin's tenant + permission ceiling. A super-admin
    // (holds companies:manage) is tenant-unbounded; everyone else is confined
    // to their own company and may only grant permissions they hold.
    async function actor(req: import("fastify").FastifyRequest) {
      const mine = new Set<string>(permissionsFor(req.auth!.role));
      const isSuper = mine.has("companies:manage");
      const me = await deps.users.getById(req.auth!.sub);
      return { companyId: me.companyId, isSuper, mine };
    }

    // SEC-016 ceiling: every requested permission must be held by the actor;
    // global-only permissions additionally require super-admin. Returns the
    // first offending permission, or null when the set is within the ceiling.
    function ceilingViolation(a: { isSuper: boolean; mine: Set<string> }, requested: string[]): string | null {
      for (const p of requested) {
        if (GLOBAL_ONLY_PERMISSIONS.has(p) && !a.isSuper) return p;
        if (!a.mine.has(p)) return p;
      }
      return null;
    }

    // Same-tenant guard for a custom role. Super-admin passes; a normal admin
    // may only touch their own company's custom roles. Built-ins are handled
    // by the callers (locked). Returns false → respond 404 (non-disclosing).
    const sameTenantRole = (a: { isSuper: boolean; companyId: string | null }, role: { companyId: string | null }) =>
      a.isSuper || (a.companyId != null && role.companyId === a.companyId);

    // Readable by any authenticated user (the Users dropdown + the matrix need
    // it) — but scoped: a tenant sees built-ins + only its own custom roles.
    app.get("/", async (req, reply) => {
      const a = await actor(req);
      const data = await deps.roles.listForCompany(a.isSuper ? null : a.companyId);
      return reply.send({ data, catalog: catalog() });
    });

    const permsSchema = z.array(z.string()).max(64);
    const validatePerms = (perms: string[]): string[] | null => {
      const clean = [...new Set(perms)];
      if (clean.some((p) => !isPermission(p))) return null;
      return clean;
    };

    const createSchema = z.object({
      name: z.string().min(2).max(48),
      description: z.string().max(200).nullable().optional(),
      permissions: permsSchema.default([]),
    });

    app.post("/", { preHandler: [requirePermission("users:manage")] }, async (req, reply) => {
      const parsed = createSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: { code: "validation_failed", message: parsed.error.message } });
      }
      const perms = validatePerms(parsed.data.permissions);
      if (!perms) return reply.code(400).send({ error: { code: "unknown_permission", message: "unknown permission in list" } });

      const a = await actor(req);
      const offending = ceilingViolation(a, perms);
      if (offending) {
        void deps.audit.log({ userId: req.auth!.sub, action: "config_change", resourceType: "role", success: false, details: { op: "role_create_denied", reason: "permission_ceiling", offending } });
        return reply.code(403).send({ error: { code: "forbidden", message: "you cannot grant a permission you do not hold" } });
      }

      const key = slugify(parsed.data.name);
      if (!key) return reply.code(400).send({ error: { code: "invalid_name", message: "name must contain letters or digits" } });
      if (isBuiltinRole(key)) return reply.code(409).send({ error: { code: "role_key_taken", message: "that name collides with a built-in role" } });

      try {
        const role = await deps.roles.create({ key, name: parsed.data.name, description: parsed.data.description ?? null, permissions: perms, companyId: a.companyId });
        await deps.roleService.reload();
        void deps.audit.log({ userId: req.auth!.sub, action: "config_change", resourceType: "role", resourceId: role.id, success: true, details: { op: "role_create", key } });
        return reply.code(201).send(role);
      } catch (e) {
        if (e instanceof RoleKeyTaken) return reply.code(409).send({ error: { code: "role_key_taken", message: "a role with that name already exists" } });
        throw e;
      }
    });

    const idSchema = z.object({ id: z.string().uuid() });
    const updateSchema = z.object({
      name: z.string().min(2).max(48).optional(),
      description: z.string().max(200).nullable().optional(),
      permissions: permsSchema.optional(),
    });

    app.patch("/:id", { preHandler: [requirePermission("users:manage")] }, async (req, reply) => {
      const idP = idSchema.safeParse(req.params);
      if (!idP.success) return reply.code(400).send({ error: { code: "validation_failed", message: idP.error.message } });
      const bodyP = updateSchema.safeParse(req.body);
      if (!bodyP.success) return reply.code(400).send({ error: { code: "validation_failed", message: bodyP.error.message } });

      let perms: string[] | undefined;
      if (bodyP.data.permissions !== undefined) {
        const v = validatePerms(bodyP.data.permissions);
        if (!v) return reply.code(400).send({ error: { code: "unknown_permission", message: "unknown permission in list" } });
        perms = v;
      }

      const a = await actor(req);
      // Ceiling: cannot add a permission you do not hold (blocks self-escalation
      // via editing your own role, then roleService.reload()).
      if (perms) {
        const offending = ceilingViolation(a, perms);
        if (offending) {
          void deps.audit.log({ userId: req.auth!.sub, action: "config_change", resourceType: "role", resourceId: idP.data.id, success: false, details: { op: "role_update_denied", reason: "permission_ceiling", offending } });
          return reply.code(403).send({ error: { code: "forbidden", message: "you cannot grant a permission you do not hold" } });
        }
      }

      try {
        const existing = await deps.roles.getById(idP.data.id);
        if (existing.isBuiltin) {
          return reply.code(403).send({ error: { code: "role_locked", message: "built-in roles cannot be edited" } });
        }
        // Tenant ownership: a normal admin may only edit their own company's
        // custom roles. Respond 404 (non-disclosing) for another tenant's role.
        if (!sameTenantRole(a, existing)) {
          return reply.code(404).send({ error: { code: "not_found", message: "role not found" } });
        }
        const role = await deps.roles.update(idP.data.id, { name: bodyP.data.name, description: bodyP.data.description, permissions: perms });
        await deps.roleService.reload();
        void deps.audit.log({ userId: req.auth!.sub, action: "config_change", resourceType: "role", resourceId: role.id, success: true, details: { op: "role_update", key: role.key } });
        return reply.send(role);
      } catch (e) {
        if (e instanceof RoleNotFound) return reply.code(404).send({ error: { code: "not_found", message: "role not found" } });
        throw e;
      }
    });

    app.delete("/:id", { preHandler: [requirePermission("users:manage")] }, async (req, reply) => {
      const idP = idSchema.safeParse(req.params);
      if (!idP.success) return reply.code(400).send({ error: { code: "validation_failed", message: idP.error.message } });
      const a = await actor(req);
      try {
        const existing = await deps.roles.getById(idP.data.id);
        if (existing.isBuiltin) {
          return reply.code(403).send({ error: { code: "role_locked", message: "built-in roles cannot be deleted" } });
        }
        if (!sameTenantRole(a, existing)) {
          return reply.code(404).send({ error: { code: "not_found", message: "role not found" } });
        }
        const inUse = await deps.roles.countUsers(existing.key);
        if (inUse > 0) {
          return reply.code(409).send({ error: { code: "role_in_use", message: `${inUse} user(s) still have this role — reassign them first` } });
        }
        await deps.roles.delete(idP.data.id);
        await deps.roleService.reload();
        void deps.audit.log({ userId: req.auth!.sub, action: "config_change", resourceType: "role", resourceId: existing.id, success: true, details: { op: "role_delete", key: existing.key } });
        return reply.send({ ok: true });
      } catch (e) {
        if (e instanceof RoleNotFound) return reply.code(404).send({ error: { code: "not_found", message: "role not found" } });
        throw e;
      }
    });
  };
}
