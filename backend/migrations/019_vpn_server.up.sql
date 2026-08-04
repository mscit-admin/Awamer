-- =====================================================================
-- 019 — Awamer as an OpenVPN *server* (VPN hub)
-- =====================================================================
-- Awamer can host OpenVPN server instances so remote machines behind NAT (no
-- public IP) dial in and become reachable. Each server owns a small CA (cert +
-- encrypted key), a server cert, and a tls-crypt key; each client/user gets a
-- CA-signed cert plus a username/password (cert AND password auth). All private
-- key material and passwords are encrypted at rest with the same AES-256-GCM
-- SecretBox as other secrets. Revocation is enforced by the password-verify
-- step (a revoked client fails auth), so no CRL is needed.

CREATE TABLE vpn_servers (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  description      TEXT,
  -- Public endpoint clients connect to (baked into the downloaded .ovpn).
  public_host      TEXT NOT NULL,
  port             INTEGER NOT NULL DEFAULT 1194,
  proto            TEXT NOT NULL DEFAULT 'udp' CHECK (proto IN ('udp', 'tcp')),
  -- VPN subnet handed to clients, and options pushed to them.
  subnet           TEXT NOT NULL DEFAULT '10.8.0.0/24',
  dns              TEXT,
  client_to_client BOOLEAN NOT NULL DEFAULT TRUE,
  cipher           TEXT NOT NULL DEFAULT 'AES-256-GCM',
  -- PKI: public certs stored plain; private keys + tls-crypt encrypted.
  ca_cert          TEXT NOT NULL,
  ca_key_enc       JSONB NOT NULL DEFAULT '{}'::jsonb,
  server_cert      TEXT NOT NULL,
  server_key_enc   JSONB NOT NULL DEFAULT '{}'::jsonb,
  tls_crypt_enc    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT vpn_servers_user_name_key UNIQUE (user_id, name)
);
CREATE INDEX vpn_servers_user_id_idx ON vpn_servers (user_id);

CREATE TABLE vpn_server_clients (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id     UUID NOT NULL REFERENCES vpn_servers(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  username      TEXT NOT NULL,
  password_hash TEXT NOT NULL,          -- argon2, checked by the auth-verify step
  password_enc  JSONB NOT NULL DEFAULT '{}'::jsonb, -- encrypted plaintext (admin reveal)
  cert          TEXT NOT NULL,          -- CA-signed client cert (PEM)
  key_enc       JSONB NOT NULL DEFAULT '{}'::jsonb, -- encrypted client private key
  revoked       BOOLEAN NOT NULL DEFAULT FALSE,
  revoked_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT vpn_server_clients_username_key UNIQUE (server_id, username),
  CONSTRAINT vpn_server_clients_name_key     UNIQUE (server_id, name)
);
CREATE INDEX vpn_server_clients_server_id_idx ON vpn_server_clients (server_id);
