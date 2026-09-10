/**
 * Phase 2 — Session-management repositories.
 *
 * Each repository owns one table (plus the host_tags join for the hosts repo).
 * All queries are user-scoped: a user can only ever see their own data.
 */

import type { Pool, PoolClient } from "../db/index.js";
import type { SecretBox } from "../crypto/secretBox.js";
import {
  type Folder, type Tag, type Credential, type CredentialField, type Host, type ConnectionHistoryEntry,
  type HostProtocol, type CredentialType, type ConnectionStatus,
  PhaseTwoErrors,
} from "../domain/session.js";

// ---------------------------------------------------------------------
// Common helpers
// ---------------------------------------------------------------------

function wrapUniqueViolation(e: unknown, makeErr: () => Error): Error {
  const err = e as { code?: string };
  if (err.code === "23505") return makeErr();
  return e instanceof Error ? e : new Error(String(e));
}

// =====================================================================
// FolderRepository
// =====================================================================

interface FolderRow {
  id: string; user_id: string; parent_id: string | null;
  name: string; color: string | null; icon: string | null;
  sort_order: number; vpn_profile_id: string | null;
  created_at: Date; updated_at: Date;
}

const FOLDER_COLS = `id, user_id, parent_id, name, color, icon, sort_order, vpn_profile_id, created_at, updated_at`;

function rowToFolder(r: FolderRow): Folder {
  return {
    id: r.id, userId: r.user_id, parentId: r.parent_id,
    name: r.name, color: r.color, icon: r.icon, sortOrder: r.sort_order,
    vpnProfileId: r.vpn_profile_id,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export class FolderRepository {
  constructor(private readonly pool: Pool) {}

  async listForUser(userId: string): Promise<Folder[]> {
    const { rows } = await this.pool.query<FolderRow>(
      `SELECT ${FOLDER_COLS} FROM folders WHERE user_id = $1 ORDER BY sort_order, name`,
      [userId],
    );
    return rows.map(rowToFolder);
  }

  async getById(userId: string, id: string): Promise<Folder> {
    const { rows } = await this.pool.query<FolderRow>(
      `SELECT ${FOLDER_COLS} FROM folders WHERE id = $1 AND user_id = $2`,
      [id, userId],
    );
    if (!rows[0]) throw PhaseTwoErrors.FolderNotFound();
    return rowToFolder(rows[0]);
  }

  async create(input: { userId: string; parentId: string | null; name: string; color?: string | null; icon?: string | null; sortOrder?: number; vpnProfileId?: string | null }): Promise<Folder> {
    try {
      const { rows } = await this.pool.query<FolderRow>(
        `INSERT INTO folders (user_id, parent_id, name, color, icon, sort_order, vpn_profile_id)
         VALUES ($1, $2, $3, $4, $5, COALESCE($6, 0), $7)
         RETURNING ${FOLDER_COLS}`,
        [input.userId, input.parentId, input.name, input.color ?? null, input.icon ?? null, input.sortOrder ?? null, input.vpnProfileId ?? null],
      );
      return rowToFolder(rows[0]!);
    } catch (e) {
      throw wrapUniqueViolation(e, PhaseTwoErrors.FolderNameTaken);
    }
  }

  async update(userId: string, id: string, patch: Partial<Pick<Folder, "name" | "color" | "icon" | "sortOrder" | "parentId" | "vpnProfileId">>): Promise<Folder> {
    // Cycle detection for parent_id changes.
    if (patch.parentId !== undefined && patch.parentId !== null) {
      if (patch.parentId === id) throw PhaseTwoErrors.FolderCycle();
      const ancestors = await this.ancestorsOf(userId, patch.parentId);
      if (ancestors.has(id)) throw PhaseTwoErrors.FolderCycle();
    }

    try {
      const { rows } = await this.pool.query<FolderRow>(
        `UPDATE folders SET
           name       = COALESCE($3, name),
           color      = CASE WHEN $4::text = '__nochange__' THEN color ELSE NULLIF($4, '__null__') END,
           icon       = CASE WHEN $5::text = '__nochange__' THEN icon ELSE NULLIF($5, '__null__') END,
           sort_order = COALESCE($6, sort_order),
           parent_id  = CASE WHEN $7::text = '__nochange__' THEN parent_id
                             WHEN $7::text = '__null__' THEN NULL
                             ELSE $7::uuid END,
           vpn_profile_id = CASE WHEN $8::text = '__nochange__' THEN vpn_profile_id
                                 WHEN $8::text = '__null__' THEN NULL
                                 ELSE $8::uuid END,
           updated_at = NOW()
         WHERE id = $1 AND user_id = $2
         RETURNING ${FOLDER_COLS}`,
        [
          id, userId,
          patch.name ?? null,
          patch.color === undefined ? "__nochange__" : (patch.color === null ? "__null__" : patch.color),
          patch.icon === undefined ? "__nochange__" : (patch.icon === null ? "__null__" : patch.icon),
          patch.sortOrder ?? null,
          patch.parentId === undefined ? "__nochange__" : (patch.parentId === null ? "__null__" : patch.parentId),
          patch.vpnProfileId === undefined ? "__nochange__" : (patch.vpnProfileId === null ? "__null__" : patch.vpnProfileId),
        ],
      );
      if (!rows[0]) throw PhaseTwoErrors.FolderNotFound();
      return rowToFolder(rows[0]);
    } catch (e) {
      if (e instanceof Error && e.message.includes("folder_not_found")) throw e;
      throw wrapUniqueViolation(e, PhaseTwoErrors.FolderNameTaken);
    }
  }

  async delete(userId: string, id: string): Promise<void> {
    const r = await this.pool.query(`DELETE FROM folders WHERE id = $1 AND user_id = $2`, [id, userId]);
    if (r.rowCount === 0) throw PhaseTwoErrors.FolderNotFound();
  }

  /** Returns the set of ancestor IDs of `id`, inclusive. */
  private async ancestorsOf(userId: string, id: string): Promise<Set<string>> {
    const { rows } = await this.pool.query<{ id: string }>(
      `WITH RECURSIVE chain AS (
         SELECT id, parent_id FROM folders WHERE id = $1 AND user_id = $2
         UNION ALL
         SELECT f.id, f.parent_id FROM folders f INNER JOIN chain c ON c.parent_id = f.id
       )
       SELECT id FROM chain`,
      [id, userId],
    );
    return new Set(rows.map((r) => r.id));
  }
}

// =====================================================================
// TagRepository
// =====================================================================

interface TagRow {
  id: string; user_id: string; name: string;
  color: string | null; created_at: Date;
}

const TAG_COLS = `id, user_id, name, color, created_at`;

function rowToTag(r: TagRow): Tag {
  return {
    id: r.id, userId: r.user_id, name: r.name,
    color: r.color, createdAt: r.created_at,
  };
}

export class TagRepository {
  constructor(private readonly pool: Pool) {}

  async listForUser(userId: string): Promise<Tag[]> {
    const { rows } = await this.pool.query<TagRow>(
      `SELECT ${TAG_COLS} FROM tags WHERE user_id = $1 ORDER BY name`,
      [userId],
    );
    return rows.map(rowToTag);
  }

  async getById(userId: string, id: string): Promise<Tag> {
    const { rows } = await this.pool.query<TagRow>(
      `SELECT ${TAG_COLS} FROM tags WHERE id = $1 AND user_id = $2`,
      [id, userId],
    );
    if (!rows[0]) throw PhaseTwoErrors.TagNotFound();
    return rowToTag(rows[0]);
  }

  async create(input: { userId: string; name: string; color?: string | null }): Promise<Tag> {
    try {
      const { rows } = await this.pool.query<TagRow>(
        `INSERT INTO tags (user_id, name, color) VALUES ($1, $2, $3) RETURNING ${TAG_COLS}`,
        [input.userId, input.name, input.color ?? null],
      );
      return rowToTag(rows[0]!);
    } catch (e) {
      throw wrapUniqueViolation(e, PhaseTwoErrors.TagNameTaken);
    }
  }

  async update(userId: string, id: string, patch: Partial<Pick<Tag, "name" | "color">>): Promise<Tag> {
    try {
      const { rows } = await this.pool.query<TagRow>(
        `UPDATE tags SET
           name  = COALESCE($3, name),
           color = CASE WHEN $4::text = '__nochange__' THEN color ELSE NULLIF($4, '__null__') END
         WHERE id = $1 AND user_id = $2
         RETURNING ${TAG_COLS}`,
        [id, userId, patch.name ?? null,
         patch.color === undefined ? "__nochange__" : (patch.color === null ? "__null__" : patch.color)],
      );
      if (!rows[0]) throw PhaseTwoErrors.TagNotFound();
      return rowToTag(rows[0]);
    } catch (e) {
      if (e instanceof Error && e.message.includes("tag_not_found")) throw e;
      throw wrapUniqueViolation(e, PhaseTwoErrors.TagNameTaken);
    }
  }

  async delete(userId: string, id: string): Promise<void> {
    const r = await this.pool.query(`DELETE FROM tags WHERE id = $1 AND user_id = $2`, [id, userId]);
    if (r.rowCount === 0) throw PhaseTwoErrors.TagNotFound();
  }
}

// =====================================================================
// CredentialRepository
// =====================================================================

interface CredRow {
  id: string; user_id: string; name: string;
  credential_type: string; username: string | null;
  secret_data: Record<string, unknown>;
  description: string | null;
  folder_id: string | null;
  favorite: boolean;
  expires_at: Date | null;
  created_at: Date; updated_at: Date;
}

const CRED_COLS = `id, user_id, name, credential_type, username, secret_data, description,
                   folder_id, favorite, expires_at, created_at, updated_at`;

interface FieldRow {
  id: string; credential_id: string; label: string;
  value_enc: Record<string, unknown>; is_secret: boolean; sort_order: number;
}

const FIELD_COLS = `id, credential_id, label, value_enc, is_secret, sort_order`;

function rowToField(r: FieldRow, box: SecretBox): CredentialField {
  // value_enc wraps { v: <string> } in the standard secret envelope.
  const opened = box.open(r.value_enc ?? {}) as { v?: unknown };
  return {
    id: r.id, label: r.label,
    value: typeof opened.v === "string" ? opened.v : "",
    isSecret: r.is_secret, sortOrder: r.sort_order,
  };
}

function rowToCredential(
  r: CredRow, box: SecretBox, fields: CredentialField[],
  extra: { hasTotp?: boolean; attachmentCount?: number } = {},
): Credential {
  return {
    id: r.id, userId: r.user_id, name: r.name,
    credentialType: r.credential_type as CredentialType,
    username: r.username,
    // Phase 10: secret_data is stored encrypted; decrypt transparently.
    // Legacy plaintext rows pass through unchanged.
    secretData: box.open(r.secret_data ?? {}),
    description: r.description,
    folderId: r.folder_id,
    favorite: r.favorite,
    expiresAt: r.expires_at,
    fields,
    hasTotp: extra.hasTotp ?? false,
    attachmentCount: extra.attachmentCount ?? 0,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export interface CredentialFieldInput {
  label: string;
  value: string;
  isSecret?: boolean;
  sortOrder?: number;
}

export interface CredentialListFilters {
  folderId?: string | "root" | null;
  favoritesOnly?: boolean;
}

export class CredentialRepository {
  constructor(private readonly pool: Pool, private readonly box: SecretBox) {}

  async listForUser(userId: string, filters: CredentialListFilters = {}): Promise<Credential[]> {
    const where = ["user_id = $1"];
    const params: unknown[] = [userId];
    if (filters.folderId === "root") {
      where.push("folder_id IS NULL");
    } else if (filters.folderId) {
      params.push(filters.folderId);
      where.push(`folder_id = $${params.length}`);
    }
    if (filters.favoritesOnly) where.push("favorite = TRUE");

    const { rows } = await this.pool.query<CredRow>(
      `SELECT ${CRED_COLS} FROM credentials WHERE ${where.join(" AND ")} ORDER BY favorite DESC, name`,
      params,
    );
    const ids = rows.map((r) => r.id);
    const [fieldMap, totpSet, attachCounts] = await Promise.all([
      this.fieldsForCredentials(ids),
      this.totpForCredentials(ids),
      this.attachmentCountsForCredentials(ids),
    ]);
    return rows.map((r) => rowToCredential(r, this.box, fieldMap.get(r.id) ?? [], {
      hasTotp: totpSet.has(r.id),
      attachmentCount: attachCounts.get(r.id) ?? 0,
    }));
  }

  async getById(userId: string, id: string): Promise<Credential> {
    const { rows } = await this.pool.query<CredRow>(
      `SELECT ${CRED_COLS} FROM credentials WHERE id = $1 AND user_id = $2`,
      [id, userId],
    );
    if (!rows[0]) throw PhaseTwoErrors.CredentialNotFound();
    const [fields, totpSet, attachCounts] = await Promise.all([
      this.fieldsOf(rows[0].id),
      this.totpForCredentials([rows[0].id]),
      this.attachmentCountsForCredentials([rows[0].id]),
    ]);
    return rowToCredential(rows[0], this.box, fields, {
      hasTotp: totpSet.has(rows[0].id),
      attachmentCount: attachCounts.get(rows[0].id) ?? 0,
    });
  }

  async create(input: {
    userId: string; name: string; credentialType: CredentialType;
    username?: string | null; secretData?: Record<string, unknown>; description?: string | null;
    folderId?: string | null; favorite?: boolean; expiresAt?: Date | null;
    fields?: CredentialFieldInput[];
  }): Promise<Credential> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<CredRow>(
        `INSERT INTO credentials
           (user_id, name, credential_type, username, secret_data, description, folder_id, favorite, expires_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, COALESCE($8, FALSE), $9)
         RETURNING ${CRED_COLS}`,
        [input.userId, input.name, input.credentialType, input.username ?? null,
         JSON.stringify(this.box.seal(input.secretData ?? {})), input.description ?? null,
         input.folderId ?? null, input.favorite ?? null, input.expiresAt ?? null],
      );
      const cred = rows[0]!;
      if (input.fields && input.fields.length > 0) {
        await this.insertFields(client, cred.id, input.fields);
      }
      await client.query("COMMIT");
      const fields = await this.fieldsOf(cred.id);
      return rowToCredential(cred, this.box, fields);
    } catch (e) {
      await client.query("ROLLBACK");
      throw wrapUniqueViolation(e, PhaseTwoErrors.CredentialNameTaken);
    } finally {
      client.release();
    }
  }

  async update(userId: string, id: string, patch: {
    name?: string; username?: string | null; secretData?: Record<string, unknown>; description?: string | null;
    folderId?: string | null; favorite?: boolean; expiresAt?: Date | null;
    fields?: CredentialFieldInput[];
  }): Promise<Credential> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<CredRow>(
        `UPDATE credentials SET
           name        = COALESCE($3, name),
           username    = CASE WHEN $4::text = '__nochange__' THEN username
                              WHEN $4::text = '__null__' THEN NULL
                              ELSE $4 END,
           secret_data = CASE WHEN $5::text = '__nochange__' THEN secret_data
                              ELSE $5::jsonb END,
           description = CASE WHEN $6::text = '__nochange__' THEN description
                              WHEN $6::text = '__null__' THEN NULL
                              ELSE $6 END,
           folder_id   = CASE WHEN $7::text = '__nochange__' THEN folder_id
                              WHEN $7::text = '__null__' THEN NULL
                              ELSE $7::uuid END,
           favorite    = COALESCE($8, favorite),
           expires_at  = CASE WHEN $9::text = '__nochange__' THEN expires_at
                              WHEN $9::text = '__null__' THEN NULL
                              ELSE $9::timestamptz END,
           updated_at  = NOW()
         WHERE id = $1 AND user_id = $2
         RETURNING ${CRED_COLS}`,
        [
          id, userId,
          patch.name ?? null,
          patch.username === undefined ? "__nochange__" : (patch.username === null ? "__null__" : patch.username),
          patch.secretData === undefined ? "__nochange__" : JSON.stringify(this.box.seal(patch.secretData)),
          patch.description === undefined ? "__nochange__" : (patch.description === null ? "__null__" : patch.description),
          patch.folderId === undefined ? "__nochange__" : (patch.folderId === null ? "__null__" : patch.folderId),
          patch.favorite ?? null,
          patch.expiresAt === undefined ? "__nochange__" : (patch.expiresAt === null ? "__null__" : patch.expiresAt.toISOString()),
        ],
      );
      if (!rows[0]) throw PhaseTwoErrors.CredentialNotFound();
      // fields undefined => keep as-is; provided (even empty) => full replace.
      if (patch.fields !== undefined) {
        await client.query(`DELETE FROM credential_fields WHERE credential_id = $1`, [id]);
        if (patch.fields.length > 0) await this.insertFields(client, id, patch.fields);
      }
      await client.query("COMMIT");
      const fields = await this.fieldsOf(id);
      return rowToCredential(rows[0], this.box, fields);
    } catch (e) {
      await client.query("ROLLBACK");
      if (e instanceof Error && e.message.includes("credential_not_found")) throw e;
      throw wrapUniqueViolation(e, PhaseTwoErrors.CredentialNameTaken);
    } finally {
      client.release();
    }
  }

  async delete(userId: string, id: string): Promise<void> {
    const r = await this.pool.query(`DELETE FROM credentials WHERE id = $1 AND user_id = $2`, [id, userId]);
    if (r.rowCount === 0) throw PhaseTwoErrors.CredentialNotFound();
  }

  // ---- custom fields -------------------------------------------------

  private async insertFields(client: PoolClient, credentialId: string, fields: CredentialFieldInput[]): Promise<void> {
    for (const [i, f] of fields.entries()) {
      await client.query(
        `INSERT INTO credential_fields (credential_id, label, value_enc, is_secret, sort_order)
         VALUES ($1, $2, $3::jsonb, $4, $5)`,
        [credentialId, f.label, JSON.stringify(this.box.seal({ v: f.value })), f.isSecret ?? true, f.sortOrder ?? i],
      );
    }
  }

  private async fieldsOf(credentialId: string): Promise<CredentialField[]> {
    const { rows } = await this.pool.query<FieldRow>(
      `SELECT ${FIELD_COLS} FROM credential_fields WHERE credential_id = $1 ORDER BY sort_order, label`,
      [credentialId],
    );
    return rows.map((r) => rowToField(r, this.box));
  }

  private async fieldsForCredentials(ids: string[]): Promise<Map<string, CredentialField[]>> {
    const map = new Map<string, CredentialField[]>();
    if (ids.length === 0) return map;
    const { rows } = await this.pool.query<FieldRow>(
      `SELECT ${FIELD_COLS} FROM credential_fields WHERE credential_id = ANY($1::uuid[]) ORDER BY sort_order, label`,
      [ids],
    );
    for (const id of ids) map.set(id, []);
    for (const r of rows) map.get(r.credential_id)?.push(rowToField(r, this.box));
    return map;
  }

  /** Which of these credentials have a TOTP configured. */
  private async totpForCredentials(ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const { rows } = await this.pool.query<{ credential_id: string }>(
      `SELECT credential_id FROM credential_totp WHERE credential_id = ANY($1::uuid[])`,
      [ids],
    );
    return new Set(rows.map((r) => r.credential_id));
  }

  /** Attachment counts keyed by credential id. */
  private async attachmentCountsForCredentials(ids: string[]): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    if (ids.length === 0) return map;
    const { rows } = await this.pool.query<{ credential_id: string; c: string }>(
      `SELECT credential_id, COUNT(*)::text AS c FROM credential_attachments
       WHERE credential_id = ANY($1::uuid[]) GROUP BY credential_id`,
      [ids],
    );
    for (const r of rows) map.set(r.credential_id, Number(r.c));
    return map;
  }
}

// =====================================================================
// HostRepository
// =====================================================================

interface HostRow {
  id: string; user_id: string; folder_id: string | null; credential_id: string | null;
  name: string; hostname: string; port: number; protocol: string;
  description: string | null; is_favorite: boolean; is_shared: boolean;
  vpn_profile_id: string | null;
  options: Record<string, unknown>;
  last_used_at: Date | null; use_count: number;
  created_at: Date; updated_at: Date;
}

const HOST_COLS = `id, user_id, folder_id, credential_id, name, hostname, port, protocol,
                   description, is_favorite, is_shared, vpn_profile_id, options, last_used_at, use_count, created_at, updated_at`;

function rowToHost(r: HostRow): Host {
  return {
    id: r.id, userId: r.user_id, folderId: r.folder_id, credentialId: r.credential_id,
    name: r.name, hostname: r.hostname, port: r.port,
    protocol: r.protocol as HostProtocol,
    description: r.description, isFavorite: r.is_favorite, isShared: r.is_shared,
    vpnProfileId: r.vpn_profile_id,
    options: r.options ?? {},
    lastUsedAt: r.last_used_at, useCount: r.use_count,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export interface HostListFilters {
  folderId?: string | "root" | null;   // "root" = parentless
  tagIds?: string[];
  protocol?: HostProtocol;
  q?: string;                          // free-text on name + hostname
  favoritesOnly?: boolean;
  limit?: number;
  offset?: number;
}

export class HostRepository {
  constructor(private readonly pool: Pool) {}

  async list(userId: string, filters: HostListFilters = {}): Promise<{ hosts: Host[]; total: number }> {
    // Visible hosts = your own OR shared WITHIN YOUR COMPANY OR shared with you.
    // SEC-003: `is_shared` must be scoped to the owner/viewer's company, not the
    // whole installation — otherwise a user in another tenant sees (and can
    // connect through, with the owner's credential) this company's shared hosts.
    const where: string[] = [
      "(h.user_id = $1 OR (h.is_shared = TRUE AND h.company_id = (SELECT company_id FROM users WHERE id = $1)) OR EXISTS (SELECT 1 FROM host_shares hs WHERE hs.host_id = h.id AND hs.user_id = $1))",
    ];
    const params: unknown[] = [userId];
    let p = 1;

    if (filters.folderId === "root") {
      where.push("h.folder_id IS NULL");
    } else if (filters.folderId) {
      params.push(filters.folderId); p++;
      where.push(`h.folder_id = $${p}`);
    }
    if (filters.protocol) {
      params.push(filters.protocol); p++;
      where.push(`h.protocol = $${p}`);
    }
    if (filters.favoritesOnly) {
      where.push("h.is_favorite = TRUE");
    }
    if (filters.q) {
      params.push(`%${filters.q}%`); p++;
      where.push(`(h.name ILIKE $${p} OR h.hostname ILIKE $${p})`);
    }
    if (filters.tagIds?.length) {
      params.push(filters.tagIds); p++;
      where.push(`h.id IN (
        SELECT host_id FROM host_tags WHERE tag_id = ANY($${p}::uuid[])
        GROUP BY host_id HAVING COUNT(DISTINCT tag_id) = ${filters.tagIds.length}
      )`);
    }

    const whereSql = where.join(" AND ");
    const limit = Math.max(1, Math.min(200, filters.limit ?? 50));
    const offset = Math.max(0, filters.offset ?? 0);

    // IMPORTANT: build separate param arrays for count vs list. The earlier
    // version mutated a shared array, which made the count query see the
    // limit/offset params and fail with "bind message supplies N parameters,
    // but prepared statement requires M".
    const countParams = [...params];
    const listParams  = [...params, limit, offset];
    const limitPlaceholder  = `$${listParams.length - 1}`;
    const offsetPlaceholder = `$${listParams.length}`;

    const countQ = this.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM hosts h WHERE ${whereSql}`,
      countParams,
    );
    const listQ = this.pool.query<HostRow>(
      `SELECT ${HOST_COLS.split(",").map((c) => `h.${c.trim()}`).join(", ")} FROM hosts h
       WHERE ${whereSql}
       ORDER BY h.is_favorite DESC, h.last_used_at DESC NULLS LAST, h.name
       LIMIT ${limitPlaceholder} OFFSET ${offsetPlaceholder}`,
      listParams,
    );
    const [c, l] = await Promise.all([countQ, listQ]);
    return {
      total: Number(c.rows[0]?.count ?? 0),
      hosts: l.rows.map(rowToHost),
    };
  }

  async getById(userId: string, id: string): Promise<Host> {
    const { rows } = await this.pool.query<HostRow>(
      `SELECT ${HOST_COLS} FROM hosts
       WHERE id = $1 AND (user_id = $2
                          OR (is_shared = TRUE AND company_id = (SELECT company_id FROM users WHERE id = $2))
                          OR EXISTS (SELECT 1 FROM host_shares hs WHERE hs.host_id = hosts.id AND hs.user_id = $2))`,
      [id, userId],
    );
    if (!rows[0]) throw PhaseTwoErrors.HostNotFound();
    return rowToHost(rows[0]);
  }

  async create(input: {
    userId: string;
    name: string;
    hostname: string;
    port: number;
    protocol: HostProtocol;
    folderId?: string | null;
    credentialId?: string | null;
    description?: string | null;
    options?: Record<string, unknown>;
    isShared?: boolean;
    vpnProfileId?: string | null;
  }): Promise<Host> {
    try {
      const { rows } = await this.pool.query<HostRow>(
        `INSERT INTO hosts (user_id, name, hostname, port, protocol, folder_id, credential_id, description, options, is_shared, vpn_profile_id, company_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, (SELECT company_id FROM users WHERE id = $1))
         RETURNING ${HOST_COLS}`,
        [
          input.userId, input.name, input.hostname, input.port, input.protocol,
          input.folderId ?? null, input.credentialId ?? null,
          input.description ?? null,
          JSON.stringify(input.options ?? {}),
          input.isShared ?? false,
          input.vpnProfileId ?? null,
        ],
      );
      return rowToHost(rows[0]!);
    } catch (e) {
      throw wrapUniqueViolation(e, PhaseTwoErrors.HostNameTaken);
    }
  }

  async update(userId: string, id: string, patch: {
    name?: string; hostname?: string; port?: number; protocol?: HostProtocol;
    folderId?: string | null; credentialId?: string | null;
    description?: string | null;
    options?: Record<string, unknown>;
    isFavorite?: boolean;
    isShared?: boolean;
    vpnProfileId?: string | null;
  }): Promise<Host> {
    try {
      const { rows } = await this.pool.query<HostRow>(
        `UPDATE hosts SET
           name        = COALESCE($3, name),
           hostname    = COALESCE($4, hostname),
           port        = COALESCE($5, port),
           protocol    = COALESCE($6, protocol),
           folder_id     = CASE WHEN $7::text = '__nochange__' THEN folder_id
                                WHEN $7::text = '__null__' THEN NULL
                                ELSE $7::uuid END,
           credential_id = CASE WHEN $8::text = '__nochange__' THEN credential_id
                                WHEN $8::text = '__null__' THEN NULL
                                ELSE $8::uuid END,
           description = CASE WHEN $9::text = '__nochange__' THEN description
                              WHEN $9::text = '__null__' THEN NULL
                              ELSE $9 END,
           options     = CASE WHEN $10::text = '__nochange__' THEN options
                              ELSE $10::jsonb END,
           is_favorite = COALESCE($11, is_favorite),
           is_shared   = COALESCE($12, is_shared),
           vpn_profile_id = CASE WHEN $13::text = '__nochange__' THEN vpn_profile_id
                                 WHEN $13::text = '__null__' THEN NULL
                                 ELSE $13::uuid END,
           updated_at  = NOW()
         WHERE id = $1 AND user_id = $2
         RETURNING ${HOST_COLS}`,
        [
          id, userId,
          patch.name ?? null, patch.hostname ?? null,
          patch.port ?? null, patch.protocol ?? null,
          patch.folderId === undefined ? "__nochange__" : (patch.folderId === null ? "__null__" : patch.folderId),
          patch.credentialId === undefined ? "__nochange__" : (patch.credentialId === null ? "__null__" : patch.credentialId),
          patch.description === undefined ? "__nochange__" : (patch.description === null ? "__null__" : patch.description),
          patch.options === undefined ? "__nochange__" : JSON.stringify(patch.options),
          patch.isFavorite ?? null,
          patch.isShared ?? null,
          patch.vpnProfileId === undefined ? "__nochange__" : (patch.vpnProfileId === null ? "__null__" : patch.vpnProfileId),
        ],
      );
      if (!rows[0]) throw PhaseTwoErrors.HostNotFound();
      return rowToHost(rows[0]);
    } catch (e) {
      if (e instanceof Error && e.message.includes("host_not_found")) throw e;
      throw wrapUniqueViolation(e, PhaseTwoErrors.HostNameTaken);
    }
  }

  async delete(userId: string, id: string): Promise<void> {
    const r = await this.pool.query(`DELETE FROM hosts WHERE id = $1 AND user_id = $2`, [id, userId]);
    if (r.rowCount === 0) throw PhaseTwoErrors.HostNotFound();
  }

  async touch(userId: string, id: string): Promise<void> {
    // Shared hosts can be connected (and thus touched) by non-owners too.
    const r = await this.pool.query(
      `UPDATE hosts SET last_used_at = NOW(), use_count = use_count + 1
       WHERE id = $1 AND (user_id = $2
                          OR (is_shared = TRUE AND company_id = (SELECT company_id FROM users WHERE id = $2))
                          OR EXISTS (SELECT 1 FROM host_shares hs WHERE hs.host_id = hosts.id AND hs.user_id = $2))`,
      [id, userId],
    );
    if (r.rowCount === 0) throw PhaseTwoErrors.HostNotFound();
  }

  // ---- per-user sharing (owner-managed) -----------------------------

  /** Replace the set of users a host is explicitly shared with. Owner only. */
  async setShares(ownerId: string, hostId: string, userIds: string[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const own = await client.query(`SELECT id FROM hosts WHERE id = $1 AND user_id = $2`, [hostId, ownerId]);
      if (own.rowCount === 0) throw PhaseTwoErrors.HostNotFound();
      await client.query(`DELETE FROM host_shares WHERE host_id = $1`, [hostId]);
      // Never share with the owner themselves; de-dup.
      const targets = [...new Set(userIds)].filter((u) => u && u !== ownerId);
      if (targets.length > 0) {
        const values = targets.map((_, i) => `($1, $${i + 2}::uuid)`).join(",");
        await client.query(`INSERT INTO host_shares (host_id, user_id) VALUES ${values}`, [hostId, ...targets]);
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  /** User ids a host is explicitly shared with. Owner only. */
  async getShareUserIds(ownerId: string, hostId: string): Promise<string[]> {
    const own = await this.pool.query(`SELECT id FROM hosts WHERE id = $1 AND user_id = $2`, [hostId, ownerId]);
    if (own.rowCount === 0) throw PhaseTwoErrors.HostNotFound();
    const { rows } = await this.pool.query<{ user_id: string }>(
      `SELECT user_id FROM host_shares WHERE host_id = $1`,
      [hostId],
    );
    return rows.map((r) => r.user_id);
  }

  // ---- tags M2M -----------------------------------------------------

  async setTags(userId: string, hostId: string, tagIds: string[]): Promise<Tag[]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Verify host ownership
      const ownership = await client.query<{ id: string }>(
        `SELECT id FROM hosts WHERE id = $1 AND user_id = $2`,
        [hostId, userId],
      );
      if (ownership.rowCount === 0) throw PhaseTwoErrors.HostNotFound();

      if (tagIds.length > 0) {
        // Verify all tags belong to user
        const owned = await client.query<{ id: string }>(
          `SELECT id FROM tags WHERE user_id = $1 AND id = ANY($2::uuid[])`,
          [userId, tagIds],
        );
        if (owned.rows.length !== tagIds.length) throw PhaseTwoErrors.TagNotFound();
      }

      await client.query(`DELETE FROM host_tags WHERE host_id = $1`, [hostId]);
      if (tagIds.length > 0) {
        const values = tagIds.map((_, i) => `($1, $${i + 2}::uuid)`).join(",");
        await client.query(`INSERT INTO host_tags (host_id, tag_id) VALUES ${values}`, [hostId, ...tagIds]);
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
    return this.tagsOf(userId, hostId);
  }

  async tagsOf(userId: string, hostId: string): Promise<Tag[]> {
    const { rows } = await this.pool.query<TagRow>(
      `SELECT t.${TAG_COLS.split(",").map((c) => c.trim()).join(", t.")}
       FROM tags t INNER JOIN host_tags ht ON ht.tag_id = t.id
       INNER JOIN hosts h ON h.id = ht.host_id
       WHERE h.user_id = $1 AND ht.host_id = $2
       ORDER BY t.name`,
      [userId, hostId],
    );
    return rows.map(rowToTag);
  }

  async tagsForHosts(userId: string, hostIds: string[]): Promise<Map<string, Tag[]>> {
    if (hostIds.length === 0) return new Map();
    const { rows } = await this.pool.query<TagRow & { host_id: string }>(
      `SELECT ht.host_id, t.${TAG_COLS.split(",").map((c) => c.trim()).join(", t.")}
       FROM tags t INNER JOIN host_tags ht ON ht.tag_id = t.id
       INNER JOIN hosts h ON h.id = ht.host_id
       WHERE h.user_id = $1 AND ht.host_id = ANY($2::uuid[])`,
      [userId, hostIds],
    );
    const map = new Map<string, Tag[]>();
    for (const id of hostIds) map.set(id, []);
    for (const r of rows) {
      const arr = map.get(r.host_id);
      if (arr) arr.push(rowToTag(r));
    }
    return map;
  }
}

// =====================================================================
// ConnectionHistoryRepository
// =====================================================================

interface HistoryRow {
  id: string;
  user_id: string;
  host_id: string | null;
  host_name_snapshot: string;
  hostname_snapshot: string;
  port_snapshot: number;
  protocol: string;
  started_at: Date;
  ended_at: Date | null;
  duration_ms: number | null;
  status: string;
  error_message: string | null;
  client_ip: string | null;
  bytes_in: string;
  bytes_out: string;
}

const HISTORY_COLS = `id, user_id, host_id, host_name_snapshot, hostname_snapshot, port_snapshot, protocol,
                      started_at, ended_at, duration_ms, status, error_message, client_ip::text AS client_ip,
                      bytes_in::text AS bytes_in, bytes_out::text AS bytes_out`;

function rowToHistory(r: HistoryRow): ConnectionHistoryEntry {
  return {
    id: Number(r.id),
    userId: r.user_id,
    hostId: r.host_id,
    hostNameSnapshot: r.host_name_snapshot,
    hostnameSnapshot: r.hostname_snapshot,
    portSnapshot: r.port_snapshot,
    protocol: r.protocol as HostProtocol,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    durationMs: r.duration_ms,
    status: r.status as ConnectionStatus,
    errorMessage: r.error_message,
    clientIp: r.client_ip,
    bytesIn: Number(r.bytes_in),
    bytesOut: Number(r.bytes_out),
  };
}

export class ConnectionHistoryRepository {
  constructor(private readonly pool: Pool) {}

  async list(userId: string, opts: { limit?: number; offset?: number; hostId?: string } = {}): Promise<{ entries: ConnectionHistoryEntry[]; total: number }> {
    const limit = Math.max(1, Math.min(200, opts.limit ?? 50));
    const offset = Math.max(0, opts.offset ?? 0);

    const where = ["user_id = $1"];
    const params: unknown[] = [userId];
    if (opts.hostId) {
      params.push(opts.hostId);
      where.push(`host_id = $${params.length}`);
    }

    const whereSql = where.join(" AND ");
    // Separate param arrays (see HostRepository.list for the bug this avoids).
    const countParams = [...params];
    const listParams  = [...params, limit, offset];
    const limitPlaceholder  = `$${listParams.length - 1}`;
    const offsetPlaceholder = `$${listParams.length}`;

    const countQ = this.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM connection_history WHERE ${whereSql}`,
      countParams,
    );
    const listQ = this.pool.query<HistoryRow>(
      `SELECT ${HISTORY_COLS} FROM connection_history WHERE ${whereSql}
       ORDER BY started_at DESC LIMIT ${limitPlaceholder} OFFSET ${offsetPlaceholder}`,
      listParams,
    );
    const [c, l] = await Promise.all([countQ, listQ]);
    return {
      total: Number(c.rows[0]?.count ?? 0),
      entries: l.rows.map(rowToHistory),
    };
  }

  /** Records the start of a connection attempt. Returns the new id. */
  async start(input: {
    userId: string;
    hostId: string | null;
    hostNameSnapshot: string;
    hostnameSnapshot: string;
    portSnapshot: number;
    protocol: HostProtocol;
    clientIp?: string | null;
  }): Promise<number> {
    const { rows } = await this.pool.query<{ id: string }>(
      `INSERT INTO connection_history
         (user_id, host_id, host_name_snapshot, hostname_snapshot, port_snapshot, protocol, client_ip)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [input.userId, input.hostId, input.hostNameSnapshot, input.hostnameSnapshot,
       input.portSnapshot, input.protocol, input.clientIp ?? null],
    );
    return Number(rows[0]!.id);
  }

  async end(id: number, status: ConnectionStatus, opts: { errorMessage?: string | null; bytesIn?: number; bytesOut?: number } = {}): Promise<void> {
    await this.pool.query(
      `UPDATE connection_history
       SET ended_at = NOW(),
           duration_ms = EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000,
           status = $2,
           error_message = $3,
           bytes_in = $4,
           bytes_out = $5
       WHERE id = $1`,
      [id, status, opts.errorMessage ?? null, opts.bytesIn ?? 0, opts.bytesOut ?? 0],
    );
  }

  async deleteOlderThan(userId: string, cutoff: Date): Promise<number> {
    const r = await this.pool.query(
      `DELETE FROM connection_history WHERE user_id = $1 AND started_at < $2`,
      [userId, cutoff],
    );
    return r.rowCount ?? 0;
  }

  async getById(userId: string, id: number): Promise<ConnectionHistoryEntry> {
    const { rows } = await this.pool.query<HistoryRow>(
      `SELECT ${HISTORY_COLS} FROM connection_history WHERE id = $1 AND user_id = $2`,
      [id, userId],
    );
    if (!rows[0]) throw PhaseTwoErrors.HistoryNotFound();
    return rowToHistory(rows[0]);
  }
}

// avoid unused-warning on PoolClient
void (null as unknown as PoolClient);
