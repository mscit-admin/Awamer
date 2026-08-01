/**
 * OpenVPN profile repository (migration 017).
 *
 * Owner-scoped CRUD over `vpn_profiles`. Secret material (config text, inline
 * PEM material, auth username/password) is encrypted at rest with the same
 * SecretBox as credential secrets — the DB never sees plaintext.
 *
 * `resolveForHost` implements the inheritance rule: a host's effective profile
 * is its own `vpn_profile_id`, else the nearest ancestor folder's, walking up
 * the (per-user) folder tree. All resolution is scoped to the requesting user,
 * so a shared host owned by someone else never leaks its owner's VPN secrets.
 */
import type { Pool } from "../db/index.js";
import type { SecretBox } from "../crypto/secretBox.js";
import {
  type VpnProfile, type VpnSecret, type VpnRuntime, type VpnSource,
  type VpnProto, type VpnAuthMode, VpnErrors,
} from "../domain/vpn.js";

interface VpnRow {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  runtime: string;
  source: string;
  remote_host: string | null;
  remote_port: number | null;
  proto: string;
  auth_mode: string;
  auto_connect: boolean;
  secret_data: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

const COLS = `id, user_id, name, description, runtime, source, remote_host, remote_port,
              proto, auth_mode, auto_connect, secret_data, created_at, updated_at`;

function wrapUnique(e: unknown): Error {
  if ((e as { code?: string }).code === "23505") return VpnErrors.ProfileNameTaken();
  return e instanceof Error ? e : new Error(String(e));
}

export interface VpnProfileInput {
  name: string;
  description?: string | null;
  runtime?: VpnRuntime;
  source?: VpnSource;
  remoteHost?: string | null;
  remotePort?: number | null;
  proto?: VpnProto;
  authMode?: VpnAuthMode;
  autoConnect?: boolean;
  secret?: VpnSecret;
}

export type VpnProfilePatch = Partial<VpnProfileInput>;

export class VpnProfileRepository {
  constructor(private readonly pool: Pool, private readonly box: SecretBox) {}

  private rowToProfile(r: VpnRow): VpnProfile {
    return {
      id: r.id,
      userId: r.user_id,
      name: r.name,
      description: r.description,
      runtime: r.runtime as VpnRuntime,
      source: r.source as VpnSource,
      remoteHost: r.remote_host,
      remotePort: r.remote_port,
      proto: r.proto as VpnProto,
      authMode: r.auth_mode as VpnAuthMode,
      autoConnect: r.auto_connect,
      secret: (this.box.open(r.secret_data ?? {}) as VpnSecret) ?? {},
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  async listForUser(userId: string): Promise<VpnProfile[]> {
    const { rows } = await this.pool.query<VpnRow>(
      `SELECT ${COLS} FROM vpn_profiles WHERE user_id = $1 ORDER BY name`,
      [userId],
    );
    return rows.map((r) => this.rowToProfile(r));
  }

  async getById(userId: string, id: string): Promise<VpnProfile> {
    const { rows } = await this.pool.query<VpnRow>(
      `SELECT ${COLS} FROM vpn_profiles WHERE id = $1 AND user_id = $2`,
      [id, userId],
    );
    if (!rows[0]) throw VpnErrors.ProfileNotFound();
    return this.rowToProfile(rows[0]);
  }

  async create(userId: string, input: VpnProfileInput): Promise<VpnProfile> {
    try {
      const { rows } = await this.pool.query<VpnRow>(
        `INSERT INTO vpn_profiles
           (user_id, name, description, runtime, source, remote_host, remote_port,
            proto, auth_mode, auto_connect, secret_data)
         VALUES ($1, $2, $3, COALESCE($4,'desktop'), COALESCE($5,'config'), $6, $7,
                 COALESCE($8,'udp'), COALESCE($9,'none'), COALESCE($10, TRUE), $11::jsonb)
         RETURNING ${COLS}`,
        [
          userId, input.name, input.description ?? null,
          input.runtime ?? null, input.source ?? null,
          input.remoteHost ?? null, input.remotePort ?? null,
          input.proto ?? null, input.authMode ?? null,
          input.autoConnect ?? null,
          JSON.stringify(this.box.seal((input.secret ?? {}) as Record<string, unknown>)),
        ],
      );
      return this.rowToProfile(rows[0]!);
    } catch (e) {
      throw wrapUnique(e);
    }
  }

  async update(userId: string, id: string, patch: VpnProfilePatch): Promise<VpnProfile> {
    // Merge secrets: an omitted `secret` keeps the stored bundle; a provided
    // one replaces it wholesale (the route pre-merges partial edits).
    try {
      const { rows } = await this.pool.query<VpnRow>(
        `UPDATE vpn_profiles SET
           name         = COALESCE($3, name),
           description  = CASE WHEN $4::text = '__nochange__' THEN description
                               WHEN $4::text = '__null__' THEN NULL ELSE $4 END,
           runtime      = COALESCE($5, runtime),
           source       = COALESCE($6, source),
           remote_host  = CASE WHEN $7::text = '__nochange__' THEN remote_host
                               WHEN $7::text = '__null__' THEN NULL ELSE $7 END,
           remote_port  = CASE WHEN $8::text = '__nochange__' THEN remote_port
                               WHEN $8::text = '__null__' THEN NULL ELSE $8::integer END,
           proto        = COALESCE($9, proto),
           auth_mode    = COALESCE($10, auth_mode),
           auto_connect = COALESCE($11, auto_connect),
           secret_data  = CASE WHEN $12::text = '__nochange__' THEN secret_data
                               ELSE $12::jsonb END,
           updated_at   = NOW()
         WHERE id = $1 AND user_id = $2
         RETURNING ${COLS}`,
        [
          id, userId,
          patch.name ?? null,
          patch.description === undefined ? "__nochange__" : (patch.description === null ? "__null__" : patch.description),
          patch.runtime ?? null,
          patch.source ?? null,
          patch.remoteHost === undefined ? "__nochange__" : (patch.remoteHost === null ? "__null__" : patch.remoteHost),
          patch.remotePort === undefined ? "__nochange__" : (patch.remotePort === null ? "__null__" : String(patch.remotePort)),
          patch.proto ?? null,
          patch.authMode ?? null,
          patch.autoConnect ?? null,
          patch.secret === undefined ? "__nochange__" : JSON.stringify(this.box.seal(patch.secret as Record<string, unknown>)),
        ],
      );
      if (!rows[0]) throw VpnErrors.ProfileNotFound();
      return this.rowToProfile(rows[0]);
    } catch (e) {
      if (e instanceof Error && e.message.includes("vpn_profile_not_found")) throw e;
      throw wrapUnique(e);
    }
  }

  async delete(userId: string, id: string): Promise<void> {
    const r = await this.pool.query(`DELETE FROM vpn_profiles WHERE id = $1 AND user_id = $2`, [id, userId]);
    if (r.rowCount === 0) throw VpnErrors.ProfileNotFound();
  }

  /**
   * Resolve the effective VPN profile for a host owned by `userId`:
   * the host's own `vpn_profile_id`, else the nearest ancestor folder's.
   * Returns null when the asset (or its folder chain) names no profile.
   */
  async resolveForHost(userId: string, hostId: string): Promise<VpnProfile | null> {
    const { rows } = await this.pool.query<{ vpn_profile_id: string | null; folder_id: string | null }>(
      `SELECT vpn_profile_id, folder_id FROM hosts WHERE id = $1 AND user_id = $2`,
      [hostId, userId],
    );
    const host = rows[0];
    if (!host) return null;

    let profileId = host.vpn_profile_id;
    if (!profileId && host.folder_id) {
      const chain = await this.pool.query<{ vpn_profile_id: string | null; depth: number }>(
        `WITH RECURSIVE chain AS (
           SELECT id, parent_id, vpn_profile_id, 0 AS depth
             FROM folders WHERE id = $1 AND user_id = $2
           UNION ALL
           SELECT f.id, f.parent_id, f.vpn_profile_id, c.depth + 1
             FROM folders f INNER JOIN chain c ON f.id = c.parent_id AND f.user_id = $2
         )
         SELECT vpn_profile_id, depth FROM chain
         WHERE vpn_profile_id IS NOT NULL
         ORDER BY depth ASC LIMIT 1`,
        [host.folder_id, userId],
      );
      profileId = chain.rows[0]?.vpn_profile_id ?? null;
    }
    if (!profileId) return null;
    try {
      return await this.getById(userId, profileId);
    } catch {
      return null;
    }
  }
}
