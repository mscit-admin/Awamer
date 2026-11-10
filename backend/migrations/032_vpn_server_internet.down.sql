-- Rollback 032 — remove the VPN server internet policy columns.
ALTER TABLE vpn_server_clients DROP COLUMN IF EXISTS internet_access;
ALTER TABLE vpn_servers DROP COLUMN IF EXISTS internet_access;
