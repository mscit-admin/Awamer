-- =====================================================================
-- 002 — Session management (Phase 2)
-- =====================================================================
-- Tables consumed by sessionRepos.ts: folders, tags, credentials, hosts,
-- host_tags (M2M), connection_history.

-- ---------------------------------------------------------------------
-- folders  (self-referential tree)
-- ---------------------------------------------------------------------
CREATE TABLE folders (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id  UUID REFERENCES folders(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  color      TEXT,
  icon       TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Unique name per (user, parent). COALESCE so root-level (NULL parent)
-- duplicates are also rejected — plain UNIQUE treats NULLs as distinct.
CREATE UNIQUE INDEX folders_user_parent_name_key
  ON folders (user_id, COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), name);
CREATE INDEX folders_user_id_idx ON folders (user_id);

-- ---------------------------------------------------------------------
-- tags
-- ---------------------------------------------------------------------
CREATE TABLE tags (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  color      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT tags_user_name_key UNIQUE (user_id, name)
);

-- ---------------------------------------------------------------------
-- credentials  (secret_data encrypted at rest — Phase 10)
-- ---------------------------------------------------------------------
CREATE TABLE credentials (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  credential_type TEXT NOT NULL DEFAULT 'password'
                    CHECK (credential_type IN
                      ('password','private_key','certificate','agent','kerberos','none')),
  username        TEXT,
  secret_data     JSONB NOT NULL DEFAULT '{}'::jsonb,
  description     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT credentials_user_name_key UNIQUE (user_id, name)
);
CREATE INDEX credentials_user_id_idx ON credentials (user_id);

-- ---------------------------------------------------------------------
-- hosts
-- ---------------------------------------------------------------------
CREATE TABLE hosts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  folder_id     UUID REFERENCES folders(id) ON DELETE SET NULL,
  credential_id UUID REFERENCES credentials(id) ON DELETE SET NULL,
  name          TEXT NOT NULL,
  hostname      TEXT NOT NULL,
  port          INTEGER NOT NULL,
  protocol      TEXT NOT NULL
                  CHECK (protocol IN
                    ('ssh','sftp','rdp','vnc','telnet','serial','http','https','custom')),
  description   TEXT,
  is_favorite   BOOLEAN NOT NULL DEFAULT FALSE,
  options       JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_used_at  TIMESTAMPTZ,
  use_count     INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT hosts_user_name_key UNIQUE (user_id, name)
);
CREATE INDEX hosts_user_id_idx   ON hosts (user_id);
CREATE INDEX hosts_folder_id_idx ON hosts (folder_id);

-- ---------------------------------------------------------------------
-- host_tags  (M2M between hosts and tags)
-- ---------------------------------------------------------------------
CREATE TABLE host_tags (
  host_id UUID NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  tag_id  UUID NOT NULL REFERENCES tags(id)  ON DELETE CASCADE,
  PRIMARY KEY (host_id, tag_id)
);
CREATE INDEX host_tags_tag_id_idx ON host_tags (tag_id);

-- ---------------------------------------------------------------------
-- connection_history  (append-only; survives host deletion via snapshots)
-- ---------------------------------------------------------------------
CREATE TABLE connection_history (
  id                 BIGSERIAL PRIMARY KEY,
  user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  host_id            UUID REFERENCES hosts(id) ON DELETE SET NULL,
  host_name_snapshot TEXT NOT NULL,
  hostname_snapshot  TEXT NOT NULL,
  port_snapshot      INTEGER NOT NULL,
  protocol           TEXT NOT NULL,
  started_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at           TIMESTAMPTZ,
  duration_ms        BIGINT,
  status             TEXT NOT NULL DEFAULT 'started'
                       CHECK (status IN
                         ('started','connected','authenticated','closed','failed','timeout')),
  error_message      TEXT,
  client_ip          INET,
  bytes_in           BIGINT NOT NULL DEFAULT 0,
  bytes_out          BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX connection_history_user_started_idx ON connection_history (user_id, started_at DESC);
CREATE INDEX connection_history_host_id_idx      ON connection_history (host_id);
