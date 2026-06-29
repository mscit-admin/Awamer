import type { Pool } from "../db/index.js";

export interface Note {
  id: string;
  hostId: string | null;
  hostLabel: string | null;
  title: string | null;
  body: string;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
}

interface Row {
  id: string; host_id: string | null; host_label: string | null;
  title: string | null; body: string; pinned: boolean;
  created_at: Date; updated_at: Date;
}

function rowToNote(r: Row): Note {
  return {
    id: String(r.id), hostId: r.host_id, hostLabel: r.host_label,
    title: r.title, body: r.body, pinned: r.pinned,
    createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(),
  };
}

const COLS = `id, host_id, host_label, title, body, pinned, created_at, updated_at`;
const MAX_BODY = 20000;

/** Per-user notes. Every query is self-scoped by user_id. */
export class NotesRepository {
  constructor(private readonly pool: Pool) {}

  async list(userId: string, opts: { hostId?: string; search?: string } = {}): Promise<Note[]> {
    const where = ["user_id = $1"];
    const params: unknown[] = [userId];
    if (opts.hostId) { params.push(opts.hostId); where.push(`host_id = $${params.length}`); }
    if (opts.search) { params.push(`%${opts.search}%`); where.push(`(title ILIKE $${params.length} OR body ILIKE $${params.length})`); }
    const { rows } = await this.pool.query<Row>(
      `SELECT ${COLS} FROM notes WHERE ${where.join(" AND ")} ORDER BY pinned DESC, updated_at DESC`,
      params,
    );
    return rows.map(rowToNote);
  }

  async create(userId: string, input: { hostId?: string | null; hostLabel?: string | null; title?: string | null; body: string }): Promise<Note> {
    const { rows } = await this.pool.query<Row>(
      `INSERT INTO notes (user_id, host_id, host_label, title, body)
       VALUES ($1, $2, $3, $4, $5) RETURNING ${COLS}`,
      [userId, input.hostId ?? null, input.hostLabel ?? null, input.title ?? null, input.body.slice(0, MAX_BODY)],
    );
    return rowToNote(rows[0]!);
  }

  async update(userId: string, id: string, patch: { title?: string | null; body?: string; pinned?: boolean }): Promise<Note | null> {
    const { rows } = await this.pool.query<Row>(
      `UPDATE notes SET
         title  = CASE WHEN $3::text = '__nochange__' THEN title ELSE $3 END,
         body   = COALESCE($4, body),
         pinned = COALESCE($5, pinned),
         updated_at = NOW()
       WHERE id = $1 AND user_id = $2 RETURNING ${COLS}`,
      [
        id, userId,
        patch.title === undefined ? "__nochange__" : patch.title,
        patch.body === undefined ? null : patch.body.slice(0, MAX_BODY),
        patch.pinned === undefined ? null : patch.pinned,
      ],
    );
    return rows[0] ? rowToNote(rows[0]) : null;
  }

  async delete(userId: string, id: string): Promise<boolean> {
    const r = await this.pool.query(`DELETE FROM notes WHERE id = $1 AND user_id = $2`, [id, userId]);
    return (r.rowCount ?? 0) > 0;
  }
}
