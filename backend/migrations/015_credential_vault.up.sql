-- =====================================================================
-- 015 — Credential vault, phase 1 (organization + custom fields)
-- =====================================================================
-- Turns the flat credential store into a KeePass-style vault:
--   * credentials can live in a folder (reusing the existing `folders` tree)
--   * credentials can be favorited and given an expiry date
--   * arbitrary custom fields (secret or plain) can hang off a credential,
--     encrypted at rest with the same AES-256-GCM envelope as secret_data.
-- Later phases add per-credential TOTP, file attachments, sealed
-- (zero-knowledge) mode, and team sharing.

-- ---------------------------------------------------------------------
-- credentials: organization + lifecycle columns
-- ---------------------------------------------------------------------
ALTER TABLE credentials
  ADD COLUMN folder_id  UUID REFERENCES folders(id) ON DELETE SET NULL,
  ADD COLUMN favorite   BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN expires_at TIMESTAMPTZ;

CREATE INDEX credentials_folder_id_idx ON credentials (folder_id);

-- ---------------------------------------------------------------------
-- credential_fields: KeePass-style advanced fields
-- ---------------------------------------------------------------------
-- value_enc holds the AES-256-GCM envelope (same shape as credentials.secret_data)
-- produced by secretBox — never plaintext. is_secret controls UI masking and
-- whether the value is withheld from the public (non-reveal) projection.
CREATE TABLE credential_fields (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  credential_id UUID NOT NULL REFERENCES credentials(id) ON DELETE CASCADE,
  label         TEXT NOT NULL,
  value_enc     JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_secret     BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX credential_fields_credential_id_idx ON credential_fields (credential_id);
