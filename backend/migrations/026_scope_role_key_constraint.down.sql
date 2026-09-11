-- No-op rollback. This migration only ensures the `roles_key_len_chk` CHECK is
-- present on the `roles` relation (it may have been added by migration 025).
-- Ownership of that constraint's lifecycle stays with 025, whose down migration
-- drops it; dropping it here as well would be redundant and could fight 025's
-- rollback ordering. Rolling back this migration is therefore intentionally a
-- no-op.
SELECT 1;
