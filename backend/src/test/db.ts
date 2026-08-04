/**
 * Shared harness for integration tests (`*.itest.ts`), which run against a real
 * PostgreSQL. Point `DATABASE_URL` (or `TEST_DATABASE_URL`) at a migrated DB;
 * when neither is set the integration tests skip (via `dbSkip`) so the DB-free
 * unit suite (`*.test.ts`) is unaffected.
 */
import { Pool } from "pg";

export const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? "";

/** Pass as node:test's `skip` option; a string reason when no DB is configured. */
export const dbSkip: string | undefined = DATABASE_URL
  ? undefined
  : "set DATABASE_URL/TEST_DATABASE_URL to run integration tests";

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) pool = new Pool({ connectionString: DATABASE_URL });
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/** Insert a throwaway user (role must already exist in `roles`) and return its id. */
export async function seedUser(role = "user"): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO users (id, username, email, password_hash, role)
     VALUES (gen_random_uuid(), 'itest_' || substr(md5(random()::text),1,12),
             'itest_' || substr(md5(random()::text),1,12) || '@test.local', 'x', $1)
     RETURNING id`,
    [role],
  );
  return rows[0]!.id;
}

/** Delete a seeded user (cascades to its folders/hosts/vpn_profiles). */
export async function deleteUser(id: string): Promise<void> {
  await getPool().query(`DELETE FROM users WHERE id = $1`, [id]);
}
