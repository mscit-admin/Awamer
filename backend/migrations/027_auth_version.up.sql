-- SEC-SESSION-001: per-user security version. Incremented on any security-
-- sensitive credential change (password / MFA), invalidating every previously
-- issued access token (whose `av` claim no longer matches) and forcing re-auth.
ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_version INTEGER NOT NULL DEFAULT 1;
