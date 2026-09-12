/**
 * SEC-SSRF-001 — SSRF-safe outbound client tests. AI-SSRF-001..015.
 * Unit tests for IP/URL validation; functional tests (redirect/size/timeout/
 * public) against a loopback server via the explicit allowLoopback dev option.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { isBlockedIp, assertSafeUrl, safeFetch, SsrfError } from "./safeFetch.js";

// ---- IP validation (AI-SSRF-001..008, 013) --------------------------------
test("AI-SSRF-001: 127.0.0.1 rejected", () => { assert.equal(isBlockedIp("127.0.0.1"), true); });
test("AI-SSRF-002: ::1 rejected", () => { assert.equal(isBlockedIp("::1"), true); });
test("AI-SSRF-003: 10/8 rejected", () => { assert.equal(isBlockedIp("10.1.2.3"), true); });
test("AI-SSRF-004: 172.16/12 rejected", () => {
  assert.equal(isBlockedIp("172.16.0.1"), true);
  assert.equal(isBlockedIp("172.31.255.255"), true);
  assert.equal(isBlockedIp("172.15.0.1"), false); // just outside the range → public
});
test("AI-SSRF-005: 192.168/16 rejected", () => { assert.equal(isBlockedIp("192.168.1.1"), true); });
test("AI-SSRF-006: 169.254/16 rejected", () => { assert.equal(isBlockedIp("169.254.1.1"), true); });
test("AI-SSRF-007: cloud metadata 169.254.169.254 rejected", () => { assert.equal(isBlockedIp("169.254.169.254"), true); });
test("AI-SSRF-008: IPv4-mapped IPv6 rejected", () => {
  assert.equal(isBlockedIp("::ffff:127.0.0.1"), true);
  assert.equal(isBlockedIp("::ffff:169.254.169.254"), true);
  assert.equal(isBlockedIp("::ffff:10.0.0.1"), true);
});
test("AI-SSRF extra: public IPs allowed", () => {
  assert.equal(isBlockedIp("1.1.1.1"), false);
  assert.equal(isBlockedIp("8.8.8.8"), false);
  assert.equal(isBlockedIp("2606:4700:4700::1111"), false);
});
test("AI-SSRF-013: non-HTTP protocols rejected", () => {
  for (const u of ["file:///etc/passwd", "ftp://x/y", "gopher://x", "data:text/html,x", "unix:/tmp/s"]) {
    assert.throws(() => assertSafeUrl(u, false), SsrfError, u);
  }
  assert.throws(() => assertSafeUrl("http://api.x.com", false), SsrfError); // http blocked by default
  assert.throws(() => assertSafeUrl("https://user:pass@api.x.com", false), SsrfError); // creds
  assert.doesNotThrow(() => assertSafeUrl("https://api.openai.com/v1", false)); // public https ok (validation)
  assert.throws(() => assertSafeUrl("https://127.0.0.1/x", false), SsrfError); // literal loopback host
});

// ---- Functional tests against a loopback server ---------------------------
let server: http.Server;
let base = "";
let hits = 0;
before(async () => {
  server = http.createServer((req, res) => {
    hits++;
    if (req.url === "/ok") { res.writeHead(200, { "content-type": "application/json" }); res.end('{"v":1}'); return; }
    if (req.url === "/redir-private") { res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" }); res.end(); return; }
    if (req.url === "/redir-ok") { res.writeHead(302, { location: `${base}/ok` }); res.end(); return; }
    if (req.url === "/big") { res.writeHead(200); res.end(Buffer.alloc(2 * 1024 * 1024, 0x41)); return; } // 2 MiB
    if (req.url === "/slow") { setTimeout(() => { res.writeHead(200); res.end("late"); }, 2000); return; }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => new Promise<void>((r) => server.close(() => r())));

const dev = { allowHttp: true, allowLoopback: true };

test("AI-SSRF-012: a reachable endpoint works (loopback stands in for public)", async () => {
  const res = await safeFetch(`${base}/ok`, {}, dev);
  assert.equal(res.status, 200);
  assert.deepEqual(res.json(), { v: 1 });
});

test("AI-SSRF-009/011: redirect/rebinding to a private/metadata target is rejected", async () => {
  await assert.rejects(() => safeFetch(`${base}/redir-private`, {}, dev), SsrfError);
});

test("AI-SSRF-010: multi-hop redirect cap enforced", async () => {
  // /redir-ok → /ok is a single hop and should succeed with maxRedirects>=1
  const ok = await safeFetch(`${base}/redir-ok`, {}, { ...dev, maxRedirects: 1 });
  assert.equal(ok.status, 200);
  // with 0 redirects allowed, the same URL must fail
  await assert.rejects(() => safeFetch(`${base}/redir-ok`, {}, { ...dev, maxRedirects: 0 }), /too many redirects/);
});

test("AI-SSRF-014: response-size limit enforced", async () => {
  await assert.rejects(() => safeFetch(`${base}/big`, {}, { ...dev, maxResponseBytes: 64 * 1024 }), /maximum size/);
});

test("AI-SSRF-015: request timeout enforced", async () => {
  await assert.rejects(() => safeFetch(`${base}/slow`, {}, { ...dev, requestTimeoutMs: 300 }), /timed out/);
});

test("AI-SSRF: loopback blocked when allowLoopback is off (default)", async () => {
  await assert.rejects(() => safeFetch(`${base}/ok`, {}, { allowHttp: true }), SsrfError);
});
