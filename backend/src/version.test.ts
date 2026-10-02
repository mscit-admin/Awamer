/**
 * GO-LIVE traceability — the release identity exposed by /api/v1/version is the
 * package.json version plus a sanitized commit/build date; nothing else
 * (paths, env, secrets) can be smuggled through the build-time values.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { RELEASE, sanitizeRelease } from "./version.js";

test("VERSION-001: RELEASE.version is the backend package.json version", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(RELEASE.version, pkg.version);
});

test("VERSION-002: valid commit / build date pass through", () => {
  const r = sanitizeRelease({ version: "1.8.0", commit: "8D015BC0aa", buildDate: "2026-10-02T10:00:00Z" });
  assert.deepEqual(r, { version: "1.8.0", commit: "8d015bc0aa", buildDate: "2026-10-02T10:00:00Z" });
});

test("VERSION-003: anything else collapses to 'unknown' (no paths/env/secrets leak)", () => {
  const r = sanitizeRelease({ version: "1.8.0; rm -rf /", commit: "/home/build/.git", buildDate: "DATABASE_URL=postgres://u:p@h/db" });
  assert.deepEqual(r, { version: "unknown", commit: "unknown", buildDate: "unknown" });
  assert.deepEqual(sanitizeRelease({}), { version: "unknown", commit: "unknown", buildDate: "unknown" });
});
