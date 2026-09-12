import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createSecretBox, isSecretEnvelope, resolveSecretKey } from "./secretBox.js";
import type { Config } from "../config/index.js";

const key = randomBytes(32);

test("encrypt → decrypt round-trips an object", () => {
  const box = createSecretBox(key);
  const plain = { password: "hunter2", note: "café ☕", n: 42 };
  const env = box.encrypt(plain);
  assert.ok(isSecretEnvelope(env));
  assert.deepEqual(box.decrypt(env), plain);
});

test("ciphertext does not contain the plaintext", () => {
  const box = createSecretBox(key);
  const env = box.encrypt({ password: "topsecret-value" });
  const blob = JSON.stringify(env);
  assert.ok(!blob.includes("topsecret-value"));
});

test("each encryption uses a fresh nonce", () => {
  const box = createSecretBox(key);
  const a = box.encrypt({ password: "same" });
  const b = box.encrypt({ password: "same" });
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.ct, b.ct);
});

test("seal leaves an empty object unencrypted", () => {
  const box = createSecretBox(key);
  assert.deepEqual(box.seal({}), {});
});

test("seal encrypts a non-empty object", () => {
  const box = createSecretBox(key);
  const sealed = box.seal({ key: "value" });
  assert.ok(isSecretEnvelope(sealed));
});

test("open decrypts an envelope and passes through legacy plaintext", () => {
  const box = createSecretBox(key);
  const env = box.encrypt({ password: "x" });
  assert.deepEqual(box.open(env), { password: "x" });
  // Legacy pre-Phase-10 plaintext JSONB:
  assert.deepEqual(box.open({ password: "legacy" }), { password: "legacy" });
  assert.deepEqual(box.open({}), {});
  assert.deepEqual(box.open(null), {});
});

test("decrypt rejects a tampered ciphertext (GCM auth)", () => {
  const box = createSecretBox(key);
  const env = box.encrypt({ password: "x" });
  const tamperedCt = Buffer.from(env.ct, "base64");
  tamperedCt[0] = (tamperedCt[0] ?? 0) ^ 0xff;
  assert.throws(() => box.decrypt({ ...env, ct: tamperedCt.toString("base64") }));
});

test("a different key cannot decrypt", () => {
  const a = createSecretBox(key);
  const b = createSecretBox(randomBytes(32));
  const env = a.encrypt({ password: "x" });
  assert.throws(() => b.decrypt(env));
});

test("createSecretBox rejects a wrong-length key", () => {
  assert.throws(() => createSecretBox(randomBytes(16)));
});

test("sealBytes → openBytes round-trips binary data", () => {
  const box = createSecretBox(key);
  const plain = randomBytes(4096);
  const sealed = box.sealBytes(plain);
  assert.ok(Buffer.isBuffer(sealed));
  assert.ok(!sealed.equals(plain)); // actually encrypted
  assert.ok(sealed.length > plain.length); // version + iv + tag framing
  assert.deepEqual(box.openBytes(sealed), plain);
});

test("sealBytes ciphertext does not contain the plaintext", () => {
  const box = createSecretBox(key);
  const marker = Buffer.from("SENSITIVE-BYTES-MARKER");
  const sealed = box.sealBytes(marker);
  assert.ok(!sealed.toString("latin1").includes("SENSITIVE-BYTES-MARKER"));
});

test("openBytes rejects a tampered binary envelope (GCM auth)", () => {
  const box = createSecretBox(key);
  const sealed = box.sealBytes(Buffer.from("hello"));
  const last = sealed.length - 1;
  sealed[last] = (sealed[last] ?? 0) ^ 0xff; // flip a ciphertext byte
  assert.throws(() => box.openBytes(sealed));
});

test("openBytes rejects a truncated envelope", () => {
  const box = createSecretBox(key);
  assert.throws(() => box.openBytes(Buffer.alloc(4)));
});

function fakeCfg(over: Partial<Config["env"]> & { isProd?: boolean }): Config {
  const { isProd, ...env } = over;
  return {
    env: { JWT_REFRESH_SECRET: "x".repeat(32), ...env } as Config["env"],
    isProd: isProd ?? false,
    isDev: !(isProd ?? false),
    jwtAccessTtlSec: 900,
    jwtRefreshTtlSec: 3600,
    corsOrigins: [],
    publicBaseUrl: null,
    networkDiagnostic: { allowed: [], deny: [] },
  };
}

const noopLog = { warn() {}, info() {}, error() {} } as any;

test("resolveSecretKey decodes a base64 key", () => {
  const k = randomBytes(32).toString("base64");
  const out = resolveSecretKey(fakeCfg({ CREDENTIAL_ENCRYPTION_KEY: k } as any), noopLog);
  assert.equal(out.length, 32);
  assert.equal(out.toString("base64"), k);
});

test("resolveSecretKey decodes a hex key", () => {
  const buf = randomBytes(32);
  const out = resolveSecretKey(
    fakeCfg({ CREDENTIAL_ENCRYPTION_KEY: buf.toString("hex") } as any),
    noopLog,
  );
  assert.deepEqual(out, buf);
});

test("resolveSecretKey rejects a wrong-length explicit key", () => {
  assert.throws(() =>
    resolveSecretKey(fakeCfg({ CREDENTIAL_ENCRYPTION_KEY: "deadbeef" } as any), noopLog),
  );
});

test("resolveSecretKey derives deterministically in dev when unset", () => {
  const a = resolveSecretKey(fakeCfg({}), noopLog);
  const b = resolveSecretKey(fakeCfg({}), noopLog);
  assert.equal(a.length, 32);
  assert.deepEqual(a, b);
});

test("resolveSecretKey throws in production when unset", () => {
  assert.throws(() => resolveSecretKey(fakeCfg({ isProd: true }), noopLog));
});
