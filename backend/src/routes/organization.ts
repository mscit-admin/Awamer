/**
 * Organization & companies (multi-tenant foundation).
 *
 *   Companies (tenants) — managed by Super Admin (companies:manage):
 *     GET    /companies                     list (all for super-admin; own otherwise)
 *     POST   /companies                     create
 *     PUT    /companies/:id                 rename / (de)activate
 *     DELETE /companies/:id                 delete (only if it has no users)
 *
 *   Org hierarchy — managed within a company (org:manage):
 *     GET    /companies/:companyId/units     flat list of the company's tree
 *     POST   /companies/:companyId/units     add a node { name, kind, parent_id? }
 *     PUT    /units/:id                       edit a node
 *     DELETE /units/:id                       delete a node (children cascade)
 *
 *   User assignment (users:manage):
 *     PUT    /users/:id/assignment            { company_id?, org_unit_id? }
 *
 * Tenant scoping: a non-super-admin only ever sees/edits their own company.
 */
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { can, permissionsFor } from "../domain/permissions.js";
import { makeAuthMiddleware, requirePermission } from "../middleware/auth.js";
import type { JwtService } from "../jwt/index.js";
import type { UserRepository } from "../repos/userRepo.js";
import type { CompanyRepository, OrgUnitRepository, Company } from "../repos/orgRepos.js";
import type { AuditRepository } from "../repos/otherRepos.js";
import type { RoleService } from "../domain/roleService.js";

// Serialize a company to the snake_case shape the client (and the rest of the
// API) uses. Without this the client read `is_active` off a camelCase object
// and every company looked "off".
const companyView = (c: Company) => ({
  id: c.id, name: c.name, slug: c.slug, is_active: c.isActive,
  created_at: c.createdAt, updated_at: c.updatedAt,
});

interface Deps {
  companies: CompanyRepository;
  units: OrgUnitRepository;
  users: UserRepository;
  audit: AuditRepository;
  jwt: JwtService;
  roleService: RoleService;
}

const err = (reply: import("fastify").FastifyReply, code: number, k: string, m: string) =>
  reply.code(code).send({ error: { code: k, message: m } });

export function makeOrganizationRoutes(deps: Deps): FastifyPluginAsync {
  return async function (app: FastifyInstance) {
    app.addHook("preHandler", makeAuthMiddleware(deps.jwt, deps.users));

    // Resolve the caller's company + whether they can manage all companies.
    async function scope(req: import("fastify").FastifyRequest) {
      const isSuper = can(req.auth!.role, "companies:manage");
      const me = await deps.users.getById(req.auth!.sub);
      return { isSuper, companyId: me.companyId };
    }

    // Can the caller act on a given company?
    const mayTouch = (s: { isSuper: boolean; companyId: string | null }, companyId: string) =>
      s.isSuper || s.companyId === companyId;

    // ---- Companies -----------------------------------------------------
    app.get("/companies", async (req, reply) => {
      const s = await scope(req);
      if (s.isSuper) return reply.send({ companies: (await deps.companies.list()).map(companyView) });
      // Non-super: only their own company (so the UI can show its name).
      if (!s.companyId) return reply.send({ companies: [] });
      const c = await deps.companies.getById(s.companyId);
      return reply.send({ companies: c ? [companyView(c)] : [] });
    });

    const companySchema = z.object({
      name: z.string().min(1).max(120),
      slug: z.string().max(60).regex(/^[a-z0-9-]+$/i).nullable().optional(),
    });

    app.post("/companies", { preHandler: requirePermission("companies:manage") }, async (req, reply) => {
      const p = companySchema.safeParse(req.body);
      if (!p.success) return err(reply, 400, "validation_failed", p.error.message);
      const c = await deps.companies.create(p.data.name.trim(), p.data.slug?.toLowerCase() ?? null);
      await deps.audit.log({ userId: req.auth!.sub, action: "company_create", success: true, resourceType: "company", resourceId: c.id }).catch(() => {});
      return reply.code(201).send({ company: companyView(c) });
    });

    app.put("/companies/:id", { preHandler: requirePermission("companies:manage") }, async (req, reply) => {
      const id = (req.params as { id: string }).id;
      const p = z.object({
        name: z.string().min(1).max(120).optional(),
        slug: z.string().max(60).regex(/^[a-z0-9-]+$/i).nullable().optional(),
        is_active: z.boolean().optional(),
      }).safeParse(req.body);
      if (!p.success) return err(reply, 400, "validation_failed", p.error.message);
      const c = await deps.companies.update(id, { name: p.data.name?.trim(), slug: p.data.slug ?? undefined, isActive: p.data.is_active });
      if (!c) return err(reply, 404, "not_found", "company not found");
      return reply.send({ company: companyView(c) });
    });

    app.delete("/companies/:id", { preHandler: requirePermission("companies:manage") }, async (req, reply) => {
      const id = (req.params as { id: string }).id;
      const n = await deps.companies.userCount(id);
      if (n > 0) return err(reply, 409, "company_not_empty", `Move or remove the ${n} user(s) in this company first.`);
      await deps.companies.delete(id);
      await deps.audit.log({ userId: req.auth!.sub, action: "company_delete", success: true, resourceType: "company", resourceId: id }).catch(() => {});
      return reply.code(204).send();
    });

    // ---- Org units -----------------------------------------------------
    app.get("/companies/:companyId/units", async (req, reply) => {
      const companyId = (req.params as { companyId: string }).companyId;
      const s = await scope(req);
      if (!mayTouch(s, companyId)) return err(reply, 403, "forbidden", "not your company");
      return reply.send({ units: await deps.units.listByCompany(companyId) });
    });

    const unitSchema = z.object({
      name: z.string().min(1).max(120),
      kind: z.string().min(1).max(40).default("unit"),
      parent_id: z.string().uuid().nullable().optional(),
      sort: z.number().int().optional(),
    });

    app.post("/companies/:companyId/units", { preHandler: requirePermission("org:manage") }, async (req, reply) => {
      const companyId = (req.params as { companyId: string }).companyId;
      const s = await scope(req);
      if (!mayTouch(s, companyId)) return err(reply, 403, "forbidden", "not your company");
      const p = unitSchema.safeParse(req.body);
      if (!p.success) return err(reply, 400, "validation_failed", p.error.message);
      // A parent, if given, must belong to the same company.
      if (p.data.parent_id) {
        const parent = await deps.units.getById(p.data.parent_id);
        if (!parent || parent.companyId !== companyId) return err(reply, 400, "bad_parent", "parent is not in this company");
      }
      const unit = await deps.units.create({ companyId, parentId: p.data.parent_id ?? null, name: p.data.name.trim(), kind: p.data.kind, sort: p.data.sort });
      return reply.code(201).send({ unit });
    });

    app.put("/units/:id", { preHandler: requirePermission("org:manage") }, async (req, reply) => {
      const id = (req.params as { id: string }).id;
      const existing = await deps.units.getById(id);
      if (!existing) return err(reply, 404, "not_found", "unit not found");
      const s = await scope(req);
      if (!mayTouch(s, existing.companyId)) return err(reply, 403, "forbidden", "not your company");
      const p = z.object({
        name: z.string().min(1).max(120).optional(),
        kind: z.string().min(1).max(40).optional(),
        parent_id: z.string().uuid().nullable().optional(),
        sort: z.number().int().optional(),
      }).safeParse(req.body);
      if (!p.success) return err(reply, 400, "validation_failed", p.error.message);
      if (p.data.parent_id) {
        if (p.data.parent_id === id) return err(reply, 400, "bad_parent", "a unit cannot be its own parent");
        const parent = await deps.units.getById(p.data.parent_id);
        if (!parent || parent.companyId !== existing.companyId) return err(reply, 400, "bad_parent", "parent is not in this company");
      }
      const unit = await deps.units.update(id, { name: p.data.name?.trim(), kind: p.data.kind, parentId: p.data.parent_id ?? undefined, sort: p.data.sort });
      return reply.send({ unit });
    });

    app.delete("/units/:id", { preHandler: requirePermission("org:manage") }, async (req, reply) => {
      const id = (req.params as { id: string }).id;
      const existing = await deps.units.getById(id);
      if (!existing) return reply.code(204).send();
      const s = await scope(req);
      if (!mayTouch(s, existing.companyId)) return err(reply, 403, "forbidden", "not your company");
      await deps.units.delete(id);
      return reply.code(204).send();
    });

    // ---- User assignment ----------------------------------------------
    app.put("/users/:id/assignment", { preHandler: requirePermission("users:manage") }, async (req, reply) => {
      const id = (req.params as { id: string }).id;
      const p = z.object({
        company_id: z.string().uuid().nullable().optional(),
        org_unit_id: z.string().uuid().nullable().optional(),
        role: z.string().min(1).max(48).optional(), // destination role (SEC-020)
      }).safeParse(req.body);
      if (!p.success) return err(reply, 400, "validation_failed", p.error.message);
      const s = await scope(req);

      // Tenant guard: a non-super admin may only act on a user already in their
      // own company (otherwise they could pull a foreign user into their tenant
      // and then take the account over via the admin routes).
      let target;
      try { target = await deps.users.getById(id); }
      catch { return err(reply, 404, "not_found", "user not found"); }
      if (!mayTouch(s, target.companyId ?? "")) return err(reply, 404, "not_found", "user not found");

      // Determine the destination company. Non-super admins can only assign
      // within their own company (so they can never perform a cross-company
      // move — §8/§11). Resolve to a concrete company for org-unit/role checks.
      // A non-super admin must never perform a cross-company move: reject an
      // explicit foreign destination rather than silently confining it (§11).
      if (!s.isSuper && p.data.company_id != null && p.data.company_id !== s.companyId) {
        return err(reply, 403, "forbidden", "you cannot move a user to another company");
      }
      let companyId = p.data.company_id ?? undefined;
      if (!s.isSuper) companyId = s.companyId ?? undefined;
      if (companyId === undefined) companyId = target.companyId ?? undefined;
      const destCompany = companyId ?? null;

      // The org unit, if given, must live in the DESTINATION company (§9/§24).
      const orgUnitId = p.data.org_unit_id ?? null;
      if (orgUnitId) {
        const unit = await deps.units.getById(orgUnitId);
        if (!unit || unit.companyId !== destCompany) return err(reply, 400, "bad_unit", "org unit is not in the target company");
      }

      // SEC-020 — role/tenant integrity. Enforce: for a custom role,
      // role.company_id == user's (destination) company.
      const mine = new Set(permissionsFor(req.auth!.role));
      // Validate an explicitly supplied destination role.
      let newRole: string | undefined = p.data.role;
      if (newRole !== undefined) {
        const t = deps.roleService.tenantOf(newRole);
        if (!t) return err(reply, 400, "invalid_role", "unknown role");
        // Permission ceiling: cannot grant a role whose perms exceed your own.
        if (!permissionsFor(newRole).every((perm) => mine.has(perm))) {
          return err(reply, 403, "forbidden", "you cannot grant a role with more privileges than your own");
        }
        // A custom role must belong to the destination company (built-ins are global).
        if (!t.isBuiltin && t.companyId !== destCompany) {
          return err(reply, 400, "role_wrong_company", "the destination role does not belong to the target company");
        }
      } else {
        // No role supplied: keep the current role ONLY if it is still valid for
        // the destination company. A custom role owned by a different company
        // must not silently survive the move — require an explicit destination role.
        const t = deps.roleService.tenantOf(target.role);
        if (t && !t.isBuiltin && t.companyId !== destCompany) {
          return err(reply, 400, "role_required", "moving this user to another company requires a destination role in that company");
        }
      }

      const user = await deps.users.setOrg(id, destCompany, orgUnitId, newRole);
      await deps.audit.log({
        userId: req.auth!.sub, action: "user_assign_org", success: true,
        resourceType: "user", resourceId: id,
        details: { company_id: destCompany, org_unit_id: orgUnitId, role: newRole ?? target.role },
      }).catch(() => {});
      return reply.send({ user: { id: user.id, company_id: user.companyId, org_unit_id: user.orgUnitId, role: user.role } });
    });
  };
}
