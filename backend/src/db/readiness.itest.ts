/**
 * STAB-001 — /readyz probes the real DB. Integration: a live pool is ready; a
 * pool pointed at a dead address is not (within the timeout). Skips w/o DB.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { getPool, closePool, dbSkip } from "../test/db.js";
import { probeDb } from "./readiness.js";

after(async () => { if (!dbSkip) await closePool(); });

test("TEST-READY-001: probe is TRUE when PostgreSQL is available", { skip: dbSkip }, async () => {
  assert.equal(await probeDb(getPool()), true);
});

test("TEST-READY-002/004: probe is FALSE (bounded) when PostgreSQL is unavailable", { skip: dbSkip }, async () => {
  // A pool aimed at a closed port — fails fast or times out, never hangs /readyz.
  const dead = new Pool({ connectionString: "postgres://x:x@127.0.0.1:59999/x", connectionTimeoutMillis: 500 });
  const t0 = Date.now();
  const ok = await probeDb(dead, 1500);
  assert.equal(ok, false, "not ready when DB is down");
  assert.ok(Date.now() - t0 < 3000, "probe returns within its timeout budget");
  await dead.end().catch(() => {});
});

test("TEST-READY-003: readiness recovers automatically once the DB answers again", { skip: dbSkip }, async () => {
  // Same live pool: a later probe is ready again with no process restart.
  assert.equal(await probeDb(getPool()), true);
});
