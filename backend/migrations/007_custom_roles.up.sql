-- =====================================================================
-- 007 — Custom roles
-- =====================================================================
-- Move roles from a fixed CHECK-constrained enum on users.role to a
-- first-class `roles` table so admins can create their own roles and assign
-- them any subset of the (code-defined) permission catalog. The 5 original
-- roles are seeded as built-ins and locked. users.role becomes a FK to
-- roles.key (ON UPDATE CASCADE so a future rename stays consistent).

CREATE TABLE roles (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key         TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  description TEXT,
  permissions TEXT[] NOT NULL DEFAULT '{}',
  is_builtin  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed the built-in roles with their current permission matrix.
INSERT INTO roles (key, name, description, permissions, is_builtin) VALUES
  ('super_admin', 'Super admin', 'Full access to everything.',
     ARRAY['resources:write','sessions:connect','credentials:reveal','tunnels:manage','backup:manage','users:manage','audit:read'], TRUE),
  ('admin', 'Admin', 'Full access to everything.',
     ARRAY['resources:write','sessions:connect','credentials:reveal','tunnels:manage','backup:manage','users:manage','audit:read'], TRUE),
  ('user', 'User', 'Self-service over own resources; no user administration.',
     ARRAY['resources:write','sessions:connect','credentials:reveal','tunnels:manage','backup:manage'], TRUE),
  ('readonly', 'Read-only', 'Browse the inventory; cannot modify, connect, or reveal secrets.',
     ARRAY[]::text[], TRUE),
  ('auditor', 'Auditor', 'Read-only plus access to audit logs.',
     ARRAY['audit:read'], TRUE);

-- Replace the CHECK constraint with a foreign key to roles.key.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users
  ADD CONSTRAINT users_role_fkey FOREIGN KEY (role) REFERENCES roles(key) ON UPDATE CASCADE;
