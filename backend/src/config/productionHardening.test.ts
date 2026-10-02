/**
 * GO-LIVE production configuration gate (no DB): API docs, CORS and the VPN
 * helper secret fail closed in production; development is unaffected.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, assertProductionHardening } from "./index.js";

const PROD: Record<string, string> = {
  APP_ENV: "production",
  DATABASE_URL: "postgres://awamer_app:x@postgres:5432/netsphere",
  JWT_ACCESS_SECRET: "prod_access_secret_aaaaaaaaaaaaaaaaaaaaaaaa",
  JWT_REFRESH_SECRET: "prod_refresh_secret_bbbbbbbbbbbbbbbbbbbbbbbb",
  BOOTSTRAP_ADMIN_PASSWORD: "Zx9$kP2wQ7!mNv4tRb8Lc3Yf",
  CORS_ALLOWED_ORIGINS: "https://awamer.example.com,tauri://localhost,https://tauri.localhost,http://tauri.localhost",
  VPN_HELPER_SECRET: "h".repeat(64),
  LOG_LEVEL: "error",
};
function load(env: Record<string, string | undefined>) {
  const saved = process.env;
  process.env = { ...env } as NodeJS.ProcessEnv;
  try { return loadConfig(); } finally { process.env = saved; }
}

test("PROD-CFG-001: a hardened production config loads", () => {
  assert.doesNotThrow(() => load(PROD));
});

test("PROD-CFG-002: API docs are refused in production (allowed in development)", () => {
  assert.throws(() => load({ ...PROD, ENABLE_API_DOCS: "true" }), /ENABLE_API_DOCS/);
  assert.equal(load({ ...PROD, APP_ENV: "development", ENABLE_API_DOCS: "true" }).env.ENABLE_API_DOCS, true);
});

test("PROD-CFG-003: wildcard / null / plain-http CORS origins are refused in production", () => {
  for (const bad of ["*", "null", "https://*.example.com", "http://awamer.example.com", "http://localhost:1420", "file://x"]) {
    assert.throws(() => assertProductionHardening({ CORS_ALLOWED_ORIGINS: `https://ok.example.com,${bad}`, VPN_HELPER_SECRET: "h".repeat(64) }), /CORS_ALLOWED_ORIGINS/, bad);
  }
  assert.throws(() => load({ ...PROD, CORS_ALLOWED_ORIGINS: undefined }), /CORS_ALLOWED_ORIGINS/); // dev default has http://localhost:1420
});

test("PROD-CFG-004: the VPN helper secret is mandatory and long in production", () => {
  assert.throws(() => load({ ...PROD, VPN_HELPER_SECRET: undefined }), /VPN_HELPER_SECRET/);
  assert.throws(() => load({ ...PROD, VPN_HELPER_SECRET: "short" }), /VPN_HELPER_SECRET/);
});

test("PROD-CFG-005: development keeps its convenient defaults", () => {
  const dev = { ...PROD, APP_ENV: "development", CORS_ALLOWED_ORIGINS: undefined, VPN_HELPER_SECRET: undefined };
  assert.doesNotThrow(() => load(dev));
});
