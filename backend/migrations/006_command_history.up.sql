-- =====================================================================
-- 006 — Command history (per-user, opt-in)
-- =====================================================================
-- Stores individual shell commands a user ran in a browser SSH session,
-- but ONLY when that user has explicitly enabled "Save command history".
-- It is off by default (commands may contain typed secrets), self-scoped
-- to the owning user, and append-only. Rows survive host deletion via the
-- host_label snapshot.

CREATE TABLE command_history (
  id         BIGSERIAL PRIMARY KEY,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  host_id    UUID REFERENCES hosts(id) ON DELETE SET NULL,
  host_label TEXT,
  command    TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX command_history_user_id_idx ON command_history (user_id, created_at DESC);
CREATE INDEX command_history_host_id_idx ON command_history (host_id);
