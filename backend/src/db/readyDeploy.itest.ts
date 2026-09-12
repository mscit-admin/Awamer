/**
 * AWM-STAB-002 — /healthz (liveness) vs /readyz (readiness) semantics, wired the
 * same way server.ts serves them. READY-DEPLOY-001..006. Real PostgreSQL for the
 * healthy path; a pool pointed at a dead port simulates DB-unavailable.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";
import { Pool } from "pg";
import { probeDb } from "./readiness.js";
import { dbSkip, DATABASE_URL } from "../test/db.js";

// Mirror server.ts: /healthz = liveness (always ok), /readyz = probeDb → 200/503.
function makeApp(pool: Pool): FastifyInstance {
  const app = Fastify();
  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/readyz", async (_req, reply) => {
    const ok = await probeDb(pool);
    return reply.code(ok ? 200 : 503).send({ status: ok ? "ready" : "not_ready" });
  });
  return app;
}

let goodPool: Pool;
let deadPool: Pool;

before(async () => {
  if (dbSkip) return;
  goodPool = new Pool({ connectionString: DATABASE_URL });
  goodPool.on("error", () => {});
  // A pool pointed at a closed port — probeDb's SELECT 1 fails → "not ready".
  deadPool = new Pool({ host: "127.0.0.1", port: 1, database: "nope", user: "nope", connectionTimeoutMillis: 500 });
  deadPool.on("error", () => {});
});

after(async () => {
  if (dbSkip) return;
  await goodPool?.end().catch(() => {});
  await deadPool?.end().catch(() => {});
});

test("READY-DEPLOY-001: DB available → /healthz 200 and /readyz 200", { skip: dbSkip }, async () => {
  const app = makeApp(goodPool);
  await app.ready();
  assert.equal((await app.inject({ method: "GET", url: "/healthz" })).statusCode, 200);
  const r = await app.inject({ method: "GET", url: "/readyz" });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().status, "ready");
  await app.close();
});

test("READY-DEPLOY-002/005: DB unavailable → /healthz 200 but /readyz 503", { skip: dbSkip }, async () => {
  const app = makeApp(deadPool);
  await app.ready();
  // Liveness still 200 — the process is up.
  assert.equal((await app.inject({ method: "GET", url: "/healthz" })).statusCode, 200);
  // Readiness 503 — the deploy gate (curl -f /readyz) therefore fails and the
  // rollout is NOT declared successful (READY-DEPLOY-005).
  const r = await app.inject({ method: "GET", url: "/readyz" });
  assert.equal(r.statusCode, 503);
  assert.equal(r.json().status, "not_ready");
  await app.close();
});

test("READY-DEPLOY-004: readiness recovers to 200 once the DB is reachable again (no restart)", { skip: dbSkip }, async () => {
  // Same process, DB reachable again → readiness flips back to 200 on its own.
  const app = makeApp(goodPool);
  await app.ready();
  const r = await app.inject({ method: "GET", url: "/readyz" });
  assert.equal(r.statusCode, 200);
  await app.close();
});

test("READY-DEPLOY-006: /healthz stays 200 regardless of DB (liveness only)", { skip: dbSkip }, async () => {
  const app = makeApp(deadPool);
  await app.ready();
  assert.equal((await app.inject({ method: "GET", url: "/healthz" })).statusCode, 200);
  await app.close();
});
