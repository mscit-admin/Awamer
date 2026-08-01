-- =====================================================================
-- 017 — OpenVPN client profiles & asset/folder association
-- =====================================================================
-- Awamer can reach assets that live behind an OpenVPN tunnel. A user stores
-- one or more VPN *profiles* (an uploaded .ovpn config or manually entered
-- settings) and attaches a profile to a host and/or a folder. When connecting
-- to an asset, the effective profile is the host's own, or — walking up the
-- folder tree — the nearest ancestor folder's profile (so a whole
-- group/folder of assets shares one VPN).
--
-- The tunnel itself runs either in the desktop app (the native openvpn client)
-- or on the backend (a server-managed openvpn process), selectable per profile
-- via `runtime`. Secret material (the config text, inline CA/cert/key, and the
-- auth username/password) is encrypted at rest with the same AES-256-GCM
-- SecretBox as credential secrets — never stored in plaintext.

CREATE TABLE vpn_profiles (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  description  TEXT,
  -- Where the openvpn client process runs for this profile.
  runtime      TEXT NOT NULL DEFAULT 'desktop'
                 CHECK (runtime IN ('desktop', 'backend')),
  -- How the profile was authored: an uploaded .ovpn ('config') or manually
  -- entered remote + inline material ('manual', assembled into a config).
  source       TEXT NOT NULL DEFAULT 'config'
                 CHECK (source IN ('config', 'manual')),
  -- Non-secret connection metadata (informational for config profiles; the
  -- authoritative remote for manual profiles).
  remote_host  TEXT,
  remote_port  INTEGER,
  proto        TEXT NOT NULL DEFAULT 'udp'
                 CHECK (proto IN ('udp', 'tcp')),
  -- Whether the VPN server needs an interactive username/password
  -- (OpenVPN `auth-user-pass`).
  auth_mode    TEXT NOT NULL DEFAULT 'none'
                 CHECK (auth_mode IN ('none', 'userpass')),
  -- Auto-establish the tunnel before connecting to an associated asset.
  auto_connect BOOLEAN NOT NULL DEFAULT TRUE,
  -- Encrypted bundle: { ovpn, ca, cert, key, tlsAuth, username, password }.
  -- Same envelope shape as credentials.secret_data (SecretBox / AES-256-GCM).
  secret_data  JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT vpn_profiles_user_name_key UNIQUE (user_id, name)
);
CREATE INDEX vpn_profiles_user_id_idx ON vpn_profiles (user_id);

-- Attach a VPN profile to a folder (applies to every asset under it, via
-- ancestry) and/or directly to a host (overrides the inherited folder one).
-- ON DELETE SET NULL: removing a profile detaches it, it never cascades away
-- the folder/host.
ALTER TABLE folders ADD COLUMN vpn_profile_id UUID REFERENCES vpn_profiles(id) ON DELETE SET NULL;
ALTER TABLE hosts   ADD COLUMN vpn_profile_id UUID REFERENCES vpn_profiles(id) ON DELETE SET NULL;
CREATE INDEX folders_vpn_profile_id_idx ON folders (vpn_profile_id);
CREATE INDEX hosts_vpn_profile_id_idx   ON hosts   (vpn_profile_id);
