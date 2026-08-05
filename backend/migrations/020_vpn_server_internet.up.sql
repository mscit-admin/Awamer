-- =====================================================================
-- 020 — VPN server: internet access (full tunnel), server + per-client
-- =====================================================================
-- Beyond client-to-client (clients reaching each other), a server can now route
-- selected clients' traffic to the internet through the hub (full tunnel /
-- redirect-gateway + NAT on the server). `internet_access` on the server is the
-- master switch (enables NAT + client-config-dir); the per-client flag chooses
-- which clients actually get redirect-gateway pushed to them.

ALTER TABLE vpn_servers
  ADD COLUMN internet_access BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE vpn_server_clients
  ADD COLUMN internet_access BOOLEAN NOT NULL DEFAULT FALSE;
