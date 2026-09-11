-- =====================================================================
-- 024 — Repair cross-tenant custom-role assignments (AWM-MIG-001)
-- =====================================================================
-- Migration 022 backfilled each custom role's company_id from ONE of its users
-- (LIMIT 1). For a custom role historically shared across companies, that left
-- users in the OTHER companies holding a role now owned by a different tenant
-- (user.company_id != role.company_id) — a P1 tenant-integrity break.
--
-- This migration (022 is left untouched — never edit an applied migration):
--   1. For each custom role that has users, pick a company to KEEP on the
--      original role (deterministically): its current company_id if that
--      company actually uses it, else the company with the most users on it
--      (ties broken by company uuid).
--   2. For every OTHER company that uses the role, create a tenant-owned clone
--      (same permissions + display name, deterministic unique key) and reassign
--      that company's users to the clone.
--   3. Align any residual NULL-company user holding a custom role to that role's
--      company (evidence-based: their existing role's tenant).
--   4. FAIL the migration if any cross-tenant assignment still remains, rather
--      than shipping a partially-migrated authorization state.
--
-- Unused custom roles (no assigned users) keep their existing owner (documented
-- policy — no evidence to re-tenant them, and no user is affected).
-- Idempotent: re-running finds each role used by a single company and no-ops.

DO $$
DECLARE
  rec   RECORD;
  comp  RECORD;
  keep_company UUID;
  clone_key TEXT;
BEGIN
  FOR rec IN
    SELECT r.id, r.key, r.name, r.description, r.permissions
    FROM roles r
    WHERE r.is_builtin = FALSE
      AND EXISTS (SELECT 1 FROM users u WHERE u.role = r.key AND u.company_id IS NOT NULL)
  LOOP
    -- (1) company to keep on the original role: prefer the current owner if it
    -- has users on this role, else the modal company (deterministic).
    SELECT r2.company_id INTO keep_company
      FROM roles r2
     WHERE r2.id = rec.id
       AND EXISTS (SELECT 1 FROM users u WHERE u.role = rec.key AND u.company_id = r2.company_id);
    IF keep_company IS NULL THEN
      SELECT u.company_id INTO keep_company
        FROM users u
       WHERE u.role = rec.key AND u.company_id IS NOT NULL
       GROUP BY u.company_id
       ORDER BY COUNT(*) DESC, u.company_id ASC
       LIMIT 1;
    END IF;

    UPDATE roles SET company_id = keep_company, updated_at = NOW() WHERE id = rec.id;

    -- (2) clone for every other company that uses the role.
    FOR comp IN
      SELECT DISTINCT u.company_id AS cid
        FROM users u
       WHERE u.role = rec.key AND u.company_id IS NOT NULL AND u.company_id <> keep_company
    LOOP
      clone_key := left(rec.key, 40) || '__c' || replace(comp.cid::text, '-', '');
      IF NOT EXISTS (SELECT 1 FROM roles WHERE key = clone_key) THEN
        INSERT INTO roles (key, name, description, permissions, is_builtin, company_id)
        VALUES (clone_key, rec.name, rec.description, rec.permissions, FALSE, comp.cid);
      ELSE
        -- keep an existing clone's permission set in sync with the source role.
        UPDATE roles SET permissions = rec.permissions, name = rec.name, description = rec.description, company_id = comp.cid, updated_at = NOW()
         WHERE key = clone_key;
      END IF;
      UPDATE users SET role = clone_key, updated_at = NOW()
       WHERE role = rec.key AND company_id = comp.cid;
    END LOOP;
  END LOOP;

  -- (3) residual NULL-company users on a custom role → adopt the role's company.
  UPDATE users u
     SET company_id = r.company_id, updated_at = NOW()
    FROM roles r
   WHERE r.key = u.role AND r.is_builtin = FALSE
     AND u.company_id IS NULL AND r.company_id IS NOT NULL;

  -- (4) hard invariant: no cross-tenant custom-role assignment may remain.
  IF EXISTS (
    SELECT 1 FROM users u JOIN roles r ON r.key = u.role
     WHERE r.is_builtin = FALSE AND u.company_id IS DISTINCT FROM r.company_id
  ) THEN
    RAISE EXCEPTION 'cross-tenant custom-role assignments remain after repair (AWM-MIG-001)';
  END IF;
END $$;
