-- =====================================================================
-- 020 — Tenant-scope shared resources (SEC-003)
-- =====================================================================
-- `hosts` and `notes` predate the multi-company model (migration 012) and were
-- scoped only by `user_id`. Their `is_shared = TRUE` flag made a resource
-- visible to EVERY user on the installation — across company/tenant
-- boundaries. Because a shared host resolves the OWNER's linked credential
-- server-side, a user in Company B could open sessions against Company A's
-- servers with Company A's secrets.
--
-- Fix: tag each shared-capable resource with the owner's `company_id` and scope
-- the shared-visibility queries by it (done in the repositories). This
-- migration adds and backfills the column; it does not change sharing UX.
--
-- Backfill: every existing host/note is tagged with its owner's current
-- company. Post-012 all users belong to a company (the seeded "Default"), so
-- no row is left NULL in practice; the repo predicate fails closed (a NULL
-- company never matches) if one ever is.

SET LOCAL lock_timeout = '30s';
SET LOCAL statement_timeout = '120s';

-- ---- hosts ----------------------------------------------------------
ALTER TABLE hosts
  ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id) ON DELETE SET NULL;

UPDATE hosts h
   SET company_id = u.company_id
  FROM users u
 WHERE u.id = h.user_id
   AND h.company_id IS NULL;

CREATE INDEX IF NOT EXISTS hosts_company_id_idx ON hosts (company_id) WHERE is_shared;

-- ---- notes ----------------------------------------------------------
ALTER TABLE notes
  ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id) ON DELETE SET NULL;

UPDATE notes n
   SET company_id = u.company_id
  FROM users u
 WHERE u.id = n.user_id
   AND n.company_id IS NULL;

CREATE INDEX IF NOT EXISTS notes_company_id_idx ON notes (company_id) WHERE is_shared;
