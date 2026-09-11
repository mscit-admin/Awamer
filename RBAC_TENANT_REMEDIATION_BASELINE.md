# RBAC / Tenant Remediation Baseline

**Date:** 2026-09-11 · **Branch:** `claude/nifty-johnson-u2dwye` · **Head:** `9b92d87`
**Baseline:** backend `tsc` clean, **81 unit / 38 integration** pass; migrations
`001`–`023` apply. Node 22.22.2, PostgreSQL 16.13.

## Finding verification

### AWM-SEC-020 — custom role survives cross-company user move (P1) — CONFIRMED
- **Evidence:** `routes/organization.ts` `PUT /users/:id/assignment` (172-204)
  validates the tenant guard, the destination company, and the org-unit company,
  but **never inspects or replaces the user's role**. `UserRepository.setOrg`
  (`userRepo.ts` 94-107) updates `company_id`/`org_unit_id` (and cascades host/
  note company) but leaves `role` untouched — and does so in **three separate
  autocommit statements (no transaction)**.
- **Exploit path:** super-admin moves user U (role = custom R owned by Company A)
  to Company B → `user.company_id = B` but `role.company_id = A`. Company A's
  admin editing R then changes U's effective permissions (via
  `RoleService.reload()`), retaining influence over a Company B user.
- **Affected:** `routes/organization.ts`, `repos/userRepo.ts` (`setOrg`),
  `server.ts` wiring; invariant `user.company_id == role.company_id` for custom roles.
- **Fix:** validate/replace role on move + make the whole move atomic (txn) +
  fix org-unit check to use the resolved destination company.

### AWM-MIG-001 — unsafe historical role tenant backfill (P1) — CONFIRMED
- **Evidence:** `migrations/022_roles_company.up.sql` backfills a custom role's
  `company_id` from `SELECT u.company_id … WHERE u.role = r.key LIMIT 1`. For a
  role historically used by users in multiple companies, it picks ONE company;
  users in the others keep the role while it is now owned by a different tenant.
- **Fix:** a NEW migration (`024`) that splits multi-company custom roles into
  tenant-owned equivalents, reassigns users to their own company's role, fixes
  single-company mismatches, and FAILS if any cross-tenant assignment remains.
  022 is left untouched (already applied).

### AWM-SEC-019A — legacy browser refresh token in localStorage (P2) — CONFIRMED
- **Evidence:** older browser builds stored the refresh token under
  `netsphere.refresh_token` in `localStorage` (`authStore.ts` REFRESH_KEY). The
  new cookie design no longer writes it, but a stale value can persist.
- **Fix:** explicitly `localStorage.removeItem("netsphere.refresh_token")` at
  browser startup (not Tauri), + repo search for other legacy long-lived keys.

## Priority
1. SEC-020  2. MIG-001  3. SEC-019A  4. fresh RBAC/tenant review  5. full
regression  6. final gate (`FINAL_RBAC_TENANT_SECURITY_REPORT.md`).
