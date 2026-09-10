/**
 * Bridges the `roles` table to the RBAC resolver. On reload it builds a
 * key→permissions map from the DB and installs it via setPermissionResolver,
 * so `can()` / `permissionsFor()` (used by middleware and gateways) reflect
 * live role definitions without requiring users to re-authenticate.
 */
import { setPermissionResolver, BUILTIN_ROLES } from "./permissions.js";
import type { RoleRepository, RoleRecord } from "../repos/roleRepo.js";

export class RoleService {
  private cache: RoleRecord[] = [];

  constructor(private readonly repo: RoleRepository) {}

  /**
   * Reconcile the locked built-in roles in the DB with the code catalog, so the
   * latest permissions (e.g. companies:manage, org:manage) are always granted to
   * the built-ins on startup. Custom roles are left untouched. Call before
   * reload().
   */
  async syncBuiltins(): Promise<void> {
    for (const b of BUILTIN_ROLES) {
      await this.repo.upsertBuiltin({ key: b.key, name: b.name, description: b.description, permissions: b.permissions });
    }
  }

  async reload(): Promise<void> {
    const roles = await this.repo.listAll();
    this.cache = roles;
    const map = new Map(roles.map((r) => [r.key, r.permissions]));
    setPermissionResolver((key) => map.get(key) ?? []);
  }

  /** Cached role keys (sync) — for validating a user's assigned role. */
  keys(): string[] {
    return this.cache.map((r) => r.key);
  }

  has(key: string): boolean {
    return this.cache.some((r) => r.key === key);
  }

  /**
   * Tenant ownership of a role key (SEC-016): built-ins are global, custom
   * roles belong to a company. Returns undefined for an unknown key.
   */
  tenantOf(key: string): { isBuiltin: boolean; companyId: string | null } | undefined {
    const r = this.cache.find((x) => x.key === key);
    return r ? { isBuiltin: r.isBuiltin, companyId: r.companyId } : undefined;
  }
}
