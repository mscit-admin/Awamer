/**
 * AI provider subscriptions (org- and user-scoped). API keys are encrypted at
 * rest via SecretBox and never leave the server.
 */
import { v4 as uuid } from "uuid";
import type { Pool } from "../db/index.js";
import type { SecretBox } from "../crypto/secretBox.js";

export type AiProviderKind = "anthropic" | "openai" | "google" | "azure" | "custom";
export type AiScope = "org" | "user";

export interface AiProvider {
  id: string;
  scope: AiScope;
  companyId: string | null;
  userId: string | null;
  provider: AiProviderKind;
  label: string;
  model: string;
  baseUrl: string | null;
  isDefault: boolean;
  isActive: boolean;
  hasKey: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface Row {
  id: string; scope: AiScope; company_id: string | null; user_id: string | null;
  provider: AiProviderKind; label: string; model: string; base_url: string | null;
  secret_enc: unknown; is_default: boolean; is_active: boolean;
  created_at: Date; updated_at: Date;
}

const PUBLIC = `id, scope, company_id, user_id, provider, label, model, base_url,
  is_default, is_active, created_at, updated_at,
  (secret_enc IS NOT NULL AND secret_enc <> '{}'::jsonb) AS has_key`;

function toProvider(r: Row & { has_key?: boolean }): AiProvider {
  return {
    id: r.id, scope: r.scope, companyId: r.company_id, userId: r.user_id,
    provider: r.provider, label: r.label, model: r.model, baseUrl: r.base_url,
    isDefault: r.is_default, isActive: r.is_active, hasKey: Boolean(r.has_key),
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export class AiProviderRepository {
  constructor(private readonly pool: Pool, private readonly box: SecretBox) {}

  /** Providers usable by a user: their company's org providers + (optionally) their own personal ones. */
  async available(companyId: string | null, userId: string, includePersonal: boolean): Promise<AiProvider[]> {
    const { rows } = await this.pool.query<Row & { has_key: boolean }>(
      `SELECT ${PUBLIC} FROM ai_providers
        WHERE is_active = TRUE
          AND ( (scope='org' AND company_id = $1)
             OR ($2::boolean AND scope='user' AND user_id = $3) )
        ORDER BY is_default DESC, scope, label`,
      [companyId, includePersonal, userId],
    );
    return rows.map(toProvider);
  }

  /** Org providers for a company (management view). */
  async listOrg(companyId: string): Promise<AiProvider[]> {
    const { rows } = await this.pool.query<Row & { has_key: boolean }>(
      `SELECT ${PUBLIC} FROM ai_providers WHERE scope='org' AND company_id=$1 ORDER BY is_default DESC, label`, [companyId]);
    return rows.map(toProvider);
  }

  /** A user's personal providers. */
  async listPersonal(userId: string): Promise<AiProvider[]> {
    const { rows } = await this.pool.query<Row & { has_key: boolean }>(
      `SELECT ${PUBLIC} FROM ai_providers WHERE scope='user' AND user_id=$1 ORDER BY is_default DESC, label`, [userId]);
    return rows.map(toProvider);
  }

  async getById(id: string): Promise<AiProvider | null> {
    const { rows } = await this.pool.query<Row & { has_key: boolean }>(`SELECT ${PUBLIC} FROM ai_providers WHERE id=$1`, [id]);
    return rows[0] ? toProvider(rows[0]) : null;
  }

  /** Decrypt and return the API key for a provider (server-side only). */
  async getApiKey(id: string): Promise<string | null> {
    const { rows } = await this.pool.query<{ secret_enc: unknown }>(`SELECT secret_enc FROM ai_providers WHERE id=$1`, [id]);
    if (!rows[0]) return null;
    const opened = this.box.open(rows[0].secret_enc ?? {}) as { apiKey?: string };
    return opened.apiKey ?? null;
  }

  async create(input: {
    scope: AiScope; companyId: string | null; userId: string | null;
    provider: AiProviderKind; label: string; model: string; baseUrl: string | null;
    apiKey: string; isDefault: boolean;
  }): Promise<AiProvider> {
    const id = uuid();
    if (input.isDefault) await this.clearDefault(input.scope, input.companyId, input.userId);
    const sealed = JSON.stringify(this.box.seal({ apiKey: input.apiKey }));
    const { rows } = await this.pool.query<Row & { has_key: boolean }>(
      `INSERT INTO ai_providers (id, scope, company_id, user_id, provider, label, model, base_url, secret_enc, is_default)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10) RETURNING ${PUBLIC}`,
      [id, input.scope, input.companyId, input.userId, input.provider, input.label, input.model, input.baseUrl, sealed, input.isDefault],
    );
    return toProvider(rows[0]!);
  }

  async update(id: string, patch: { label?: string; model?: string; baseUrl?: string | null; apiKey?: string; isActive?: boolean; isDefault?: boolean }): Promise<AiProvider | null> {
    const current = await this.getById(id);
    if (!current) return null;
    if (patch.isDefault) await this.clearDefault(current.scope, current.companyId, current.userId);
    const sealed = patch.apiKey !== undefined ? JSON.stringify(this.box.seal({ apiKey: patch.apiKey })) : null;
    const { rows } = await this.pool.query<Row & { has_key: boolean }>(
      `UPDATE ai_providers SET
         label = COALESCE($2, label),
         model = COALESCE($3, model),
         base_url = CASE WHEN $4::boolean THEN $5 ELSE base_url END,
         secret_enc = CASE WHEN $6::boolean THEN $7::jsonb ELSE secret_enc END,
         is_active = COALESCE($8, is_active),
         is_default = COALESCE($9, is_default),
         updated_at = NOW()
       WHERE id=$1 RETURNING ${PUBLIC}`,
      [id, patch.label ?? null, patch.model ?? null, patch.baseUrl !== undefined, patch.baseUrl ?? null,
       sealed !== null, sealed, patch.isActive ?? null, patch.isDefault ?? null],
    );
    return rows[0] ? toProvider(rows[0]) : null;
  }

  async delete(id: string): Promise<void> {
    await this.pool.query(`DELETE FROM ai_providers WHERE id=$1`, [id]);
  }

  private async clearDefault(scope: AiScope, companyId: string | null, userId: string | null): Promise<void> {
    if (scope === "org") await this.pool.query(`UPDATE ai_providers SET is_default=FALSE WHERE scope='org' AND company_id=$1`, [companyId]);
    else await this.pool.query(`UPDATE ai_providers SET is_default=FALSE WHERE scope='user' AND user_id=$1`, [userId]);
  }
}
