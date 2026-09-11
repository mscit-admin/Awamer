-- =====================================================================
-- 022 — Tenant ownership for custom roles (SEC-016 Rule D)
-- =====================================================================
-- Custom roles were global: any `users:manage` admin in any company could
-- edit/assign any custom role. Tie each custom role to a company so a role
-- created for Company A cannot be edited or assigned by Company B.
--
-- Built-in roles stay global (company_id NULL) — they are shared, locked, and
-- reconciled from code on every startup.

SET LOCAL lock_timeout = '30s';
SET LOCAL statement_timeout = '120s';

ALTER TABLE roles
  ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id) ON DELETE CASCADE;

-- Backfill: a custom role's tenant = the company of a user who holds it.
UPDATE roles r
   SET company_id = (
     SELECT u.company_id FROM users u
      WHERE u.role = r.key AND u.company_id IS NOT NULL
      LIMIT 1
   )
 WHERE r.is_builtin = FALSE AND r.company_id IS NULL;

-- Any custom role held by nobody → the seeded Default company (not random:
-- pre-multi-company users all belonged to Default). A super-admin can move it.
UPDATE roles
   SET company_id = '11111111-1111-1111-1111-111111111111'
 WHERE is_builtin = FALSE AND company_id IS NULL
   AND EXISTS (SELECT 1 FROM companies WHERE id = '11111111-1111-1111-1111-111111111111');

CREATE INDEX IF NOT EXISTS roles_company_id_idx ON roles (company_id) WHERE NOT is_builtin;
