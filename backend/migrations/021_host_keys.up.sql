-- =====================================================================
-- 021 — SSH host-key pinning (known_hosts)
-- =====================================================================
-- The SSH/SFTP/tunnel gateways previously accepted ANY server host key on
-- every connection (`hostVerifier: () => true`) and never detected a change —
-- so a man-in-the-middle presenting a different key was silently trusted.
--
-- This table records the key we first saw for each (hostname, port). On later
-- connections the gateway compares the presented key's fingerprint: a match is
-- trusted, a first sighting is pinned (TOFU), and a MISMATCH is refused with a
-- security warning (possible MITM / unexpected key rotation). Re-pinning after
-- a legitimate rotation is done by deleting the row for that host:port.

CREATE TABLE IF NOT EXISTS host_keys (
  id         BIGSERIAL PRIMARY KEY,
  hostname   TEXT NOT NULL,
  port       INTEGER NOT NULL,
  key_hash   TEXT NOT NULL,           -- "SHA256:<base64>" of the server key blob
  key_type   TEXT,                    -- informational (e.g. ssh-ed25519), best-effort
  first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (hostname, port)
);
