/**
 * DB-LEAST-PRIVILEGE — runtime identity guard.
 *
 * The backend must run as a DML-only role (awamer_app), never as the cluster
 * superuser nor the schema/migration owner. At startup the connected role's
 * attributes are read from the catalog; in production any excess privilege is
 * a hard startup failure (no silent fallback to a privileged account). The
 * only escape hatch is the explicit, loudly-logged DB_ALLOW_PRIVILEGED_RUNTIME
 * (for a staged upgrade of a legacy install) — documented as non-compliant.
 */
import type { Pool } from "pg";

export interface RuntimeRoleInfo {
  role: string;
  superuser: boolean;
  createRole: boolean;
  createDb: boolean;
  bypassRls: boolean;
  replication: boolean;
  ownsSchemaObjects: boolean;
  canCreateInSchema: boolean;
}

export async function inspectRuntimeRole(pool: Pool): Promise<RuntimeRoleInfo> {
  const { rows } = await pool.query<{
    role: string; rolsuper: boolean; rolcreaterole: boolean; rolcreatedb: boolean;
    rolbypassrls: boolean; rolreplication: boolean; owns: boolean; can_create: boolean;
  }>(
    `SELECT r.rolname AS role, r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolbypassrls, r.rolreplication,
            EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                     WHERE n.nspname = 'public' AND c.relowner = r.oid) AS owns,
            has_schema_privilege(r.oid, 'public', 'CREATE') AS can_create
       FROM pg_roles r WHERE r.rolname = current_user`,
  );
  const r = rows[0];
  if (!r) throw new Error("could not read the current database role");
  return {
    role: r.role, superuser: r.rolsuper, createRole: r.rolcreaterole, createDb: r.rolcreatedb,
    bypassRls: r.rolbypassrls, replication: r.rolreplication,
    ownsSchemaObjects: r.owns, canCreateInSchema: r.can_create,
  };
}

/** The excess privileges a runtime role holds (empty = compliant). */
export function runtimeRoleViolations(i: RuntimeRoleInfo): string[] {
  const v: string[] = [];
  if (i.superuser) v.push("SUPERUSER");
  if (i.createRole) v.push("CREATEROLE");
  if (i.createDb) v.push("CREATEDB");
  if (i.bypassRls) v.push("BYPASSRLS");
  if (i.replication) v.push("REPLICATION");
  if (i.ownsSchemaObjects) v.push("owns schema objects (migration owner)");
  if (i.canCreateInSchema) v.push("CREATE on schema public (DDL)");
  return v;
}

export interface GuardLog {
  error(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  info(obj: object, msg: string): void;
}

/**
 * Throws in production when the runtime role is over-privileged (unless the
 * explicit override is set, which is logged as an error on every start).
 */
export async function assertLeastPrivilegeRuntime(
  pool: Pool,
  opts: { isProd: boolean; allowPrivileged: boolean },
  log: GuardLog,
): Promise<RuntimeRoleInfo> {
  const info = await inspectRuntimeRole(pool);
  const violations = runtimeRoleViolations(info);
  if (violations.length === 0) {
    log.info({ dbRole: info.role }, "database runtime role is least-privilege");
    return info;
  }
  const detail = { dbRole: info.role, violations };
  if (!opts.isProd) {
    log.warn(detail, "database runtime role is over-privileged (allowed outside production)");
    return info;
  }
  if (opts.allowPrivileged) {
    log.error(detail, "DB_ALLOW_PRIVILEGED_RUNTIME=true: running production with an OVER-PRIVILEGED database role (non-compliant; provision awamer_app)");
    return info;
  }
  throw new Error(
    `Refusing to start: the production database role "${info.role}" is over-privileged (${violations.join(", ")}). ` +
    "Run deploy/db/provision-roles.sh and point DATABASE_URL at the DML-only runtime role (awamer_app); " +
    "migrations run separately as awamer_migrator.",
  );
}
