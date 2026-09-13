/**
 * SEC-PROXY-001 — restricted trustProxy. Verifies ACTUAL req.ip resolution and
 * rate-limit bucketing (not just header parsing) for trusted vs untrusted peers.
 * The app mirrors server.ts: Fastify({ trustProxy }) + @fastify/rate-limit keyed
 * on req.ip. `inject({ remoteAddress })` sets the socket peer so we can model a
 * direct untrusted client vs the legitimate reverse proxy.
 *
 *   PROXY-TRUST-001 forged X-Forwarded-For (untrusted peer) cannot choose req.ip
 *   PROXY-TRUST-002 forged X-Real-IP cannot bypass rate limit
 *   PROXY-TRUST-003 forged Forwarded header cannot bypass rate limit
 *   PROXY-TRUST-004 trusted proxy preserves the real client IP
 *   PROXY-TRUST-005 two real clients behind the trusted proxy are distinguished
 *   PROXY-TRUST-006 an untrusted proxy hop is ignored
 *   PROXY-AUDIT-001 forged XFF does not poison the audited source IP
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";

// Trust ONLY loopback + a private proxy CIDR (the reverse-proxy path), exactly the
// shape of the production default ("loopback, uniquelocal"). A public peer is
// therefore untrusted and cannot inject X-Forwarded-* to select req.ip.
const TRUST = "127.0.0.1, 10.0.0.0/8";
const TRUSTED_PROXY = "10.0.0.5";      // stands in for Nginx
const UNTRUSTED = "203.0.113.9";       // a direct external client

async function makeApp(max = 2) {
  const app = Fastify({ trustProxy: TRUST });
  await app.register(rateLimit, { max, timeWindow: "1 minute", keyGenerator: (req) => req.ip });
  const audits: string[] = [];
  app.get("/ip", async (req) => ({ ip: req.ip }));
  app.get("/audit", async (req) => { audits.push(req.ip); return { ip: req.ip }; });
  (app as unknown as { audits: string[] }).audits = audits;
  return app;
}

test("PROXY-TRUST-001: forged X-Forwarded-For from an untrusted peer cannot choose req.ip", async () => {
  const app = await makeApp();
  const r = await app.inject({ method: "GET", url: "/ip", remoteAddress: UNTRUSTED, headers: { "x-forwarded-for": "1.2.3.4" } });
  assert.equal(r.json().ip, UNTRUSTED, "req.ip must be the real (untrusted) peer, not the spoofed XFF");
  await app.close();
});

test("PROXY-TRUST-002: forged X-Real-IP cannot bypass the rate limit", async () => {
  const app = await makeApp(1);
  const a = await app.inject({ method: "GET", url: "/ip", remoteAddress: UNTRUSTED, headers: { "x-real-ip": "9.9.9.1" } });
  const b = await app.inject({ method: "GET", url: "/ip", remoteAddress: UNTRUSTED, headers: { "x-real-ip": "9.9.9.2" } });
  assert.equal(a.statusCode, 200);
  assert.equal(b.statusCode, 429, "changing X-Real-IP must NOT mint a fresh bucket");
  await app.close();
});

test("PROXY-TRUST-003: forged Forwarded header cannot bypass the rate limit", async () => {
  const app = await makeApp(1);
  const a = await app.inject({ method: "GET", url: "/ip", remoteAddress: UNTRUSTED, headers: { forwarded: "for=5.5.5.1" } });
  const b = await app.inject({ method: "GET", url: "/ip", remoteAddress: UNTRUSTED, headers: { forwarded: "for=5.5.5.2" } });
  assert.equal(a.statusCode, 200);
  assert.equal(b.statusCode, 429, "changing Forwarded must NOT mint a fresh bucket");
  await app.close();
});

test("PROXY-TRUST-004: a trusted proxy preserves the real client IP", async () => {
  const app = await makeApp();
  const r = await app.inject({ method: "GET", url: "/ip", remoteAddress: TRUSTED_PROXY, headers: { "x-forwarded-for": "198.51.100.7" } });
  assert.equal(r.json().ip, "198.51.100.7", "behind the trusted proxy, req.ip is the forwarded real client");
  await app.close();
});

test("PROXY-TRUST-005: two real clients behind the trusted proxy are distinguished", async () => {
  const app = await makeApp(1);
  const a = await app.inject({ method: "GET", url: "/ip", remoteAddress: TRUSTED_PROXY, headers: { "x-forwarded-for": "198.51.100.10" } });
  const b = await app.inject({ method: "GET", url: "/ip", remoteAddress: TRUSTED_PROXY, headers: { "x-forwarded-for": "198.51.100.11" } });
  assert.equal(a.json().ip, "198.51.100.10");
  assert.equal(b.json().ip, "198.51.100.11");
  assert.equal(a.statusCode, 200);
  assert.equal(b.statusCode, 200, "distinct real clients get distinct rate-limit buckets");
  await app.close();
});

test("PROXY-TRUST-006: an untrusted proxy hop is ignored (req.ip = the untrusted peer)", async () => {
  const app = await makeApp();
  // Chain claims two hops, but the peer itself is untrusted → the whole XFF is discarded.
  const r = await app.inject({ method: "GET", url: "/ip", remoteAddress: UNTRUSTED, headers: { "x-forwarded-for": "1.1.1.1, 2.2.2.2" } });
  assert.equal(r.json().ip, UNTRUSTED);
  await app.close();
});

test("PROXY-AUDIT-001: forged X-Forwarded-For does not poison the audited source IP", async () => {
  const app = await makeApp();
  await app.inject({ method: "GET", url: "/audit", remoteAddress: UNTRUSTED, headers: { "x-forwarded-for": "6.6.6.6" } });
  const audits = (app as unknown as { audits: string[] }).audits;
  assert.deepEqual(audits, [UNTRUSTED], "audit must record the trusted resolved IP, not the spoofed header");
  await app.close();
});
