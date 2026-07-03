-- Roll back 016 — credential TOTP + attachments.
DROP TABLE IF EXISTS credential_attachments;
DROP TABLE IF EXISTS credential_totp;
