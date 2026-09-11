-- Rollback 020 — remove the tenant tag from shared-capable resources.
-- Reverts to installation-wide `is_shared` semantics (the pre-020 behaviour).
DROP INDEX IF EXISTS notes_company_id_idx;
ALTER TABLE notes DROP COLUMN IF EXISTS company_id;

DROP INDEX IF EXISTS hosts_company_id_idx;
ALTER TABLE hosts DROP COLUMN IF EXISTS company_id;
