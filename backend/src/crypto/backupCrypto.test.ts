/**
 * SEC-BACKUP-KDF-001 — backup decryption must not run attacker-chosen scrypt
 * parameters, and both AES-GCM envelopes require a full 128-bit tag.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { encryptBackup, decryptBackup, BackupDecryptError } from "./backupCrypto.js";
import { createSecretBox } from "./secretBox.js";

const PASS = "correct horse battery staple";

test("BACKUP-KDF-001: a genuine encrypted backup still round-trips", () => {
  const enc = encryptBackup('{"hello":"world"}', PASS);
  assert.equal(decryptBackup(enc, PASS), '{"hello":"world"}');
});

test("BACKUP-KDF-002: attacker-chosen scrypt cost parameters are refused without deriving", () => {
  const enc = encryptBackup("{}", PASS);
  for (const kdf of [
    { ...enc.kdf, p: 400_000 },          // CPU bomb within maxmem
    { ...enc.kdf, N: 1 << 20 },
    { ...enc.kdf, r: 1 },
    { ...enc.kdf, algo: "pbkdf2" as "scrypt" },
  ]) {
    const t0 = Date.now();
    assert.throws(() => decryptBackup({ ...enc, kdf }, PASS), BackupDecryptError);
    assert.ok(Date.now() - t0 < 1000, "must be rejected before any expensive KDF work");
  }
});

test("BACKUP-KDF-003: a truncated GCM tag is rejected", () => {
  const enc = encryptBackup("{}", PASS);
  const short = Buffer.from(enc.tag, "base64").subarray(0, 4).toString("base64");
  assert.throws(() => decryptBackup({ ...enc, tag: short }, PASS), BackupDecryptError);
});

test("SECRETBOX-TAG-001: the credential envelope rejects a truncated GCM tag", () => {
  const box = createSecretBox(randomBytes(32));
  const env = box.encrypt({ password: "s3cret" });
  assert.deepEqual(box.decrypt(env), { password: "s3cret" });
  const short = { ...env, tag: Buffer.from(env.tag, "base64").subarray(0, 4).toString("base64") };
  assert.throws(() => box.decrypt(short));
});
