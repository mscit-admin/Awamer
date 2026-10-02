#!/bin/sh
# =====================================================================
# DB-LEAST-PRIVILEGE — provision the Awamer PostgreSQL identities.
#
# Run as the cluster ADMIN (the official image's POSTGRES_USER, a superuser)
# BEFORE migrations, on every deploy. Idempotent: safe to re-run; it creates
# missing roles, (re)sets their passwords and attributes, transfers ownership
# of existing schema objects to the migration owner (upgrade path) and
# (re)applies the runtime grants.
#
#   awamer_migrator  — owns the schema; runs migrations (DDL). NOT superuser.
#   awamer_app       — backend runtime: DML only (SELECT/INSERT/UPDATE/DELETE
#                      + sequence USAGE). No DDL, no schema_migrations access.
#   awamer_vpn_auth  — vpn-helper auth-verify: SELECT on 4 columns of
#                      vpn_server_clients. Nothing else.
#
# Inputs (environment — never arguments, so they don't appear in `ps`):
#   PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE   cluster-admin connection
#   AWAMER_MIGRATOR_DB_PASSWORD  AWAMER_APP_DB_PASSWORD  AWAMER_VPN_AUTH_DB_PASSWORD
# Passwords are passed to psql as variables and quoted by psql (:'var'); they
# are never echoed. Requires a server with log_statement != 'ddl'/'all' to keep
# the password out of the server log (the official image default is 'none').
# =====================================================================
set -eu

for v in AWAMER_MIGRATOR_DB_PASSWORD AWAMER_APP_DB_PASSWORD AWAMER_VPN_AUTH_DB_PASSWORD; do
  eval "val=\${$v:-}"
  if [ "${#val}" -lt 24 ]; then
    echo "provision-roles: $v is missing or shorter than 24 characters" >&2
    exit 1
  fi
  case "$(printf '%s' "$val" | tr '[:upper:]' '[:lower:]')" in
    *change_me*|*changeme*|*change-me*)
      echo "provision-roles: $v still holds a template placeholder — generate a real secret (openssl rand -hex 32)" >&2
      exit 1 ;;
  esac
done
if [ "$AWAMER_MIGRATOR_DB_PASSWORD" = "$AWAMER_APP_DB_PASSWORD" ] \
   || [ "$AWAMER_APP_DB_PASSWORD" = "$AWAMER_VPN_AUTH_DB_PASSWORD" ] \
   || [ "$AWAMER_MIGRATOR_DB_PASSWORD" = "$AWAMER_VPN_AUTH_DB_PASSWORD" ]; then
  echo "provision-roles: the three DB passwords must all differ" >&2
  exit 1
fi

psql -X -q -v ON_ERROR_STOP=1 \
  -v migrator_pw="$AWAMER_MIGRATOR_DB_PASSWORD" \
  -v app_pw="$AWAMER_APP_DB_PASSWORD" \
  -v vpn_pw="$AWAMER_VPN_AUTH_DB_PASSWORD" <<'SQL'
SELECT current_database() AS db \gset

-- ---- 1. Roles (create if missing; always reset attributes + password) ----
SELECT 'CREATE ROLE awamer_migrator LOGIN'
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'awamer_migrator') \gexec
SELECT 'CREATE ROLE awamer_app LOGIN'
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'awamer_app') \gexec
SELECT 'CREATE ROLE awamer_vpn_auth LOGIN'
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'awamer_vpn_auth') \gexec

ALTER ROLE awamer_migrator WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT PASSWORD :'migrator_pw';
ALTER ROLE awamer_app      WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT 100 PASSWORD :'app_pw';
ALTER ROLE awamer_vpn_auth WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT 20 PASSWORD :'vpn_pw';

-- ---- 2. Database + schema -------------------------------------------------
-- pgcrypto (migration 001) needs CREATE on the database; install it here as
-- admin so the non-superuser migrator's `CREATE EXTENSION IF NOT EXISTS` no-ops.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

REVOKE ALL ON DATABASE :"db" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"db" TO awamer_migrator, awamer_app, awamer_vpn_auth;
GRANT TEMPORARY ON DATABASE :"db" TO awamer_migrator;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO awamer_migrator;
GRANT USAGE ON SCHEMA public TO awamer_app, awamer_vpn_auth;

-- ---- 3. Upgrade path: hand existing objects to the migration owner -------
-- (Installs that migrated as the superuser.) Owned sequences (serial/identity)
-- follow their table automatically and are skipped.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.oid, c.relname, c.relkind
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
       AND pg_get_userbyid(c.relowner) <> 'awamer_migrator'
       AND NOT EXISTS (SELECT 1 FROM pg_depend d
                        WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid
                          AND d.deptype IN ('a', 'i') AND c.relkind = 'S')
       AND NOT EXISTS (SELECT 1 FROM pg_depend d
                        WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('ALTER %s public.%I OWNER TO awamer_migrator',
      CASE r.relkind WHEN 'S' THEN 'SEQUENCE' WHEN 'v' THEN 'VIEW'
                     WHEN 'm' THEN 'MATERIALIZED VIEW' ELSE 'TABLE' END,
      r.relname);
  END LOOP;
END $$;

-- ---- 4. Runtime grants (existing + future objects) -----------------------
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM awamer_app, awamer_vpn_auth;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO awamer_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO awamer_app;
ALTER DEFAULT PRIVILEGES FOR ROLE awamer_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO awamer_app;
ALTER DEFAULT PRIVILEGES FOR ROLE awamer_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO awamer_app;

-- Migration bookkeeping is the migrator's alone (also re-applied by migration 029).
SELECT 'REVOKE ALL ON public.schema_migrations FROM awamer_app'
 WHERE to_regclass('public.schema_migrations') IS NOT NULL \gexec

-- vpn-helper auth-verify: exactly the columns its single query reads.
SELECT 'GRANT SELECT (server_id, username, password_hash, revoked) ON public.vpn_server_clients TO awamer_vpn_auth'
 WHERE to_regclass('public.vpn_server_clients') IS NOT NULL \gexec
SQL

echo "provision-roles: awamer_migrator, awamer_app, awamer_vpn_auth provisioned on database ${PGDATABASE:-?}"
