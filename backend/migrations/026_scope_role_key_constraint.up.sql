-- =====================================================================
-- 026 — Scope the role-key length constraint to the roles table (AWM-MIG-004)
-- =====================================================================
-- Migration 025 guarded its ceiling constraint with
--   IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'roles_key_len_chk')
-- but a constraint NAME is not unique across relations/schemas. If a constraint
-- of that name existed on a DIFFERENT table, 025's guard would skip adding it to
-- `roles`, leaving `roles` without its intended CHECK. 025 is shipped and left
-- untouched; this migration ensures the constraint exists SPECIFICALLY on the
-- `roles` relation using a properly-scoped `conrelid` check.
--
-- Idempotent: if `roles` already carries `roles_key_len_chk` (the normal case
-- after 025) this is a no-op — no duplicate constraint. A same-named constraint
-- on any other table is irrelevant to this check.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'roles_key_len_chk'
       AND conrelid = 'roles'::regclass
  ) THEN
    ALTER TABLE roles ADD CONSTRAINT roles_key_len_chk CHECK (char_length(key) <= 48);
  END IF;
END $$;
