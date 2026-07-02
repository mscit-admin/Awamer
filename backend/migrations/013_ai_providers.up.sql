-- =====================================================================
-- 013 — AI provider management (org + personal)
-- =====================================================================
-- Stores AI provider subscriptions at two scopes:
--   scope='org'  → owned by a company (company_id), managed by ai:manage.
--   scope='user' → owned by a user (user_id), managed by ai:use_personal.
-- The API key/secret is encrypted at rest (SecretBox JSONB envelope), never
-- returned to the client. The server proxies all AI calls.

CREATE TABLE IF NOT EXISTS ai_providers (
  id          UUID PRIMARY KEY,
  scope       TEXT NOT NULL CHECK (scope IN ('org','user')),
  company_id  UUID REFERENCES companies(id) ON DELETE CASCADE,
  user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
  provider    TEXT NOT NULL CHECK (provider IN ('anthropic','openai','google','azure','custom')),
  label       TEXT NOT NULL,
  model       TEXT NOT NULL,
  base_url    TEXT,
  secret_enc  JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_default  BOOLEAN NOT NULL DEFAULT FALSE,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Exactly one owner column is set, matching the scope.
  CONSTRAINT ai_providers_owner_ck CHECK (
    (scope = 'org'  AND company_id IS NOT NULL AND user_id IS NULL) OR
    (scope = 'user' AND user_id    IS NOT NULL AND company_id IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_ai_providers_company ON ai_providers(company_id);
CREATE INDEX IF NOT EXISTS idx_ai_providers_user    ON ai_providers(user_id);

-- Grant AI permissions to the built-in roles (also reconciled from code on
-- startup; this seeds existing installs immediately).
UPDATE roles SET permissions = array_append(permissions, 'ai:use'), updated_at = NOW()
 WHERE key IN ('super_admin','admin','user') AND NOT ('ai:use' = ANY(permissions));
UPDATE roles SET permissions = array_append(permissions, 'ai:use_personal'), updated_at = NOW()
 WHERE key IN ('super_admin','admin','user') AND NOT ('ai:use_personal' = ANY(permissions));
UPDATE roles SET permissions = array_append(permissions, 'ai:manage'), updated_at = NOW()
 WHERE key IN ('super_admin','admin') AND NOT ('ai:manage' = ANY(permissions));
