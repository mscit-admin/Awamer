import type { Pool } from "../db/index.js";
import type { TenantScope } from "../domain/tenantScope.js";
import type { AuditEvent, MFADevice, MFAMethod, RefreshSession } from "../domain/index.js";

// =========================================================================
// MFA devices
// =========================================================================

interface MFARow {
  id: string;
  user_id: string;
  device_name: string;
  device_type: string;
  secret_enc: Buffer;
  is_primary: boolean;
  last_used_at: Date | null;
  created_at: Date;
}

function rowToDevice(r: MFARow): MFADevice {
  return {
    id: r.id,
    userId: r.user_id,
    deviceName: r.device_name,
    deviceType: r.device_type as MFAMethod,
    secretEnc: r.secret_enc,
    isPrimary: r.is_primary,
    lastUsedAt: r.last_used_at,
    createdAt: r.created_at,
  };
}

export class MFADeviceRepository {
  constructor(private readonly pool: Pool) {}

  async create(d: Omit<MFADevice, "lastUsedAt" | "createdAt">): Promise<void> {
    await this.pool.query(
      `INSERT INTO mfa_devices (id, user_id, device_name, device_type, secret_enc, is_primary, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [d.id, d.userId, d.deviceName, d.deviceType, d.secretEnc, d.isPrimary],
    );
  }

  async listByUser(userId: string): Promise<MFADevice[]> {
    const { rows } = await this.pool.query<MFARow>(
      `SELECT id, user_id, device_name, device_type, secret_enc, is_primary, last_used_at, created_at
       FROM mfa_devices WHERE user_id = $1 ORDER BY created_at ASC`,
      [userId],
    );
    return rows.map(rowToDevice);
  }

  async getPrimary(userId: string): Promise<MFADevice | null> {
    const { rows } = await this.pool.query<MFARow>(
      `SELECT id, user_id, device_name, device_type, secret_enc, is_primary, last_used_at, created_at
       FROM mfa_devices WHERE user_id = $1 AND is_primary = TRUE LIMIT 1`,
      [userId],
    );
    return rows[0] ? rowToDevice(rows[0]) : null;
  }

  async setPrimary(deviceId: string, userId: string): Promise<void> {
    // single transaction so we never have two primaries
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query(`UPDATE mfa_devices SET is_primary = FALSE WHERE user_id = $1`, [userId]);
      await c.query(`UPDATE mfa_devices SET is_primary = TRUE  WHERE id = $1 AND user_id = $2`, [deviceId, userId]);
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }

  async updateLastUsed(id: string): Promise<void> {
    await this.pool.query(`UPDATE mfa_devices SET last_used_at = NOW() WHERE id = $1`, [id]);
  }

  async delete(id: string, userId: string): Promise<void> {
    await this.pool.query(`DELETE FROM mfa_devices WHERE id = $1 AND user_id = $2`, [id, userId]);
  }

  /** SEC-MFA-001 migration support: every device's id + raw secret bytes. */
  async listAllSecrets(): Promise<{ id: string; secretEnc: Buffer }[]> {
    const { rows } = await this.pool.query<{ id: string; secret_enc: Buffer }>(
      `SELECT id, secret_enc FROM mfa_devices`,
    );
    return rows.map((r) => ({ id: r.id, secretEnc: r.secret_enc }));
  }

  /** SEC-MFA-001 migration support: replace a device's stored secret bytes. */
  async updateSecret(id: string, secretEnc: Buffer): Promise<void> {
    await this.pool.query(`UPDATE mfa_devices SET secret_enc = $2 WHERE id = $1`, [id, secretEnc]);
  }
}

// =========================================================================
// Refresh sessions
// =========================================================================

interface RefreshRow {
  jti: string;
  user_id: string;
  expires_at: Date;
  created_at: Date;
  revoked_at: Date | null;
  rotated_to: string | null;
}

function rowToSession(r: RefreshRow): RefreshSession {
  return {
    jti: r.jti,
    userId: r.user_id,
    expiresAt: r.expires_at,
    createdAt: r.created_at,
    revokedAt: r.revoked_at,
    rotatedTo: r.rotated_to,
  };
}

export class RefreshRepository {
  constructor(private readonly pool: Pool) {}

  async insert(s: Pick<RefreshSession, "jti" | "userId" | "expiresAt">): Promise<void> {
    await this.pool.query(
      `INSERT INTO refresh_sessions (jti, user_id, expires_at, created_at)
       VALUES ($1, $2, $3, NOW())`,
      [s.jti, s.userId, s.expiresAt],
    );
  }

  async get(jti: string): Promise<RefreshSession | null> {
    const { rows } = await this.pool.query<RefreshRow>(
      `SELECT jti, user_id, expires_at, created_at, revoked_at, rotated_to
       FROM refresh_sessions WHERE jti = $1`,
      [jti],
    );
    return rows[0] ? rowToSession(rows[0]) : null;
  }

  async markRotated(oldJti: string, newJti: string): Promise<void> {
    await this.pool.query(
      `UPDATE refresh_sessions SET rotated_to = $2 WHERE jti = $1`,
      [oldJti, newJti],
    );
  }

  async revokeAllForUser(userId: string): Promise<void> {
    await this.pool.query(
      `UPDATE refresh_sessions SET revoked_at = NOW()
       WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId],
    );
  }

  /** Revoke a single session (SEC-017 current-session logout). Idempotent. */
  async revoke(jti: string): Promise<void> {
    await this.pool.query(
      `UPDATE refresh_sessions SET revoked_at = NOW()
       WHERE jti = $1 AND revoked_at IS NULL`,
      [jti],
    );
  }
}

// =========================================================================
// Audit log
// =========================================================================

const VALID_ACTIONS = new Set([
  "login_success", "login_failed", "logout",
  "register", "password_change",
  "mfa_enroll", "mfa_disable", "mfa_verify",
  "token_refresh", "token_revoke", "token_reuse_detected",
  "permission_grant", "permission_revoke",
  "user_create", "user_update", "user_delete",
  "config_change",
  "credential_create", "credential_read", "credential_update", "credential_delete",
  "host_create", "host_update", "host_delete",
  "folder_create", "folder_update", "folder_delete",
  "tag_create", "tag_update", "tag_delete",
  "company_create", "company_delete", "user_assign_org",
]);

function mapAction(action: string, success: boolean): string {
  if (action === "login") return success ? "login_success" : "login_failed";
  if (VALID_ACTIONS.has(action)) return action;
  return "config_change"; // fail-safe; never block the request path
}

export class AuditRepository {
  constructor(private readonly pool: Pool) {}

  async log(evt: AuditEvent): Promise<void> {
    const action = mapAction(evt.action, evt.success);
    try {
      await this.pool.query(
        `INSERT INTO audit_logs
           (timestamp, user_id, action, resource_type, resource_id, ip_address, user_agent, details, success)
         VALUES (NOW(), $1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          evt.userId,
          action,
          evt.resourceType ?? null,
          evt.resourceId ?? null,
          evt.ipAddress || null,
          evt.userAgent ?? null,
          JSON.stringify(evt.details ?? {}),
          evt.success,
        ],
      );
    } catch {
      // Audit failures must never crash the request path. Errors are handled
      // by the caller's logger; we just swallow here.
    }
  }

  async list(opts: { limit?: number; offset?: number; action?: string; success?: boolean; userId?: string; scope: TenantScope }): Promise<{ entries: AuditLogEntry[]; total: number }> {
    // SEC-TENANT-001: a non-super actor with no company (scope "none") must NOT
    // read the global audit log. Fail closed to an empty result.
    if (opts.scope.kind === "none") return { entries: [], total: 0 };
    const limit = Math.max(1, Math.min(200, opts.limit ?? 50));
    const offset = Math.max(0, opts.offset ?? 0);

    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.action) { params.push(opts.action); where.push(`a.action = $${params.length}`); }
    if (opts.success !== undefined) { params.push(opts.success); where.push(`a.success = $${params.length}`); }
    if (opts.userId) { params.push(opts.userId); where.push(`a.user_id = $${params.length}`); }
    // Tenant scope: only events by users of this company (isolation). Global
    // scope (Super Admin) applies no company filter.
    if (opts.scope.kind === "company") { params.push(opts.scope.companyId); where.push(`u.company_id = $${params.length}`); }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const countParams = [...params];
    const listParams = [...params, limit, offset];
    const lp = `$${listParams.length - 1}`;
    const op = `$${listParams.length}`;

    const countQ = this.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id ${whereSql}`,
      countParams,
    );
    const listQ = this.pool.query<AuditLogRow>(
      `SELECT a.id, a."timestamp", a.user_id, u.username, a.action,
              a.resource_type, a.resource_id, a.ip_address::text AS ip_address,
              a.success, a.details
       FROM audit_logs a
       LEFT JOIN users u ON u.id = a.user_id
       ${whereSql}
       ORDER BY a."timestamp" DESC
       LIMIT ${lp} OFFSET ${op}`,
      listParams,
    );
    const [c, l] = await Promise.all([countQ, listQ]);
    return {
      total: Number(c.rows[0]?.count ?? 0),
      entries: l.rows.map((r) => ({
        id: Number(r.id),
        timestamp: r.timestamp,
        userId: r.user_id,
        username: r.username,
        action: r.action,
        resourceType: r.resource_type,
        resourceId: r.resource_id,
        ipAddress: r.ip_address,
        success: r.success,
        details: r.details ?? {},
      })),
    };
  }
}

interface AuditLogRow {
  id: string;
  timestamp: Date;
  user_id: string | null;
  username: string | null;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  ip_address: string | null;
  success: boolean;
  details: Record<string, unknown>;
}

export interface AuditLogEntry {
  id: number;
  timestamp: Date;
  userId: string | null;
  username: string | null;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  ipAddress: string | null;
  success: boolean;
  details: Record<string, unknown>;
}
