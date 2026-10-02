-- DB-LEAST-PRIVILEGE (go-live): runtime grants that depend on objects created
-- by migrations. Runs as the schema owner (awamer_migrator in production).
-- Conditional on the roles existing (deploy/db/provision-roles.sh creates
-- them), so development/test databases without those roles are unaffected.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'awamer_app') THEN
    -- Migration bookkeeping belongs to the migration owner only; the default
    -- privileges would otherwise hand the runtime role DML on it.
    EXECUTE 'REVOKE ALL ON schema_migrations FROM awamer_app';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'awamer_vpn_auth') THEN
    -- vpn-helper auth-verify reads exactly these four columns.
    EXECUTE 'GRANT SELECT (server_id, username, password_hash, revoked) ON vpn_server_clients TO awamer_vpn_auth';
  END IF;
END $$;
