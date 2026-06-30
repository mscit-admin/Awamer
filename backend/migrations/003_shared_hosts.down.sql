-- Roll back 003 — shared hosts.
DROP INDEX IF EXISTS hosts_is_shared_idx;
ALTER TABLE hosts DROP COLUMN IF EXISTS is_shared;
