/**
 * Credential vault, phase 2/3 — TOTP + file attachment repositories.
 *
 * Both hang off a credential and are strictly owner-scoped: every query joins
 * back to `credentials` on `user_id`, so a user can only touch sub-resources of
 * their own credentials. Secret material (the TOTP seed, the file bytes) is
 * encrypted at rest with the same SecretBox as `secret_data`.
 */

import type { Pool } from "../db/index.js";
import type { SecretBox } from "../crypto/secretBox.js";
import {
  type CredentialTotpConfig, type CredentialAttachmentMeta,
  type TotpAlgorithm, PhaseTwoErrors,
} from "../domain/session.js";

// =====================================================================
// TOTP
// =====================================================================

export interface TotpSecretAndConfig extends CredentialTotpConfig {
  secret: string; // base32
}

export interface SetTotpInput {
  secret: string;            // base32 (already normalised/validated by caller)
  algorithm: TotpAlgorithm;
  digits: number;
  period: number;
}

interface TotpRow {
  secret_enc: Record<string, unknown>;
  algorithm: string;
  digits: number;
  period: number;
  updated_at: Date;
}

export class CredentialTotpRepository {
  constructor(private readonly pool: Pool, private readonly box: SecretBox) {}

  /** Verify the credential belongs to the user; throws CredentialNotFound otherwise. */
  private async assertOwned(userId: string, credentialId: string): Promise<void> {
    const { rowCount } = await this.pool.query(
      `SELECT 1 FROM credentials WHERE id = $1 AND user_id = $2`,
      [credentialId, userId],
    );
    if (rowCount === 0) throw PhaseTwoErrors.CredentialNotFound();
  }

  /** Non-secret config, or null when no OTP is set. */
  async getConfig(userId: string, credentialId: string): Promise<CredentialTotpConfig | null> {
    await this.assertOwned(userId, credentialId);
    const { rows } = await this.pool.query<TotpRow>(
      `SELECT secret_enc, algorithm, digits, period, updated_at
       FROM credential_totp WHERE credential_id = $1`,
      [credentialId],
    );
    if (!rows[0]) return null;
    const r = rows[0];
    return { algorithm: r.algorithm as TotpAlgorithm, digits: r.digits, period: r.period, updatedAt: r.updated_at };
  }

  /** Config + decrypted base32 secret. Throws TotpNotFound when none is set. */
  async reveal(userId: string, credentialId: string): Promise<TotpSecretAndConfig> {
    await this.assertOwned(userId, credentialId);
    const { rows } = await this.pool.query<TotpRow>(
      `SELECT secret_enc, algorithm, digits, period, updated_at
       FROM credential_totp WHERE credential_id = $1`,
      [credentialId],
    );
    if (!rows[0]) throw PhaseTwoErrors.TotpNotFound();
    const r = rows[0];
    const opened = this.box.open(r.secret_enc ?? {}) as { secret?: unknown };
    return {
      secret: typeof opened.secret === "string" ? opened.secret : "",
      algorithm: r.algorithm as TotpAlgorithm, digits: r.digits, period: r.period, updatedAt: r.updated_at,
    };
  }

  async set(userId: string, credentialId: string, input: SetTotpInput): Promise<CredentialTotpConfig> {
    await this.assertOwned(userId, credentialId);
    const sealed = JSON.stringify(this.box.seal({ secret: input.secret }));
    const { rows } = await this.pool.query<TotpRow>(
      `INSERT INTO credential_totp (credential_id, secret_enc, algorithm, digits, period)
       VALUES ($1, $2::jsonb, $3, $4, $5)
       ON CONFLICT (credential_id) DO UPDATE SET
         secret_enc = EXCLUDED.secret_enc,
         algorithm  = EXCLUDED.algorithm,
         digits     = EXCLUDED.digits,
         period     = EXCLUDED.period,
         updated_at = NOW()
       RETURNING secret_enc, algorithm, digits, period, updated_at`,
      [credentialId, sealed, input.algorithm, input.digits, input.period],
    );
    const r = rows[0]!;
    return { algorithm: r.algorithm as TotpAlgorithm, digits: r.digits, period: r.period, updatedAt: r.updated_at };
  }

  async delete(userId: string, credentialId: string): Promise<void> {
    await this.assertOwned(userId, credentialId);
    const r = await this.pool.query(`DELETE FROM credential_totp WHERE credential_id = $1`, [credentialId]);
    if (r.rowCount === 0) throw PhaseTwoErrors.TotpNotFound();
  }
}

// =====================================================================
// Attachments
// =====================================================================

interface AttachRow {
  id: string; filename: string; mime_type: string;
  size_bytes: number; sha256: string; created_at: Date;
}

function rowToAttachmentMeta(r: AttachRow): CredentialAttachmentMeta {
  return {
    id: r.id, filename: r.filename, mimeType: r.mime_type,
    sizeBytes: r.size_bytes, sha256: r.sha256, createdAt: r.created_at,
  };
}

export class CredentialAttachmentRepository {
  constructor(private readonly pool: Pool, private readonly box: SecretBox) {}

  private async assertOwned(userId: string, credentialId: string): Promise<void> {
    const { rowCount } = await this.pool.query(
      `SELECT 1 FROM credentials WHERE id = $1 AND user_id = $2`,
      [credentialId, userId],
    );
    if (rowCount === 0) throw PhaseTwoErrors.CredentialNotFound();
  }

  async list(userId: string, credentialId: string): Promise<CredentialAttachmentMeta[]> {
    await this.assertOwned(userId, credentialId);
    const { rows } = await this.pool.query<AttachRow>(
      `SELECT id, filename, mime_type, size_bytes, sha256, created_at
       FROM credential_attachments WHERE credential_id = $1 ORDER BY filename, created_at`,
      [credentialId],
    );
    return rows.map(rowToAttachmentMeta);
  }

  async add(userId: string, credentialId: string, input: {
    filename: string; mimeType: string; bytes: Buffer; sha256: string;
  }): Promise<CredentialAttachmentMeta> {
    await this.assertOwned(userId, credentialId);
    const blob = this.box.sealBytes(input.bytes);
    const { rows } = await this.pool.query<AttachRow>(
      `INSERT INTO credential_attachments (credential_id, filename, mime_type, size_bytes, sha256, blob_enc)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, filename, mime_type, size_bytes, sha256, created_at`,
      [credentialId, input.filename, input.mimeType, input.bytes.length, input.sha256, blob],
    );
    return rowToAttachmentMeta(rows[0]!);
  }

  /** Metadata + decrypted bytes for download. */
  async getWithBytes(userId: string, credentialId: string, attachmentId: string): Promise<{ meta: CredentialAttachmentMeta; bytes: Buffer }> {
    await this.assertOwned(userId, credentialId);
    const { rows } = await this.pool.query<AttachRow & { blob_enc: Buffer }>(
      `SELECT id, filename, mime_type, size_bytes, sha256, created_at, blob_enc
       FROM credential_attachments WHERE id = $1 AND credential_id = $2`,
      [attachmentId, credentialId],
    );
    if (!rows[0]) throw PhaseTwoErrors.AttachmentNotFound();
    return { meta: rowToAttachmentMeta(rows[0]), bytes: this.box.openBytes(rows[0].blob_enc) };
  }

  async delete(userId: string, credentialId: string, attachmentId: string): Promise<void> {
    await this.assertOwned(userId, credentialId);
    const r = await this.pool.query(
      `DELETE FROM credential_attachments WHERE id = $1 AND credential_id = $2`,
      [attachmentId, credentialId],
    );
    if (r.rowCount === 0) throw PhaseTwoErrors.AttachmentNotFound();
  }
}
