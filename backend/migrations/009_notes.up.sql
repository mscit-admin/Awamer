-- =====================================================================
-- 009 — User notes
-- =====================================================================
-- Personal, per-user notes. A note may optionally be tied to a host (e.g. one
-- jotted from that host's terminal); the host_label snapshot keeps it readable
-- if the host is later deleted.

CREATE TABLE notes (
  id         BIGSERIAL PRIMARY KEY,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  host_id    UUID REFERENCES hosts(id) ON DELETE SET NULL,
  host_label TEXT,
  title      TEXT,
  body       TEXT NOT NULL DEFAULT '',
  pinned     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX notes_user_id_idx ON notes (user_id, pinned DESC, updated_at DESC);
CREATE INDEX notes_host_id_idx ON notes (host_id);
