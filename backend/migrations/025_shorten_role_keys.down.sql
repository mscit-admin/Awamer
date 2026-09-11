-- Rollback: drop only the CHECK constraint added by the up migration. The key
-- renames themselves are NOT reversed — restoring the original 75-char keys
-- would re-break the API's max(48) validation (the very defect this migration
-- fixes) and there is no lossless way to recover which shortened key mapped to
-- which original. Restore from a backup if a full revert is ever required.
ALTER TABLE roles DROP CONSTRAINT IF EXISTS roles_key_len_chk;
