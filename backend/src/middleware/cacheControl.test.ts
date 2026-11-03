/** SEC-CACHE-001 — CACHE-001..003. */
import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { registerNoStoreHeaders } from "./cacheControl.js";

async function mkApp() {
  const app = Fastify();
  registerNoStoreHeaders(app);
  app.get("/secret", async () => ({ password: "s3cret" }));
  app.get("/fail", async (_req, reply) => reply.code(401).send({ error: { code: "invalid_token" } }));
  app.get("/cached", async (_req, reply) => reply.header("Cache-Control", "public, max-age=60").send("logo"));
  await app.ready();
  return app;
}

test("CACHE-001: a JSON API response is marked no-store", async () => {
  const app = await mkApp();
  const res = await app.inject({ method: "GET", url: "/secret" });
  assert.equal(res.headers["cache-control"], "no-store");
  assert.equal(res.headers["pragma"], "no-cache");
});

test("CACHE-002: error responses are marked no-store too", async () => {
  const app = await mkApp();
  assert.equal((await app.inject({ method: "GET", url: "/fail" })).headers["cache-control"], "no-store");
  assert.equal((await app.inject({ method: "GET", url: "/missing" })).headers["cache-control"], "no-store");
});

test("CACHE-003: a route that sets its own Cache-Control keeps it", async () => {
  const app = await mkApp();
  assert.equal((await app.inject({ method: "GET", url: "/cached" })).headers["cache-control"], "public, max-age=60");
});
