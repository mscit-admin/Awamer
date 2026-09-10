/**
 * SEC / Phase 3 — host-key pin store against a real PostgreSQL.
 * Skips when no DATABASE_URL is configured (see src/test/db.ts).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { getPool, closePool, dbSkip } from "../test/db.js";
import { HostKeyRepository } from "./hostKeys.js";

after(async () => { if (!dbSkip) await closePool(); });

test("verify: new → match → mismatch, and re-pin after delete", { skip: dbSkip }, async () => {
  const pool = getPool();
  const repo = new HostKeyRepository(pool);
  const host = "pin-test-" + Date.now();
  try {
    assert.equal(await repo.verify(host, 22, "SHA256:AAA", "ssh-ed25519"), "new", "first sighting pins (TOFU)");
    assert.equal(await repo.verify(host, 22, "SHA256:AAA"), "match", "same key matches");
    assert.equal(await repo.verify(host, 22, "SHA256:BBB"), "mismatch", "changed key is a mismatch");
    // Different port is a separate pin.
    assert.equal(await repo.verify(host, 2222, "SHA256:CCC"), "new");
    // Re-pin workflow: delete the row, next sighting pins fresh.
    await pool.query(`DELETE FROM host_keys WHERE hostname = $1`, [host]);
    assert.equal(await repo.verify(host, 22, "SHA256:BBB"), "new", "re-pins after delete");
  } finally {
    await pool.query(`DELETE FROM host_keys WHERE hostname = $1`, [host]);
  }
});
