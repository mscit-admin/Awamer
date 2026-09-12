/**
 * SEC-RESET-001 — password reset link host/origin poisoning tests.
 * RESET-HOST-001..008. Pure unit tests (no DB); a fake mailer captures the link.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { PasswordResetUseCase } from "./passwordReset.js";
import { makePasswordResetRoutes } from "../routes/passwordReset.js";
import {
  isSafePublicBaseUrl,
  resolveTrustedBaseUrl,
  assertResetEmailBaseUrl,
} from "./publicBaseUrl.js";

const noopLog = { info() {}, warn() {}, error() {}, debug() {} } as any;

function makeUC(cfg: { isProd: boolean; publicBaseUrl: string | null }, dbBaseUrl = "") {
  const captured: { link?: string; sent: boolean } = { sent: false };
  const users = { findByEmail: async () => ({ id: "u1", email: "a@b.com", isActive: true }) } as any;
  const resets = { invalidateForUser: async () => {}, create: async () => {} } as any;
  const refresh = { revokeAllForUser: async () => {} } as any;
  const mailer = {
    baseUrl: async () => dbBaseUrl,
    resetTtlMinutes: async () => 30,
    isConfigured: async () => true,
    sendPasswordReset: async (_to: string, link: string) => { captured.link = link; captured.sent = true; },
  } as any;
  const argon2 = { hash: async () => "h" } as any;
  const audit = { log: async () => {} } as any;
  const uc = new PasswordResetUseCase(users, resets, refresh, mailer, argon2, audit, noopLog, cfg);
  return { uc, captured };
}

test("RESET-HOST-001: trusted configured base URL is used", async () => {
  const { uc, captured } = makeUC({ isProd: true, publicBaseUrl: "https://awamer.example.com" });
  await uc.requestReset("a@b.com");
  assert.ok(captured.link!.startsWith("https://awamer.example.com/?reset_token="));
});

test("RESET-HOST-002..005: reset route never passes request headers to the usecase", async () => {
  // The usecase signature takes ONLY the email — headers cannot influence it.
  let calledWith: unknown[] = [];
  const spyUC = { requestReset: async (...args: unknown[]) => { calledWith = args; } } as any;
  const app = Fastify();
  await app.register(makePasswordResetRoutes({ reset: spyUC }), { prefix: "/api/v1/auth" });
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/forgot-password",
    headers: {
      origin: "https://evil.example.com",
      referer: "https://evil.example.com/x",
      host: "evil.example.com",
      "x-forwarded-host": "evil.example.com",
      "x-forwarded-proto": "http",
    },
    payload: { email: "a@b.com" },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calledWith, ["a@b.com"]); // only the email; no origin/host
  await app.close();
});

test("RESET-HOST-006: missing production public URL + email enabled fails (startup assertion)", () => {
  assert.throws(() => assertResetEmailBaseUrl({ isProd: true, emailEnabled: true, trustedBase: null }));
  // does NOT throw when a trusted base exists, or when email is disabled, or in dev
  assert.doesNotThrow(() => assertResetEmailBaseUrl({ isProd: true, emailEnabled: true, trustedBase: "https://x.example.com" }));
  assert.doesNotThrow(() => assertResetEmailBaseUrl({ isProd: true, emailEnabled: false, trustedBase: null }));
  assert.doesNotThrow(() => assertResetEmailBaseUrl({ isProd: false, emailEnabled: true, trustedBase: null }));
});

test("RESET-HOST-006b: production reset with no trusted base URL fails closed (no email)", async () => {
  const { uc, captured } = makeUC({ isProd: true, publicBaseUrl: null }, "");
  await assert.rejects(() => uc.requestReset("a@b.com"), /reset_unavailable|not available/);
  assert.equal(captured.sent, false); // never sent a header-poisonable link
});

test("RESET-HOST-007: embedded-credential / unsafe URLs rejected", () => {
  const prod = { allowHttp: false };
  assert.equal(isSafePublicBaseUrl("https://user:pass@awamer.example.com", prod), false);
  assert.equal(isSafePublicBaseUrl("javascript:alert(1)", prod), false);
  assert.equal(isSafePublicBaseUrl("file:///etc/passwd", prod), false);
  assert.equal(isSafePublicBaseUrl("data:text/html,x", prod), false);
  assert.equal(isSafePublicBaseUrl("ftp://awamer.example.com", prod), false);
  assert.equal(isSafePublicBaseUrl("http://awamer.example.com", prod), false); // http not allowed in prod
  assert.equal(isSafePublicBaseUrl("https://awamer.example.com", prod), true);
  assert.equal(isSafePublicBaseUrl("https://awamer.example.com:6655", prod), true);
  assert.equal(isSafePublicBaseUrl("http://localhost:1420", { allowHttp: true }), true); // dev
});

test("RESET-HOST-008: reset email contains the configured trusted origin only", async () => {
  const { uc, captured } = makeUC({ isProd: true, publicBaseUrl: "https://awamer.example.com:6655" });
  await uc.requestReset("a@b.com");
  assert.ok(captured.link!.startsWith("https://awamer.example.com:6655/?reset_token="));
  assert.ok(!captured.link!.includes("evil"));
  // A validated DB app_base_url is honored when env is unset; a malicious/invalid one is not.
  const viaDb = makeUC({ isProd: true, publicBaseUrl: null }, "https://portal.example.com");
  await viaDb.uc.requestReset("a@b.com");
  assert.ok(viaDb.captured.link!.startsWith("https://portal.example.com/?reset_token="));
});

test("RESET-HOST resolveTrustedBaseUrl precedence + fail-closed", () => {
  // env wins over db
  assert.equal(
    resolveTrustedBaseUrl({ envBaseUrl: "https://env.example.com", dbBaseUrl: "https://db.example.com", allowHttp: false }),
    "https://env.example.com",
  );
  // invalid env falls through to valid db
  assert.equal(
    resolveTrustedBaseUrl({ envBaseUrl: "http://env.example.com", dbBaseUrl: "https://db.example.com", allowHttp: false }),
    "https://db.example.com",
  );
  // nothing valid → null
  assert.equal(resolveTrustedBaseUrl({ envBaseUrl: "", dbBaseUrl: "", allowHttp: false }), null);
});
