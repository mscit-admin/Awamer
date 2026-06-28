-- =====================================================================
-- 004 — Per-user host sharing
-- =====================================================================
-- In addition to instance-wide sharing (hosts.is_shared), a host can be
-- shared with specific users. A user sees a host if they own it, it's
-- shared with everyone, or there's a row here for them.

CREATE TABLE host_shares (
  host_id    UUID NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (host_id, user_id)
);
CREATE INDEX host_shares_user_id_idx ON host_shares (user_id);
