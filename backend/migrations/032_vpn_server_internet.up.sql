-- =====================================================================
-- 032 — VPN server internet policy (full tunnel, allow/block per client)
-- =====================================================================
-- `vpn_servers.internet_access` is the master switch: clients route through
-- the server, allowed clients are NATed to the internet and the others reach
-- only the VPN subnet. `vpn_server_clients.internet_access` is the per-client
-- allow flag.
--
-- IF NOT EXISTS: some databases already have these columns from an older code
-- line, where they came from a migration recorded as `020_vpn_server_internet`
-- (see deploy/db/reconcile-migration-020.sh). There this migration is a no-op.

ALTER TABLE vpn_servers
  ADD COLUMN IF NOT EXISTS internet_access BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE vpn_server_clients
  ADD COLUMN IF NOT EXISTS internet_access BOOLEAN NOT NULL DEFAULT FALSE;
