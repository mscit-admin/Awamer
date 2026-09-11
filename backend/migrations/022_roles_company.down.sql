-- Rollback 022 — remove tenant ownership from custom roles.
DROP INDEX IF EXISTS roles_company_id_idx;
ALTER TABLE roles DROP COLUMN IF EXISTS company_id;
