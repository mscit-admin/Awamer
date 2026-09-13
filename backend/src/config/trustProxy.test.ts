/**
 * SEC-PROXY-001 — TRUST_PROXY config: secure default + fail-closed validation.
 *   PROXY-CONFIG-001 default is loopback only
 *   PROXY-CONFIG-002 an explicit trusted proxy CIDR is accepted
 *   PROXY-CONFIG-003 invalid/broad config fails closed (loadConfig throws)
 *   PROXY-CONFIG-004 broad dangerous trust values are rejected
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, isDangerousTrustProxy } from "./index.js";

const BASE_ENV: Record<string, string> = {
  APP_ENV: "development",
  DATABASE_URL: "postgres://u@127.0.0.1:5432/d",
  JWT_ACCESS_SECRET: "a".repeat(64),
  JWT_REFRESH_SECRET: "b".repeat(64),
};

/** Run loadConfig() with a controlled process.env, then restore it. */
function withEnv<T>(over: Record<string, string | undefined>, fn: () => T): T {
  const saved = process.env;
  process.env = { ...BASE_ENV, ...over } as NodeJS.ProcessEnv;
  try { return fn(); } finally { process.env = saved; }
}

test("PROXY-CONFIG-001: default TRUST_PROXY is loopback only", () => {
  const cfg = withEnv({ TRUST_PROXY: undefined }, () => loadConfig());
  assert.equal(cfg.trustProxy, "loopback");
});

test("PROXY-CONFIG-002: an explicit trusted proxy CIDR is accepted", () => {
  const cfg = withEnv({ TRUST_PROXY: "loopback,172.20.0.5/32" }, () => loadConfig());
  assert.equal(cfg.trustProxy, "loopback,172.20.0.5/32");
});

test("PROXY-CONFIG-003: invalid config fails closed (loadConfig throws, no silent broad trust)", () => {
  assert.throws(() => withEnv({ TRUST_PROXY: "true" }, () => loadConfig()));
  assert.throws(() => withEnv({ TRUST_PROXY: "" }, () => loadConfig()));
});

test("PROXY-CONFIG-004: broad dangerous trust values are rejected", () => {
  for (const bad of ["true", "false", "*", "0.0.0.0/0", "::/0", "loopback, 0.0.0.0/0", "  ::/0 "]) {
    assert.equal(isDangerousTrustProxy(bad), true, bad);
    assert.throws(() => withEnv({ TRUST_PROXY: bad }, () => loadConfig()), bad);
  }
  // Safe values are not flagged.
  for (const ok of ["loopback", "loopback,172.20.0.5/32", "127.0.0.1", "10.0.0.5/32"]) {
    assert.equal(isDangerousTrustProxy(ok), false, ok);
  }
});
