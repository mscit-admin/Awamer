import type { Pool } from "../db/index.js";

export interface Note {
  id: string;
  ownerId: string;
  ownerUsername: string;
  isOwner: boolean;
  isShared: boolean;
  hostId: string | null;
  hostLabel: string | null;
  title: string | null;
  body: string;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
}

interface Row {
  id: string; user_id: string; owner_username: string; is_shared: boolean;
  host_id: string | null; host_label: string | null;
  title: string | null; body: string; pinned: boolean;
  created_at: Date; updated_at: Date;
}

function rowToNote(r: Row, viewerId: string): Note {
  return {
    id: String(r.id), ownerId: r.user_id, ownerUsername: r.owner_username,
    isOwner: r.user_id === viewerId, isShared: r.is_shared,
    hostId: r.host_id, hostLabel: r.host_label,
    title: r.title, body: r.body, pinned: r.pinned,
    createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(),
  };
}

const SEL = `n.id, n.user_id, u.username AS owner_username, n.is_shared,
             n.host_id, n.host_label, n.title, n.body, n.pinned, n.created_at, n.updated_at`;
const RET = `id, user_id, (SELECT username FROM users WHERE id = notes.user_id) AS owner_username,
             is_shared, host_id, host_label, title, body, pinned, created_at, updated_at`;
const MAX_BODY = 20000;

/** Per-user notes with optional sharing (instance-wide or per-user). */
export class NotesRepository {
  constructor(private readonly pool: Pool) {}

  /** Notes visible to the viewer: own, shared-with-everyone, or shared-with-them. */
  async list(viewerId: string, opts: { hostId?: string; search?: string } = {}): Promise<Note[]> {
    // SEC-003: `is_shared` is scoped to the viewer's company, not the whole
    // installation, so a shared note never crosses a tenant boundary.
    const where = [
      "(n.user_id = $1 OR (n.is_shared = TRUE AND n.company_id = (SELECT company_id FROM users WHERE id = $1)) OR EXISTS (SELECT 1 FROM note_shares ns WHERE ns.note_id = n.id AND ns.user_id = $1))",
    ];
    const params: unknown[] = [viewerId];
    if (opts.hostId) { params.push(opts.hostId); where.push(`n.host_id = $${params.length}`); }
    if (opts.search) { params.push(`%${opts.search}%`); where.push(`(n.title ILIKE $${params.length} OR n.body ILIKE $${params.length})`); }
    const { rows } = await this.pool.query<Row>(
      `SELECT ${SEL} FROM notes n JOIN users u ON u.id = n.user_id
       WHERE ${where.join(" AND ")} ORDER BY n.pinned DESC, n.updated_at DESC`,
      params,
    );
    return rows.map((r) => rowToNote(r, viewerId));
  }

  async create(userId: string, input: { hostId?: string | null; hostLabel?: string | null; title?: string | null; body: string }): Promise<Note> {
    const { rows } = await this.pool.query<Row>(
      `INSERT INTO notes (user_id, host_id, host_label, title, body, company_id)
       VALUES ($1, $2, $3, $4, $5, (SELECT company_id FROM users WHERE id = $1))
       RETURNING ${RET}`,
      [userId, input.hostId ?? null, input.hostLabel ?? null, input.title ?? null, input.body.slice(0, MAX_BODY)],
    );
    return rowToNote(rows[0]!, userId);
  }

  /** Owner-only update (recipients of a shared note can't edit). */
  async update(userId: string, id: string, patch: { title?: string | null; body?: string; pinned?: boolean; isShared?: boolean }): Promise<Note | null> {
    const { rows } = await this.pool.query<Row>(
      `UPDATE notes SET
         title  = CASE WHEN $3::text = '__nochange__' THEN title ELSE $3 END,
         body   = COALESCE($4, body),
         pinned = COALESCE($5, pinned),
         is_shared = COALESCE($6, is_shared),
         updated_at = NOW()
       WHERE id = $1 AND user_id = $2 RETURNING ${RET}`,
      [
        id, userId,
        patch.title === undefined ? "__nochange__" : patch.title,
        patch.body === undefined ? null : patch.body.slice(0, MAX_BODY),
        patch.pinned === undefined ? null : patch.pinned,
        patch.isShared === undefined ? null : patch.isShared,
      ],
    );
    return rows[0] ? rowToNote(rows[0], userId) : null;
  }

  async delete(userId: string, id: string): Promise<boolean> {
    const r = await this.pool.query(`DELETE FROM notes WHERE id = $1 AND user_id = $2`, [id, userId]);
    return (r.rowCount ?? 0) > 0;
  }

  /** Replace the set of users a note is explicitly shared with. Owner only. */
  async setShares(ownerId: string, noteId: string, userIds: string[]): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const own = await client.query(`SELECT id FROM notes WHERE id = $1 AND user_id = $2`, [noteId, ownerId]);
      if (own.rowCount === 0) { await client.query("ROLLBACK"); return false; }
      await client.query(`DELETE FROM note_shares WHERE note_id = $1`, [noteId]);
      const targets = [...new Set(userIds)].filter((u) => u && u !== ownerId);
      for (const uid of targets) {
        await client.query(`INSERT INTO note_shares (note_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [noteId, uid]);
      }
      await client.query("COMMIT");
      return true;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  async getShareUserIds(ownerId: string, noteId: string): Promise<string[] | null> {
    const own = await this.pool.query(`SELECT id FROM notes WHERE id = $1 AND user_id = $2`, [noteId, ownerId]);
    if (own.rowCount === 0) return null;
    const { rows } = await this.pool.query<{ user_id: string }>(`SELECT user_id FROM note_shares WHERE note_id = $1`, [noteId]);
    return rows.map((r) => r.user_id);
  }
}
