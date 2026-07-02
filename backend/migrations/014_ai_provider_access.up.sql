-- =====================================================================
-- 014 — Per-provider access control for organization AI providers
-- =====================================================================
-- An org provider can be limited to specific roles and/or specific users.
-- Empty on both = available to everyone in the company (with ai:use).
ALTER TABLE ai_providers
  ADD COLUMN IF NOT EXISTS allow_roles TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS allow_users UUID[] NOT NULL DEFAULT '{}';
