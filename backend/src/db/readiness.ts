/**
 * Readiness probe (AWM-STAB-001). `/readyz` must reflect whether the process
 * can actually serve traffic — i.e. PostgreSQL is reachable — not just that the
 * process is up (that is `/healthz`). A lightweight `SELECT 1` with a short
 * timeout keeps the probe cheap and non-blocking.
 */
import type { Pool } from "./index.js";

export async function probeDb(pool: Pool, timeoutMs = 2000): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    const ok = await Promise.race([
      pool.query("SELECT 1").then(() => true).catch(() => false),
      timeout,
    ]);
    return ok;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
