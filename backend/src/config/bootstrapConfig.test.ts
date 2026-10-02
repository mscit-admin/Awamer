/**
 * AWM-CFG-001 — production must never bootstrap a Super Admin with a missing,
 * default or placeholder password. CFG-BOOT-001..006. Pure unit test over
 * loadConfig / assertProductionBootstrapPassword (no DB).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, assertProductionBootstrapPassword, DEV_BOOTSTRAP_PASSWORD } from "./index.js";

const PROD_BASE: Record<string, string> = {
  APP_ENV: "production",
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
  JWT_ACCESS_SECRET: "prod_access_secret_aaaaaaaaaaaaaaaaaaaaaaaa",
  JWT_REFRESH_SECRET: "prod_refresh_secret_bbbbbbbbbbbbbbbbbbbbbbbb",
  LOG_LEVEL: "error",
  // GO-LIVE hardening also requires a production CORS list and helper secret.
  CORS_ALLOWED_ORIGINS: "https://awamer.example.com,tauri://localhost,https://tauri.localhost",
  VPN_HELPER_SECRET: "h".repeat(64),
};

/** Run loadConfig with a controlled process.env, restoring it afterward. */
function withEnv(env: Record<string, string | undefined>, fn: () => void) {
  const saved = process.env;
  process.env = { ...env } as NodeJS.ProcessEnv;
  try { fn(); } finally { process.env = saved; }
}

test("CFG-BOOT-001: production + missing BOOTSTRAP_ADMIN_PASSWORD → startup fails", () => {
  // Missing => the schema default (dev password) applies, which production rejects.
  withEnv({ ...PROD_BASE }, () => {
    assert.throws(() => loadConfig(), /BOOTSTRAP_ADMIN_PASSWORD/);
  });
});

test("CFG-BOOT-002: production + default password → startup fails", () => {
  withEnv({ ...PROD_BASE, BOOTSTRAP_ADMIN_PASSWORD: DEV_BOOTSTRAP_PASSWORD }, () => {
    assert.throws(() => loadConfig(), /BOOTSTRAP_ADMIN_PASSWORD/);
  });
});

test("CFG-BOOT-003: production + known placeholder → startup fails", () => {
  for (const pw of ["CHANGE_ME_IN_PRODUCTION", "changeme", "password", "admin123", "CHANGE_ME", "default"]) {
    withEnv({ ...PROD_BASE, BOOTSTRAP_ADMIN_PASSWORD: pw }, () => {
      assert.throws(() => loadConfig(), /BOOTSTRAP_ADMIN_PASSWORD/, `placeholder "${pw}" must be rejected`);
    });
  }
});

test("CFG-BOOT-003b: production + too-short secret (<16) → startup fails", () => {
  withEnv({ ...PROD_BASE, BOOTSTRAP_ADMIN_PASSWORD: "Sh0rt!Pass" }, () => {
    assert.throws(() => loadConfig(), /at least 16 characters/);
  });
});

test("CFG-BOOT-004: production + strong explicit secret → PASS", () => {
  withEnv({ ...PROD_BASE, BOOTSTRAP_ADMIN_PASSWORD: "Zx9$kP2wQ7!mNv4tRb8Lc3Yf" }, () => {
    const cfg = loadConfig();
    assert.equal(cfg.isProd, true);
    assert.equal(cfg.env.BOOTSTRAP_ADMIN_PASSWORD, "Zx9$kP2wQ7!mNv4tRb8Lc3Yf");
  });
});

test("CFG-BOOT-005: development mode permits the convenience default (documented)", () => {
  withEnv({
    APP_ENV: "development", LOG_LEVEL: "error",
    DATABASE_URL: "postgres://u:p@localhost:5432/db",
    JWT_ACCESS_SECRET: "dev_access_secret_aaaaaaaaaaaaaaaaaaaaaaaa",
    JWT_REFRESH_SECRET: "dev_refresh_secret_bbbbbbbbbbbbbbbbbbbbbbbb",
  }, () => {
    const cfg = loadConfig(); // no BOOTSTRAP_ADMIN_PASSWORD → default, allowed in dev
    assert.equal(cfg.isDev, true);
    assert.equal(cfg.env.BOOTSTRAP_ADMIN_PASSWORD, DEV_BOOTSTRAP_PASSWORD);
  });
});

test("CFG-BOOT-006: rejection message never contains the password itself", () => {
  const secret = "ChangeMe!2026"; // a rejected value
  try {
    assertProductionBootstrapPassword(secret);
    assert.fail("expected a throw");
  } catch (e) {
    const msg = (e as Error).message;
    assert.doesNotMatch(msg, /ChangeMe!2026/, "the password must not leak into the error message");
  }
  // A strong secret passes without throwing.
  assert.doesNotThrow(() => assertProductionBootstrapPassword("Zx9$kP2wQ7!mNv4tRb8Lc3Yf"));
});
