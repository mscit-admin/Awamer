-- =====================================================================
-- 003 — Shared hosts (Assets sharing)
-- =====================================================================
-- A host can be shared with all users on the instance. Shared hosts are
-- visible and connectable by everyone, but remain editable only by their
-- owner. Connecting users authenticate with the owner's linked credential
-- (resolved server-side; the secret is never exposed to them).

ALTER TABLE hosts ADD COLUMN is_shared BOOLEAN NOT NULL DEFAULT FALSE;

-- Partial index: most hosts are private, so only index the shared ones.
CREATE INDEX hosts_is_shared_idx ON hosts (is_shared) WHERE is_shared;
