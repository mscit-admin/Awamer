import type { Pool } from "../db/index.js";

export interface CommandHistoryEntry {
  id: string;
  hostId: string | null;
  hostLabel: string | null;
  command: string;
  createdAt: string;
}

interface CommandRow {
  id: string;
  host_id: string | null;
  host_label: string | null;
  command: string;
  created_at: Date;
}

function rowToEntry(r: CommandRow): CommandHistoryEntry {
  return {
    id: String(r.id),
    hostId: r.host_id,
    hostLabel: r.host_label,
    command: r.command,
    createdAt: r.created_at.toISOString(),
  };
}

const MAX_COMMAND_LEN = 4000;

/**
 * Per-user shell command history. Append-only and self-scoped: every query is
 * keyed by user_id so one user can never read or clear another's commands.
 * Only written when the user has opted in (the client decides whether to POST).
 */
export class CommandHistoryRepository {
  constructor(private readonly pool: Pool) {}

  async add(
    userId: string,
    input: { hostId?: string | null; hostLabel?: string | null; command: string },
  ): Promise<CommandHistoryEntry> {
    const command = input.command.slice(0, MAX_COMMAND_LEN);
    const { rows } = await this.pool.query<CommandRow>(
      `INSERT INTO command_history (user_id, host_id, host_label, command)
       VALUES ($1, $2, $3, $4)
       RETURNING id, host_id, host_label, command, created_at`,
      [userId, input.hostId ?? null, input.hostLabel ?? null, command],
    );
    return rowToEntry(rows[0]!);
  }

  async list(
    userId: string,
    opts: { limit?: number; hostId?: string; search?: string } = {},
  ): Promise<{ entries: CommandHistoryEntry[]; total: number }> {
    const limit = Math.max(1, Math.min(500, opts.limit ?? 200));
    const where = ["user_id = $1"];
    const params: unknown[] = [userId];
    if (opts.hostId) {
      params.push(opts.hostId);
      where.push(`host_id = $${params.length}`);
    }
    if (opts.search) {
      params.push(`%${opts.search}%`);
      where.push(`command ILIKE $${params.length}`);
    }
    const whereSql = where.join(" AND ");
    const countParams = [...params];
    const listParams = [...params, limit];

    const countQ = this.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM command_history WHERE ${whereSql}`,
      countParams,
    );
    const listQ = this.pool.query<CommandRow>(
      `SELECT id, host_id, host_label, command, created_at FROM command_history
       WHERE ${whereSql} ORDER BY created_at DESC, id DESC LIMIT $${listParams.length}`,
      listParams,
    );
    const [c, l] = await Promise.all([countQ, listQ]);
    return {
      total: Number(c.rows[0]?.count ?? 0),
      entries: l.rows.map(rowToEntry),
    };
  }

  /** Clears all (or one host's) command history for the user. Returns deleted count. */
  async clear(userId: string, opts: { hostId?: string } = {}): Promise<number> {
    const params: unknown[] = [userId];
    let sql = `DELETE FROM command_history WHERE user_id = $1`;
    if (opts.hostId) {
      params.push(opts.hostId);
      sql += ` AND host_id = $2`;
    }
    const { rowCount } = await this.pool.query(sql, params);
    return rowCount ?? 0;
  }
}
