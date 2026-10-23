-- SEC-PW-TEMP-001 (ASVS V6.4.1 / V6.4.6): a password set by someone other than
-- the account owner (admin create/reset, bootstrap) is temporary. The user must
-- replace it before doing anything else, and an unused temporary password
-- stops working after temp_password_expires_at (NULL = no expiry, bootstrap).
ALTER TABLE users
  ADD COLUMN password_must_change BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN temp_password_expires_at TIMESTAMPTZ NULL;
