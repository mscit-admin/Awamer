-- Revert 028 — drop the (port, proto) uniqueness index.
DROP INDEX IF EXISTS vpn_servers_port_proto_key;
