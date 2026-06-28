-- =====================================================================
-- 005 — Application settings (key/value)
-- =====================================================================
-- Small key/value store for instance-wide settings editable from the UI
-- (e.g. branding: app_name, logo). Logo is stored as a data URI or URL.

CREATE TABLE app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
