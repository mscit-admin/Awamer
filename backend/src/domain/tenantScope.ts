/**
 * SEC-TENANT-001 — Explicit tenant scope.
 *
 * A non-super-admin whose company_id is NULL must NEVER be treated as global.
 * Previously repositories used `null`/`undefined`/missing companyId to mean
 * "global (Super Admin)", so a regular user with no company collapsed onto the
 * same unscoped query and saw every tenant's rows.
 *
 * The fix: global access must be EXPLICIT. Callers derive a `TenantScope` from
 * the actor and pass it to tenant-scoped repositories:
 *   - global            → Super Admin: all companies
 *   - { company }       → a specific company
 *   - none              → the actor has no company: forbidden / EMPTY result
 */

export type TenantScope =
  | { kind: "global" }
  | { kind: "company"; companyId: string }
  | { kind: "none" };

/**
 * Derive the scope for an actor. `isSuper` must be the result of a real
 * permission check (e.g. `can(role, "companies:manage")`) — never inferred from
 * a null company. A non-super actor with no company resolves to `none`.
 */
export function tenantScopeForActor(actor: {
  isSuper: boolean;
  companyId: string | null | undefined;
}): TenantScope {
  if (actor.isSuper) return { kind: "global" };
  if (actor.companyId) return { kind: "company", companyId: actor.companyId };
  return { kind: "none" };
}
