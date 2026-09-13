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

// ---- F2: IPv6 / IPv4-mapped-IPv6 literal normalization (SSRF-IPV6-001..012) --
// URL.hostname keeps the brackets on an IPv6 literal ("[::1]"), which previously
// slipped past isIP() and was deferred to DNS (and Node skips the pinning lookup
// for literals). assertSafeUrl must classify bracketed literals as IPs and block
// loopback / IPv4-mapped-private / ULA / link-local / multicast.
test("SSRF-IPV6-001: http://[::1] blocked", () => {
  assert.throws(() => assertSafeUrl("http://[::1]/", true), SsrfError);
});
test("SSRF-IPV6-002: http://[::ffff:127.0.0.1] blocked", () => {
  assert.throws(() => assertSafeUrl("http://[::ffff:127.0.0.1]/", true), SsrfError);
  assert.throws(() => assertSafeUrl("http://[0:0:0:0:0:ffff:7f00:1]/", true), SsrfError); // uncompressed form
});
test("SSRF-IPV6-003: IPv4-mapped RFC1918 blocked", () => {
  for (const h of ["[::ffff:10.0.0.1]", "[::ffff:172.16.0.1]", "[::ffff:192.168.1.1]"]) {
    assert.throws(() => assertSafeUrl(`https://${h}/`, true), SsrfError, h);
  }
});
test("SSRF-IPV6-004: IPv4-mapped metadata IP blocked", () => {
  assert.throws(() => assertSafeUrl("https://[::ffff:169.254.169.254]/", true), SsrfError);
});
test("SSRF-IPV6-005: fc00::/7 (unique-local) blocked", () => {
  assert.throws(() => assertSafeUrl("https://[fc00::1]/", true), SsrfError);
  assert.throws(() => assertSafeUrl("https://[fd12:3456:789a::1]/", true), SsrfError);
});
test("SSRF-IPV6-006: fe80::/10 (link-local) blocked", () => {
  assert.throws(() => assertSafeUrl("https://[fe80::1]/", true), SsrfError);
});
test("SSRF-IPV6-007: ff00::/8 (multicast) + ::/128 blocked", () => {
  assert.throws(() => assertSafeUrl("https://[ff02::1]/", true), SsrfError);
  assert.throws(() => assertSafeUrl("https://[::]/", true), SsrfError);
});
test("SSRF-IPV6-011: a valid public IPv6 literal is allowed by validation", () => {
  assert.doesNotThrow(() => assertSafeUrl("https://[2606:4700:4700::1111]/", false));
});
test("SSRF-IPV6-012: normal public IPv4 behavior unchanged", () => {
  assert.doesNotThrow(() => assertSafeUrl("https://8.8.8.8/", false));
  assert.throws(() => assertSafeUrl("https://127.0.0.1/", false), SsrfError);
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
    if (req.url === "/redir-ipv6-mapped-meta") { res.writeHead(302, { location: "http://[::ffff:169.254.169.254]/latest/meta-data/" }); res.end(); return; }
    if (req.url === "/redir-ipv6-mapped-rfc1918") { res.writeHead(302, { location: "http://[::ffff:10.0.0.1]/" }); res.end(); return; }
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

test("SSRF-IPV6-009/010: redirect to an IPv6-form forbidden target is blocked", async () => {
  // Redirect revalidation runs assertSafeUrl on each hop; an IPv4-mapped-IPv6
  // metadata / RFC1918 Location (blocked regardless of allowLoopback) is rejected.
  await assert.rejects(() => safeFetch(`${base}/redir-ipv6-mapped-meta`, {}, dev), SsrfError);
  await assert.rejects(() => safeFetch(`${base}/redir-ipv6-mapped-rfc1918`, {}, dev), SsrfError);
});

test("SSRF-IPV6-008: a hostname resolving to a forbidden address fails closed (all-address check)", async () => {
  // "localhost" resolves to loopback (127.0.0.1 and/or ::1); with allowLoopback off
  // the pinned lookup must reject because a resolved address is forbidden. This is
  // the same "reject if ANY resolved address is unsafe" path that defeats a mixed
  // public+private DNS result.
  await assert.rejects(() => safeFetch("http://localhost/ok", {}, { allowHttp: true }), SsrfError);
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
