-- Revert to the fixed-enum role model. Any users on a custom role are reset to
-- 'user' first so the CHECK constraint can be re-applied.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_fkey;

UPDATE users SET role = 'user'
 WHERE role NOT IN ('super_admin','admin','user','readonly','auditor');

ALTER TABLE users
  ADD CONSTRAINT users_role_check CHECK (role IN ('super_admin','admin','user','readonly','auditor'));

DROP TABLE IF EXISTS roles;
