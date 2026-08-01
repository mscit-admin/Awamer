-- Reverse of 017 — drop VPN profiles and their associations.
DROP INDEX IF EXISTS hosts_vpn_profile_id_idx;
DROP INDEX IF EXISTS folders_vpn_profile_id_idx;
ALTER TABLE hosts   DROP COLUMN IF EXISTS vpn_profile_id;
ALTER TABLE folders DROP COLUMN IF EXISTS vpn_profile_id;
DROP TABLE IF EXISTS vpn_profiles;
