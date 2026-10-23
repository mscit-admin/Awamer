DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'awamer_app') THEN
    EXECUTE 'GRANT UPDATE, DELETE ON audit_logs TO awamer_app';
  END IF;
END $$;
