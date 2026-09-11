-- =====================================================================
-- 025 — Shorten over-length custom-role keys (AWM-MIG-002)
-- =====================================================================
-- Migration 024 cloned cross-tenant custom roles with a key of the form
--   left(source_key, 40) || '__c' || <company-uuid-hex>
-- which is up to 40 + 3 + 32 = 75 characters. The REST API validates every
-- role key at max(48) (admin user create/patch, org user assignment), so a
-- user migrated onto such a clone holds a role the API can no longer re-assign
-- or manage (400 validation_failed). The DB accepted it because roles.key is
-- TEXT with no length limit.
--
-- 024 is a shipped, applied migration and is left untouched. This migration
-- deterministically rewrites any custom-role key longer than 48 chars to a
-- collision-resistant 48-char form and then locks the invariant with a CHECK:
--
--   new_key := left(key, 34) || '__' || substr(md5(key), 1, 12)   -- exactly 48
--
-- The source key is UNIQUE, so md5(key) inputs are distinct; a clash needs a
-- 48-bit md5-prefix collision between two roles (negligible). We still fail the
-- migration if a generated key would collide with a DIFFERENT existing role,
-- rather than ship a broken authorization state. Only the `key` column changes;
-- name/description/permissions/company_id stay put and users.role follows via
-- the ON UPDATE CASCADE foreign key. Built-in role keys are all short and are
-- never touched. Idempotent: a re-run finds no key > 48 and no-ops.

DO $$
DECLARE
  rec     RECORD;
  new_key TEXT;
BEGIN
  FOR rec IN
    SELECT id, key
      FROM roles
     WHERE is_builtin = FALSE
       AND char_length(key) > 48
     ORDER BY key
  LOOP
    new_key := left(rec.key, 34) || '__' || substr(md5(rec.key), 1, 12);

    -- Defensive: never collapse two distinct roles onto one key.
    IF EXISTS (SELECT 1 FROM roles WHERE key = new_key AND id <> rec.id) THEN
      RAISE EXCEPTION
        'role-key shortening collision for role % (generated key %)', rec.id, new_key;
    END IF;

    -- users.role cascades via users_role_fkey ON UPDATE CASCADE.
    UPDATE roles SET key = new_key, updated_at = NOW() WHERE id = rec.id;
  END LOOP;

  -- Lock the DB to the API ceiling now that all rows comply. Guarded so a
  -- re-run (or a manual replay of this migration) does not error on the
  -- already-present constraint.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'roles_key_len_chk'
  ) THEN
    ALTER TABLE roles ADD CONSTRAINT roles_key_len_chk CHECK (char_length(key) <= 48);
  END IF;
END $$;
