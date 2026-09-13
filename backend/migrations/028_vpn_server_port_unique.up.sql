-- =====================================================================
-- 028 — Multi-VPN-Server dynamic ports: enforce (port, proto) uniqueness
-- =====================================================================
-- Each VPN Server owns its own listener; two servers may not share the same
-- (port, protocol) on the host. Uniqueness is on the PAIR, so 20001/udp and
-- 20001/tcp are allowed but two 20001/udp servers are rejected at the DB level
-- (the last line of defence behind the API's range/reserved/collision checks).
--
-- Migration safety (legacy upgrade): a functional install can only ever have
-- had ONE server bound to a given (port, proto) — two servers on the same
-- host port/proto could never both run — so existing rows do not collide in
-- practice. A pre-existing duplicate (a mis-created, non-functional row) must be
-- resolved by the operator before this migration applies; it does not silently
-- change any server's port.
CREATE UNIQUE INDEX IF NOT EXISTS vpn_servers_port_proto_key
  ON vpn_servers (port, proto);
