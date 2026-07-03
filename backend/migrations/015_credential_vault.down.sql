-- Roll back 015 — credential vault phase 1.
DROP TABLE IF EXISTS credential_fields;
DROP INDEX IF EXISTS credentials_folder_id_idx;
ALTER TABLE credentials
  DROP COLUMN IF EXISTS folder_id,
  DROP COLUMN IF EXISTS favorite,
  DROP COLUMN IF EXISTS expires_at;
