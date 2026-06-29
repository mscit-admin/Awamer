import type { Pool } from "../db/index.js";

export interface PasswordReset {
  id: string;
  userId: string;
  expiresAt: Date;
  usedAt: Date | null;
}

interface Row {
  id: string; user_id: string; expires_at: Date; used_at: Date | null;
}

/** One-time, expiring password-reset tokens (only the hash is stored). */
export class PasswordResetRepository {
  constructor(private readonly pool: Pool) {}

  async create(userId: string, tokenHash: string, expiresAt: Date): Promise<void> {
    await this.pool.query(
      `INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
      [userId, tokenHash, expiresAt],
    );
  }

  /** Return an unused, unexpired reset for this token hash, or null. */
  async findValid(tokenHash: string): Promise<PasswordReset | null> {
    const { rows } = await this.pool.query<Row>(
      `SELECT id, user_id, expires_at, used_at FROM password_resets
       WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW()`,
      [tokenHash],
    );
    if (!rows[0]) return null;
    return { id: rows[0].id, userId: rows[0].user_id, expiresAt: rows[0].expires_at, usedAt: rows[0].used_at };
  }

  async markUsed(id: string): Promise<void> {
    await this.pool.query(`UPDATE password_resets SET used_at = NOW() WHERE id = $1`, [id]);
  }

  /** Invalidate any outstanding resets for a user (e.g. before issuing a new one). */
  async invalidateForUser(userId: string): Promise<void> {
    await this.pool.query(
      `UPDATE password_resets SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL`,
      [userId],
    );
  }
}
