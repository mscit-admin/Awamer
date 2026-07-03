-- =====================================================================
-- 016 — Credential vault, phase 2/3 (TOTP + file attachments)
-- =====================================================================
-- Adds two sub-resources to a credential:
--   * credential_totp        — a KeePass-style OTP seed (one per credential)
--   * credential_attachments — encrypted file attachments (bytea, 5 MB cap
--                              enforced at the route layer)
-- Both are encrypted at rest with the same AES-256-GCM key as secret_data.

-- ---------------------------------------------------------------------
-- credential_totp  (1:1 with credentials)
-- ---------------------------------------------------------------------
-- secret_enc wraps { secret: <base32> } in the standard JSON envelope.
CREATE TABLE credential_totp (
  credential_id UUID PRIMARY KEY REFERENCES credentials(id) ON DELETE CASCADE,
  secret_enc    JSONB NOT NULL,
  algorithm     TEXT    NOT NULL DEFAULT 'SHA1'
                  CHECK (algorithm IN ('SHA1','SHA256','SHA512')),
  digits        INTEGER NOT NULL DEFAULT 6  CHECK (digits BETWEEN 6 AND 8),
  period        INTEGER NOT NULL DEFAULT 30 CHECK (period BETWEEN 15 AND 60),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------
-- credential_attachments  (encrypted blobs in the DB)
-- ---------------------------------------------------------------------
-- blob_enc is the AES-256-GCM binary envelope (version|iv|tag|ciphertext).
-- size_bytes/sha256 describe the ORIGINAL plaintext for display + integrity.
CREATE TABLE credential_attachments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  credential_id UUID NOT NULL REFERENCES credentials(id) ON DELETE CASCADE,
  filename      TEXT NOT NULL,
  mime_type     TEXT NOT NULL DEFAULT 'application/octet-stream',
  size_bytes    INTEGER NOT NULL,
  sha256        TEXT NOT NULL,
  blob_enc      BYTEA NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX credential_attachments_credential_id_idx ON credential_attachments (credential_id);
