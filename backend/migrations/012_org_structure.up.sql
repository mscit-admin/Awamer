-- =====================================================================
-- 012 — Organizational structure & multi-company foundation
-- =====================================================================
-- Introduces companies (tenants) and an arbitrary-depth organizational
-- hierarchy (departments → sections → units → …) scoped to a company, and
-- attaches every user to a company (+ optional org unit).
--
-- A Super Admin manages companies (companies:manage); company admins manage
-- their own org tree (org:manage). Existing users are moved to a seeded
-- "Default" company so nothing breaks.

-- Companies (tenants).
CREATE TABLE IF NOT EXISTS companies (
  id         UUID PRIMARY KEY,
  name       TEXT NOT NULL,
  slug       TEXT UNIQUE,
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Organizational hierarchy: a self-referential tree, one forest per company.
-- `kind` is a free label (department/section/unit/…) so depth is unbounded.
CREATE TABLE IF NOT EXISTS org_units (
  id         UUID PRIMARY KEY,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  parent_id  UUID REFERENCES org_units(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'unit',
  sort       INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_org_units_company ON org_units(company_id);
CREATE INDEX IF NOT EXISTS idx_org_units_parent  ON org_units(parent_id);

-- Attach users to a company (+ optional org unit).
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS company_id  UUID REFERENCES companies(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS org_unit_id UUID REFERENCES org_units(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_users_company ON users(company_id);

-- Seed a default company and move existing users into it.
INSERT INTO companies (id, name, slug)
  VALUES ('11111111-1111-1111-1111-111111111111', 'Default', 'default')
  ON CONFLICT (id) DO NOTHING;
UPDATE users SET company_id = '11111111-1111-1111-1111-111111111111' WHERE company_id IS NULL;

-- Grant the new permissions to the built-in roles.
UPDATE roles
   SET permissions = array_append(permissions, 'companies:manage'), updated_at = NOW()
 WHERE key = 'super_admin' AND NOT ('companies:manage' = ANY(permissions));
UPDATE roles
   SET permissions = array_append(permissions, 'org:manage'), updated_at = NOW()
 WHERE key IN ('super_admin', 'admin') AND NOT ('org:manage' = ANY(permissions));
