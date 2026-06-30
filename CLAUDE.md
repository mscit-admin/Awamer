# Awamer — project conventions for Claude

Awamer (a.k.a. NetSphere Terminal) is an enterprise remote-administration
platform: **Tauri + React + TypeScript + Vite + Tailwind** frontend (`desktop/`)
and a **Fastify + Node + PostgreSQL** backend (`backend/`, raw SQL via `pg`,
custom migration runner in `backend/migrations/NNN_name.{up,down}.sql`).

## RBAC rule (required)

**Every new feature that needs access control MUST ship its role/permission in
the same change — never piggyback on a generic permission and defer it.**

When adding such a feature:

1. Add the permission to the matrix in **both** places (they must stay mirrored):
   - `backend/src/domain/permissions.ts` — add to `PERMISSIONS` and grant it in
     `ROLE_PERMISSIONS` for the appropriate roles.
   - `desktop/src/shared/lib/permissions.ts` — add to `PERMISSIONS`,
     `ROLE_PERMISSIONS`, and `PERMISSION_LABEL`.
2. Enforce it on the server: gate the route/gateway with
   `requirePermission("<perm>")` (REST) or `can(role, "<perm>")` (WebSocket
   gateways). The server is the source of truth.
3. Gate the UI: hide nav/actions with `roleCan(...)` / `useCan(...)`. For
   sidebar entries set `perm` on the `NavItem` in
   `desktop/src/modules/dashboard/DashboardLayout.tsx`.
4. The **Roles & Permissions** page (`desktop/src/modules/users/RolesPage.tsx`)
   renders the matrix automatically — adding the permission + label is enough
   for it to appear.
5. Note the new permission and its default role grants in `CHANGELOG.md`.

Current permissions: `resources:write`, `sessions:connect`,
`credentials:reveal`, `tunnels:manage`, `backup:manage`,
`command_history:read`, `users:manage`, `audit:read` — defined in code; add new
ones here when a feature needs them.

**Roles are dynamic** (DB table `roles`, migration `007`). The 5 built-ins
(super_admin, admin, user, readonly, auditor) are seeded and **locked**; admins
create custom roles from the permission catalog via the Roles page. `can()` /
`permissionsFor()` resolve through `RoleService` (DB-backed resolver installed at
startup + reloaded on role changes). `users.role` is an FK to `roles.key`. The
server sends each user's **effective permissions** in the user payload; the
client gates UI off `user.permissions` (`useCan` / `hasPerm`), not a static
matrix. When adding a permission, update its grants in the built-in role
definitions in `permissions.ts` AND the seed in a new migration if you want
existing built-in roles to include it.

## General conventions

- **Migrations**: never edit a shipped migration; add a new
  `backend/migrations/NNN_*.{up,down}.sql` pair. `.gitignore` negates
  `backend/migrations/*.sql` — keep it that way. Migrations run automatically on
  backend startup in production (`node dist/migrate.js up`).
- **Credential secrets** are encrypted at rest (AES-256-GCM envelope via
  `backend/src/crypto/secretBox.ts`); `CREDENTIAL_ENCRYPTION_KEY` is mandatory
  in production. Never reintroduce plaintext secret storage.
- **Verify before committing**: backend `npx tsc --noEmit` + `npm test`;
  frontend `npx tsc --noEmit` + `npm run build`. For data/migration features,
  verify end-to-end against a real PostgreSQL.
- **CHANGELOG.md**: append an entry for every feature/fix (never delete past
  entries). Keep the README roadmap table in sync with what has shipped.
- **Deploy**: backend via `deploy/docker-compose.production.yml`; frontend is
  built (`VITE_API_BASE_URL=<https origin>` so API calls go same-origin via
  nginx) and copied to `/var/www/awamer/`.
