DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'awamer_vpn_auth') THEN
    EXECUTE 'REVOKE SELECT (server_id, username, password_hash, revoked) ON vpn_server_clients FROM awamer_vpn_auth';
  END IF;
END $$;
