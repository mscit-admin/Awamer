-- =====================================================================
-- 001 — Authentication foundation (Phase 1)
-- =====================================================================
-- Tables consumed by: userRepo.ts, otherRepos.ts (MFA / refresh / audit).
-- Reconstructed from the repository column contracts.

CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid()

-- ---------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------
CREATE TABLE users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username        TEXT NOT NULL,
  email           TEXT NOT NULL,
  password_hash   TEXT NOT NULL,
  full_name       TEXT,
  role            TEXT NOT NULL DEFAULT 'user'
                    CHECK (role IN ('super_admin','admin','user','readonly','auditor')),
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  is_locked       BOOLEAN NOT NULL DEFAULT FALSE,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  last_login_at   TIMESTAMPTZ,
  last_login_ip   INET,
  mfa_enabled     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Column-named constraints: the user repo inspects err.constraint on a
-- 23505 and maps "username"/"email" matches to UsernameTaken/EmailTaken.
ALTER TABLE users ADD CONSTRAINT users_username_key UNIQUE (username);
ALTER TABLE users ADD CONSTRAINT users_email_key    UNIQUE (email);

-- ---------------------------------------------------------------------
-- mfa_devices
-- ---------------------------------------------------------------------
CREATE TABLE mfa_devices (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_name  TEXT NOT NULL,
  device_type  TEXT NOT NULL DEFAULT 'totp'
                 CHECK (device_type IN ('totp','webauthn','backup_codes')),
  secret_enc   BYTEA NOT NULL,
  is_primary   BOOLEAN NOT NULL DEFAULT FALSE,
  last_used_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX mfa_devices_user_id_idx ON mfa_devices (user_id);

-- ---------------------------------------------------------------------
-- refresh_sessions  (refresh-token rotation chain)
-- ---------------------------------------------------------------------
CREATE TABLE refresh_sessions (
  jti        TEXT PRIMARY KEY,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  rotated_to TEXT
);
CREATE INDEX refresh_sessions_user_id_idx ON refresh_sessions (user_id);

-- ---------------------------------------------------------------------
-- audit_logs
-- ---------------------------------------------------------------------
CREATE TABLE audit_logs (
  id            BIGSERIAL PRIMARY KEY,
  "timestamp"   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
  action        TEXT NOT NULL,
  resource_type TEXT,
  resource_id   TEXT,
  ip_address    INET,
  user_agent    TEXT,
  details       JSONB NOT NULL DEFAULT '{}'::jsonb,
  success       BOOLEAN NOT NULL
);
CREATE INDEX audit_logs_user_id_idx   ON audit_logs (user_id);
CREATE INDEX audit_logs_timestamp_idx ON audit_logs ("timestamp" DESC);
