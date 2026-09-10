# Phase 1 — AWM-SEC-016 Custom-role privilege escalation (P0)

**Status:** FIXED · **Tests:** TEST-RBAC-001..008 PASS (integration, real PG)

## Root cause
`routes/roles.ts` create/update gated only on `users:manage` + catalog
membership — no permission ceiling — so any tenant admin could add
`companies:manage`/`credentials:reveal`/etc. to a role and (via
`roleService.reload()`) escalate their own already-issued JWT. `roles` had no
`company_id`, so custom roles were global and cross-tenant editable.

## Fix
- **Permission ceiling (Rule A/B/C):** `roles.ts` now rejects (403) any
  create/update whose requested permissions are not all held by the actor;
  `GLOBAL_ONLY_PERMISSIONS = {companies:manage}` additionally requires
  super-admin. Because a normal admin's effective set excludes
  `companies:manage`, self-escalation via editing one's own role is blocked at
  the source (no unheld permission can be added → `reload()` cannot escalate).
- **Tenant ownership (Rule D):** migration `022` adds `company_id` to `roles`
  (built-ins NULL/global; custom roles backfilled from a holder's company, else
  the seeded Default company). `roleRepo.listForCompany` scopes the catalog; the
  PATCH/DELETE handlers 404 (non-disclosing) on another tenant's custom role;
  create stamps the actor's company.
- **Assignment ceiling (Rule E):** `admin.ts` keeps `mayGrantRole` (perms ⊆
  caller) and adds `mayAssignRoleTenant` (a role is assignable only if built-in
  or owned by the actor's company; super-admin unrestricted) on user create and
  role change. `RoleService.tenantOf` exposes role ownership.
- **Audit:** denied create/update attempts log `role_*_denied` with the
  offending permission.

## Affected files
`migrations/022_roles_company.{up,down}.sql`, `routes/roles.ts`,
`repos/roleRepo.ts`, `domain/roleService.ts`, `routes/admin.ts`, `server.ts`.

## Evidence (all via app.inject on the real routes)
| Test | Assertion | Result |
| --- | --- | --- |
| RBAC-001 | tenant admin adds `companies:manage` → 403 | PASS |
| RBAC-002 | tenant admin adds unheld `credentials:reveal` → 403 | PASS |
| RBAC-003 | tenant admin sets only held perms → 200 | PASS |
| RBAC-004 | tenant admin A edits company B role → 404 | PASS |
| RBAC-005 | admin assigns super_admin to self → 403 | PASS |
| RBAC-006 | admin assigns super_admin to other → 403 | PASS |
| RBAC-007 | blocked escalation left no extra perm on the role | PASS |
| RBAC-008 | super-admin grants global perm → 200 | PASS |

Full suite after phase: backend **73 unit / 17 integration**, tsc clean.

## Regression risk
Medium (role CRUD + new column). Mitigated: built-in flow unchanged; existing
role tests + full suite green; migration idempotent & rollback-safe.
