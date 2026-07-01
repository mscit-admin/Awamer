import type { Pool } from "../db/index.js";

export interface RoleRecord {
  id: string;
  key: string;
  name: string;
  description: string | null;
  permissions: string[];
  isBuiltin: boolean;
  createdAt: string;
  updatedAt: string;
}

interface RoleRow {
  id: string; key: string; name: string; description: string | null;
  permissions: string[]; is_builtin: boolean; created_at: Date; updated_at: Date;
}

function rowToRole(r: RoleRow): RoleRecord {
  return {
    id: r.id, key: r.key, name: r.name, description: r.description,
    permissions: r.permissions ?? [], isBuiltin: r.is_builtin,
    createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(),
  };
}

const COLS = `id, key, name, description, permissions, is_builtin, created_at, updated_at`;

export class RoleNotFound extends Error { constructor() { super("role_not_found"); this.name = "RoleNotFound"; } }
export class RoleKeyTaken extends Error { constructor() { super("role_key_taken"); this.name = "RoleKeyTaken"; } }

export class RoleRepository {
  constructor(private readonly pool: Pool) {}

  async listAll(): Promise<RoleRecord[]> {
    const { rows } = await this.pool.query<RoleRow>(
      `SELECT ${COLS} FROM roles ORDER BY is_builtin DESC, name`,
    );
    return rows.map(rowToRole);
  }

  async getById(id: string): Promise<RoleRecord> {
    const { rows } = await this.pool.query<RoleRow>(`SELECT ${COLS} FROM roles WHERE id = $1`, [id]);
    if (!rows[0]) throw new RoleNotFound();
    return rowToRole(rows[0]);
  }

  /**
   * Upsert a locked built-in role from the code catalog. Keeps built-in roles'
   * permission sets in sync with the code (so new permissions apply without a
   * dedicated migration). Never touches custom (non-built-in) roles.
   */
  async upsertBuiltin(b: { key: string; name: string; description?: string | null; permissions: string[] }): Promise<void> {
    await this.pool.query(
      `INSERT INTO roles (key, name, description, permissions, is_builtin)
       VALUES ($1, $2, $3, $4::text[], TRUE)
       ON CONFLICT (key) DO UPDATE SET
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         permissions = EXCLUDED.permissions,
         is_builtin = TRUE,
         updated_at = NOW()`,
      [b.key, b.name, b.description ?? null, b.permissions],
    );
  }

  async create(input: { key: string; name: string; description?: string | null; permissions: string[] }): Promise<RoleRecord> {
    try {
      const { rows } = await this.pool.query<RoleRow>(
        `INSERT INTO roles (key, name, description, permissions, is_builtin)
         VALUES ($1, $2, $3, $4::text[], FALSE) RETURNING ${COLS}`,
        [input.key, input.name, input.description ?? null, input.permissions],
      );
      return rowToRole(rows[0]!);
    } catch (e) {
      if ((e as { code?: string }).code === "23505") throw new RoleKeyTaken();
      throw e;
    }
  }

  async update(id: string, patch: { name?: string; description?: string | null; permissions?: string[] }): Promise<RoleRecord> {
    const { rows } = await this.pool.query<RoleRow>(
      `UPDATE roles SET
         name        = COALESCE($2, name),
         description = CASE WHEN $3::text = '__nochange__' THEN description ELSE $3 END,
         permissions = COALESCE($4::text[], permissions),
         updated_at  = NOW()
       WHERE id = $1 RETURNING ${COLS}`,
      [
        id,
        patch.name ?? null,
        patch.description === undefined ? "__nochange__" : patch.description,
        patch.permissions ?? null,
      ],
    );
    if (!rows[0]) throw new RoleNotFound();
    return rowToRole(rows[0]);
  }

  async delete(id: string): Promise<void> {
    const r = await this.pool.query(`DELETE FROM roles WHERE id = $1`, [id]);
    if (r.rowCount === 0) throw new RoleNotFound();
  }

  async countUsers(roleKey: string): Promise<number> {
    const { rows } = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM users WHERE role = $1`, [roleKey],
    );
    return Number(rows[0]?.count ?? 0);
  }
}
