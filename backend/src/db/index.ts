import pg from "pg";
import type { Config } from "../config/index.js";
import type { Logger } from "../logger/index.js";

const { Pool } = pg;
export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

export async function createPool(cfg: Config, log: Logger): Promise<Pool> {
  const pool = new Pool({
    connectionString: cfg.env.DATABASE_URL,
    max: cfg.env.DATABASE_MAX_CONNS,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });

  pool.on("error", (err) => {
    log.error({ err }, "pg pool error (idle client)");
  });

  // Smoke test the connection so failures surface fast at boot.
  const client = await pool.connect();
  try {
    await client.query("SELECT 1");
    log.info("database pool ready");
  } finally {
    client.release();
  }
  return pool;
}
