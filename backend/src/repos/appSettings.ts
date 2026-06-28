import type { Pool } from "../db/index.js";

/** Key/value store for instance-wide settings (branding, etc.). */
export class AppSettingsRepository {
  constructor(private readonly pool: Pool) {}

  async getMany(keys: string[]): Promise<Record<string, string | null>> {
    if (keys.length === 0) return {};
    const { rows } = await this.pool.query<{ key: string; value: string | null }>(
      `SELECT key, value FROM app_settings WHERE key = ANY($1::text[])`,
      [keys],
    );
    const out: Record<string, string | null> = {};
    for (const k of keys) out[k] = null;
    for (const r of rows) out[r.key] = r.value;
    return out;
  }

  async set(key: string, value: string | null): Promise<void> {
    await this.pool.query(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [key, value],
    );
  }
}
