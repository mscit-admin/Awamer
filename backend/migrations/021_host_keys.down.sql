-- Rollback 021 — drop the host-key pinning store (reverts to blind TOFU).
DROP TABLE IF EXISTS host_keys;
