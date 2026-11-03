-- SEC-AUDIT-APPEND-001 (ASVS V16.4.2): the runtime role may INSERT and SELECT
-- audit rows but never UPDATE, DELETE or TRUNCATE them. Conditional on the role
-- existing (deploy/db/provision-roles.sh creates it, and repeats this REVOKE on
-- every deploy), so development/test databases without it are unaffected.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'awamer_app') THEN
    EXECUTE 'REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs FROM awamer_app';
  END IF;
END $$;
