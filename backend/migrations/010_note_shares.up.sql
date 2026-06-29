-- =====================================================================
-- 010 — Note sharing
-- =====================================================================
-- Notes can be shared instance-wide (notes.is_shared) and/or with specific
-- users (note_shares). A user sees a note if they own it, it's shared with
-- everyone, or there's a note_shares row for them. Recipients get read-only
-- access (only the owner can edit/delete).

ALTER TABLE notes ADD COLUMN is_shared BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE note_shares (
  note_id    BIGINT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  user_id    UUID   NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (note_id, user_id)
);
CREATE INDEX note_shares_user_id_idx ON note_shares (user_id);
