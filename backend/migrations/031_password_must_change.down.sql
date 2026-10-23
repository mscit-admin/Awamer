ALTER TABLE users
  DROP COLUMN IF EXISTS temp_password_expires_at,
  DROP COLUMN IF EXISTS password_must_change;
