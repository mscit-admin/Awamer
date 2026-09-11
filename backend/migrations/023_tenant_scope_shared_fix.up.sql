-- =====================================================================
-- 023 — Ensure tenant scoping columns exist (heals a migration-number collision)
-- =====================================================================
-- On some production databases, version 20 was already recorded by a DIFFERENT
-- migration (`vpn_server_internet`) from an older code line, so this branch's
-- `020_tenant_scope_shared` was silently SKIPPED by the number-based runner and
-- `hosts.company_id` / `notes.company_id` were never created. That broke every
-- host list/create (SEC-003/SEC-015 queries reference those columns).
--
-- This migration re-asserts those columns idempotently, so any environment that
-- hit the collision is healed on the next deploy with no manual step, and it is
-- a no-op everywhere the columns already exist. (Kept in one txn by the runner,
-- so no SET LOCAL warnings.)

ALTER TABLE hosts
  ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id) ON DELETE SET NULL;
UPDATE hosts h
   SET company_id = u.company_id
  FROM users u
 WHERE u.id = h.user_id AND h.company_id IS NULL;
CREATE INDEX IF NOT EXISTS hosts_company_id_idx ON hosts (company_id) WHERE is_shared;

ALTER TABLE notes
  ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id) ON DELETE SET NULL;
UPDATE notes n
   SET company_id = u.company_id
  FROM users u
 WHERE u.id = n.user_id AND n.company_id IS NULL;
CREATE INDEX IF NOT EXISTS notes_company_id_idx ON notes (company_id) WHERE is_shared;
