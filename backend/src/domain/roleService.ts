/**
 * Bridges the `roles` table to the RBAC resolver. On reload it builds a
 * key→permissions map from the DB and installs it via setPermissionResolver,
 * so `can()` / `permissionsFor()` (used by middleware and gateways) reflect
 * live role definitions without requiring users to re-authenticate.
 */
import { setPermissionResolver } from "./permissions.js";
import type { RoleRepository, RoleRecord } from "../repos/roleRepo.js";

export class RoleService {
  private cache: RoleRecord[] = [];

  constructor(private readonly repo: RoleRepository) {}

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
}
