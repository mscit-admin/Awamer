/**
 * Backup / restore of a user's own session data: folders, tags, credentials
 * (with secrets) and hosts (with folder/credential links and tag assignments).
 *
 * Everything is owner-scoped — a backup only ever contains the calling user's
 * own rows, and a restore only ever writes rows owned by that user. Restore is
 * additive (it never deletes or overwrites existing rows): on a name clash it
 * either renames the incoming item ("merge") or links to the existing one
 * ("skip"). Relationships are preserved by carrying the original ids as opaque
 * "refs" and remapping them to freshly-created ids on import.
 */
import type { Pool } from "../db/index.js";
import type { SecretBox } from "../crypto/secretBox.js";

export interface BackupFolder { ref: string; name: string; parent_ref: string | null; color: string | null; icon: string | null; sort_order: number }
export interface BackupTag { ref: string; name: string; color: string | null }
export interface BackupCredential { ref: string; name: string; credential_type: string; username: string | null; secret_data: Record<string, unknown> | null; description: string | null }
export interface BackupHost {
  name: string; hostname: string; port: number; protocol: string;
  folder_ref: string | null; credential_ref: string | null;
  description: string | null; is_favorite: boolean; is_shared: boolean;
  options: Record<string, unknown>; tag_refs: string[];
}
export interface BackupData {
  folders: BackupFolder[];
  tags: BackupTag[];
  credentials: BackupCredential[];
  hosts: BackupHost[];
}

interface Counts { created: number; skipped: number }
export interface ImportSummary {
  folders: Counts; tags: Counts; credentials: Counts; hosts: Counts;
}

const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

type Querier = { query: (...args: any[]) => Promise<any> };

function isUniqueViolation(e: unknown): boolean {
  return !!e && typeof e === "object" && (e as { code?: string }).code === "23505";
}

export class BackupRepository {
  constructor(private readonly pool: Pool, private readonly box: SecretBox) {}

  /** Collect the user's own data. When includeSecrets is false, credential
   *  secret material is stripped (metadata only). */
  async exportForUser(userId: string, includeSecrets: boolean): Promise<BackupData> {
    const [folders, tags, creds, hosts, hostTags] = await Promise.all([
      this.pool.query(`SELECT id, name, parent_id, color, icon, sort_order FROM folders WHERE user_id = $1`, [userId]),
      this.pool.query(`SELECT id, name, color FROM tags WHERE user_id = $1`, [userId]),
      this.pool.query(`SELECT id, name, credential_type, username, secret_data, description FROM credentials WHERE user_id = $1`, [userId]),
      this.pool.query(`SELECT id, name, hostname, port, protocol, folder_id, credential_id, description, is_favorite, is_shared, options FROM hosts WHERE user_id = $1`, [userId]),
      this.pool.query(`SELECT ht.host_id, ht.tag_id FROM host_tags ht JOIN hosts h ON h.id = ht.host_id WHERE h.user_id = $1`, [userId]),
    ]);

    const tagsByHost = new Map<string, string[]>();
    for (const r of hostTags.rows as { host_id: string; tag_id: string }[]) {
      const arr = tagsByHost.get(r.host_id) ?? [];
      arr.push(r.tag_id);
      tagsByHost.set(r.host_id, arr);
    }

    return {
      folders: folders.rows.map((r: any) => ({
        ref: r.id, name: r.name, parent_ref: r.parent_id, color: r.color, icon: r.icon, sort_order: r.sort_order,
      })),
      tags: tags.rows.map((r: any) => ({ ref: r.id, name: r.name, color: r.color })),
      credentials: creds.rows.map((r: any) => ({
        ref: r.id, name: r.name, credential_type: r.credential_type, username: r.username,
        secret_data: includeSecrets ? this.box.open(r.secret_data ?? {}) : null,
        description: r.description,
      })),
      hosts: hosts.rows.map((r: any) => ({
        name: r.name, hostname: r.hostname, port: r.port, protocol: r.protocol,
        folder_ref: r.folder_id, credential_ref: r.credential_id,
        description: r.description, is_favorite: r.is_favorite, is_shared: r.is_shared,
        options: r.options ?? {}, tag_refs: tagsByHost.get(r.id) ?? [],
      })),
    };
  }

  async importForUser(
    userId: string,
    data: BackupData,
    opts: { mode: "merge" | "skip" },
  ): Promise<ImportSummary> {
    const summary: ImportSummary = {
      folders: { created: 0, skipped: 0 },
      tags: { created: 0, skipped: 0 },
      credentials: { created: 0, skipped: 0 },
      hosts: { created: 0, skipped: 0 },
    };
    const folderMap = new Map<string, string>();
    const tagMap = new Map<string, string>();
    const credMap = new Map<string, string>();

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      // ---- Folders (parents before children) ----
      const pending = [...(data.folders ?? [])];
      let guard = pending.length + 1;
      while (pending.length && guard-- > 0) {
        for (let i = pending.length - 1; i >= 0; i--) {
          const f = pending[i]!;
          const parentNew = f.parent_ref === null ? null : folderMap.get(f.parent_ref);
          if (f.parent_ref !== null && parentNew === undefined) continue; // parent not created yet
          if (opts.mode === "skip") {
            const found = await client.query(
              `SELECT id FROM folders WHERE user_id = $1 AND name = $2 AND COALESCE(parent_id, $3::uuid) = COALESCE($4::uuid, $3::uuid)`,
              [userId, f.name, ZERO_UUID, parentNew ?? null],
            );
            if (found.rows[0]) { folderMap.set(f.ref, found.rows[0].id); summary.folders.skipped++; pending.splice(i, 1); continue; }
          }
          const id = await this.insertWithSuffix(client, f.name, (name) =>
            client.query(
              `INSERT INTO folders (user_id, parent_id, name, color, icon, sort_order) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
              [userId, parentNew ?? null, name, f.color, f.icon, f.sort_order ?? 0],
            ),
          );
          folderMap.set(f.ref, id);
          summary.folders.created++;
          pending.splice(i, 1);
        }
      }

      // ---- Tags ----
      for (const t of data.tags ?? []) {
        if (opts.mode === "skip") {
          const found = await client.query(`SELECT id FROM tags WHERE user_id = $1 AND name = $2`, [userId, t.name]);
          if (found.rows[0]) { tagMap.set(t.ref, found.rows[0].id); summary.tags.skipped++; continue; }
        }
        const id = await this.insertWithSuffix(client, t.name, (name) =>
          client.query(`INSERT INTO tags (user_id, name, color) VALUES ($1,$2,$3) RETURNING id`, [userId, name, t.color]),
        );
        tagMap.set(t.ref, id);
        summary.tags.created++;
      }

      // ---- Credentials ----
      for (const c of data.credentials ?? []) {
        if (opts.mode === "skip") {
          const found = await client.query(`SELECT id FROM credentials WHERE user_id = $1 AND name = $2`, [userId, c.name]);
          if (found.rows[0]) { credMap.set(c.ref, found.rows[0].id); summary.credentials.skipped++; continue; }
        }
        const sealed = JSON.stringify(this.box.seal(c.secret_data ?? {}));
        const id = await this.insertWithSuffix(client, c.name, (name) =>
          client.query(
            `INSERT INTO credentials (user_id, name, credential_type, username, secret_data, description)
             VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
            [userId, name, c.credential_type, c.username, sealed, c.description],
          ),
        );
        credMap.set(c.ref, id);
        summary.credentials.created++;
      }

      // ---- Hosts (+ tag links) ----
      for (const h of data.hosts ?? []) {
        const folderId = h.folder_ref ? folderMap.get(h.folder_ref) ?? null : null;
        const credId = h.credential_ref ? credMap.get(h.credential_ref) ?? null : null;
        if (opts.mode === "skip") {
          const found = await client.query(`SELECT id FROM hosts WHERE user_id = $1 AND name = $2`, [userId, h.name]);
          if (found.rows[0]) { summary.hosts.skipped++; continue; }
        }
        let hostId = "";
        hostId = await this.insertWithSuffix(client, h.name, (name) =>
          client.query(
            `INSERT INTO hosts (user_id, name, hostname, port, protocol, folder_id, credential_id, description, is_favorite, is_shared, options)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb) RETURNING id`,
            [userId, name, h.hostname, h.port, h.protocol, folderId, credId, h.description, h.is_favorite ?? false, h.is_shared ?? false, JSON.stringify(h.options ?? {})],
          ),
        );
        summary.hosts.created++;
        const tagIds = (h.tag_refs ?? []).map((r) => tagMap.get(r)).filter((x): x is string => !!x);
        for (const tagId of tagIds) {
          await client.query(`INSERT INTO host_tags (host_id, tag_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [hostId, tagId]);
        }
      }

      await client.query("COMMIT");
      return summary;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  /**
   * Insert, retrying with a " (restored)" suffix on a unique-name clash. Each
   * attempt runs inside a SAVEPOINT so a unique violation doesn't abort the
   * surrounding transaction (it only rolls back the failed statement).
   */
  private async insertWithSuffix(
    client: Querier,
    baseName: string,
    run: (name: string) => Promise<{ rows: { id: string }[] }>,
  ): Promise<string> {
    for (let attempt = 0; attempt < 100; attempt++) {
      const name = attempt === 0 ? baseName : `${baseName} (restored${attempt === 1 ? "" : " " + attempt})`;
      await client.query("SAVEPOINT ins");
      try {
        const r = await run(name);
        await client.query("RELEASE SAVEPOINT ins");
        return r.rows[0]!.id;
      } catch (e) {
        await client.query("ROLLBACK TO SAVEPOINT ins");
        if (isUniqueViolation(e)) continue;
        throw e;
      }
    }
    throw new Error(`could not find a free name for "${baseName}"`);
  }
}
