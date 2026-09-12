import type { Pool } from "../db/index.js";
import { type User, type Role, Errors, isRole } from "../domain/index.js";
import type { TenantScope } from "../domain/tenantScope.js";

interface UserRow {
  id: string;
  username: string;
  email: string;
  password_hash: string;
  full_name: string | null;
  role: string;
  is_active: boolean;
  is_locked: boolean;
  locked_until: Date | null;
  failed_attempts: number;
  last_login_at: Date | null;
  last_login_ip: string | null;
  mfa_enabled: boolean;
  company_id: string | null;
  org_unit_id: string | null;
  auth_version: number;
  created_at: Date;
  updated_at: Date;
}

const COLS = `
  id, username, email, password_hash, full_name, role,
  is_active, is_locked, locked_until, failed_attempts,
  last_login_at, last_login_ip::text AS last_login_ip,
  mfa_enabled, company_id, org_unit_id, auth_version, created_at, updated_at
`;

function rowToUser(r: UserRow): User {
  if (!isRole(r.role)) throw new Error(`unexpected role from db: ${r.role}`);
  return {
    id: r.id,
    username: r.username,
    email: r.email,
    passwordHash: r.password_hash,
    fullName: r.full_name,
    role: r.role,
    isActive: r.is_active,
    isLocked: r.is_locked,
    lockedUntil: r.locked_until,
    failedAttempts: r.failed_attempts,
    lastLoginAt: r.last_login_at,
    lastLoginIp: r.last_login_ip,
    mfaEnabled: r.mfa_enabled,
    companyId: r.company_id,
    orgUnitId: r.org_unit_id,
    authVersion: r.auth_version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export interface CreateUserInput {
  id: string;
  username: string;
  email: string;
  passwordHash: string;
  fullName?: string | null;
  role: Role;
  companyId?: string | null;
  orgUnitId?: string | null;
}

export class UserRepository {
  constructor(private readonly pool: Pool) {}

  async create(input: CreateUserInput): Promise<User> {
    try {
      const { rows } = await this.pool.query<UserRow>(
        `INSERT INTO users (id, username, email, password_hash, full_name, role, is_active, company_id, org_unit_id)
         VALUES ($1, lower($2), lower($3), $4, $5, $6, TRUE, $7, $8)
         RETURNING ${COLS}`,
        [input.id, input.username, input.email, input.passwordHash, input.fullName ?? null, input.role, input.companyId ?? null, input.orgUnitId ?? null],
      );
      return rowToUser(rows[0]!);
    } catch (e) {
      const err = e as { code?: string; constraint?: string };
      if (err.code === "23505") {
        if ((err.constraint ?? "").includes("username")) throw Errors.UsernameTaken();
        if ((err.constraint ?? "").includes("email")) throw Errors.EmailTaken();
      }
      throw e;
    }
  }

  async getById(id: string): Promise<User> {
    const { rows } = await this.pool.query<UserRow>(`SELECT ${COLS} FROM users WHERE id = $1`, [id]);
    if (!rows[0]) throw Errors.UserNotFound();
    return rowToUser(rows[0]);
  }

  /**
   * Assign a user to a company and (optionally) an org unit and role — as ONE
   * atomic transaction (SEC-020/§8). When `role` is provided it is applied in
   * the same commit as the company/org move, so a company move and its required
   * role replacement can never half-apply and leave `user.company_id !=
   * role.company_id`. Passing `undefined` for role leaves it unchanged.
   */
  async setOrg(id: string, companyId: string | null, orgUnitId: string | null, role?: string): Promise<User> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const setRole = role !== undefined;
      const { rows } = await client.query<UserRow>(
        `UPDATE users SET company_id = $2, org_unit_id = $3,
                          role = CASE WHEN $4::boolean THEN $5 ELSE role END,
                          updated_at = NOW()
         WHERE id = $1 RETURNING ${COLS}`,
        [id, companyId, orgUnitId, setRole, role ?? null],
      );
      if (!rows[0]) throw Errors.UserNotFound();
      // SEC-003: keep the tenant tag on the user's owned resources consistent
      // when they move companies (shared host/note follows its owner).
      await client.query(`UPDATE hosts SET company_id = $2 WHERE user_id = $1`, [id, companyId]);
      await client.query(`UPDATE notes SET company_id = $2 WHERE user_id = $1`, [id, companyId]);
      await client.query("COMMIT");
      return rowToUser(rows[0]);
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  async getByUsername(username: string): Promise<User> {
    const { rows } = await this.pool.query<UserRow>(
      `SELECT ${COLS} FROM users WHERE username = lower($1)`,
      [username],
    );
    if (!rows[0]) throw Errors.UserNotFound();
    return rowToUser(rows[0]);
  }

  /** Look up by email (case-insensitive). Returns null if not found. */
  async findByEmail(email: string): Promise<User | null> {
    const { rows } = await this.pool.query<UserRow>(
      `SELECT ${COLS} FROM users WHERE lower(email) = lower($1)`,
      [email],
    );
    return rows[0] ? rowToUser(rows[0]) : null;
  }

  async update(u: User): Promise<void> {
    const r = await this.pool.query(
      `UPDATE users SET email = lower($2), full_name = $3, role = $4,
                       is_active = $5, is_locked = $6, mfa_enabled = $7,
                       updated_at = NOW()
       WHERE id = $1`,
      [u.id, u.email, u.fullName, u.role, u.isActive, u.isLocked, u.mfaEnabled],
    );
    if (r.rowCount === 0) throw Errors.UserNotFound();
  }

  async incrementFailedAttempts(id: string): Promise<number> {
    const { rows } = await this.pool.query<{ failed_attempts: number }>(
      `UPDATE users SET failed_attempts = failed_attempts + 1, updated_at = NOW()
       WHERE id = $1 RETURNING failed_attempts`,
      [id],
    );
    return rows[0]?.failed_attempts ?? 0;
  }

  async resetFailedAttempts(id: string): Promise<void> {
    await this.pool.query(`UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = $1`, [id]);
  }

  /** Temporary auto-lock: set (or clear, with null) the lockout expiry. */
  async setLockedUntil(id: string, until: Date | null): Promise<void> {
    await this.pool.query(
      `UPDATE users SET locked_until = $2, updated_at = NOW() WHERE id = $1`,
      [id, until],
    );
  }

  async updatePasswordHash(id: string, passwordHash: string): Promise<void> {
    const r = await this.pool.query(
      `UPDATE users SET password_hash = $2, updated_at = NOW() WHERE id = $1`,
      [id, passwordHash],
    );
    if (r.rowCount === 0) throw Errors.UserNotFound();
  }

  /**
   * SEC-SESSION-001 — bump the account's security version, invalidating every
   * previously issued access token (their `av` claim no longer matches).
   * Returns the new version.
   */
  async incrementAuthVersion(id: string): Promise<number> {
    const r = await this.pool.query<{ auth_version: number }>(
      `UPDATE users SET auth_version = auth_version + 1, updated_at = NOW()
       WHERE id = $1 RETURNING auth_version`,
      [id],
    );
    if (r.rowCount === 0) throw Errors.UserNotFound();
    return r.rows[0]!.auth_version;
  }

  async setLocked(id: string, locked: boolean): Promise<void> {
    await this.pool.query(
      `UPDATE users SET is_locked = $2, updated_at = NOW() WHERE id = $1`,
      [id, locked],
    );
  }

  async recordLogin(id: string, ip: string | null): Promise<void> {
    await this.pool.query(
      `UPDATE users SET last_login_at = NOW(), last_login_ip = $2 WHERE id = $1`,
      [id, ip || null],
    );
  }

  /**
   * List users within an EXPLICIT tenant scope (SEC-TENANT-001):
   *   - global         → all users (Super Admin only)
   *   - { company }    → only that company's users
   *   - none           → EMPTY (a non-super actor with no company is not global)
   */
  async list(limit: number, offset: number, scope: TenantScope): Promise<{ users: User[]; total: number }> {
    if (scope.kind === "none") return { users: [], total: 0 };
    const company = scope.kind === "company" ? scope.companyId : null;
    const scoped = company != null;
    const where = scoped ? `WHERE company_id = $3` : ``;
    const totalP = this.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM users ${scoped ? "WHERE company_id = $1" : ""}`,
      scoped ? [company] : [],
    );
    const usersP = this.pool.query<UserRow>(
      `SELECT ${COLS} FROM users ${where} ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
      scoped ? [limit, offset, company] : [limit, offset],
    );
    const [tRes, uRes] = await Promise.all([totalP, usersP]);
    return {
      total: Number(tRes.rows[0]?.count ?? 0),
      users: uRes.rows.map(rowToUser),
    };
  }

  async delete(id: string): Promise<void> {
    const r = await this.pool.query(`DELETE FROM users WHERE id = $1`, [id]);
    if (r.rowCount === 0) throw Errors.UserNotFound();
  }

  async countAll(): Promise<number> {
    const { rows } = await this.pool.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM users`);
    return Number(rows[0]?.count ?? 0);
  }
}
