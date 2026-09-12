/**
 * MFA plaintext fail-closed hardening — after migration, a stored TOTP secret is
 * only ever accepted when it is a valid AES-256-GCM envelope. Plaintext,
 * malformed, tampered, or wrong-key values are rejected (never interpreted as a
 * seed), and the secret is never leaked in an error/log. The legacy migration
 * still converts old plaintext rows correctly.
 *
 * MFA-FAILCLOSED-001..008. Pure unit test (no DB) with a real SecretBox.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { authenticator } from "otplib";
import { createSecretBox, type SecretBox } from "../crypto/secretBox.js";
import { MFAUseCase, MfaSecretError } from "./mfa.js";
import { reencryptLegacyMfaSecrets } from "./mfaMigration.js";
import type { MFADevice } from "../domain/index.js";

authenticator.options = { window: 1, step: 30, digits: 6 };

const KEY = randomBytes(32);
const box = createSecretBox(KEY);
const noopLog = { info() {}, warn() {}, error() {}, debug() {} } as any;

/** Build an MFAUseCase whose primary device carries the given stored bytes. */
function mfaWith(secretBox: SecretBox, secretEnc: Buffer, calls?: unknown[]): MFAUseCase {
  const device: MFADevice = {
    id: "d1", userId: "u1", deviceName: "x", deviceType: "totp",
    secretEnc, isPrimary: true, lastUsedAt: null, createdAt: new Date(),
  };
  const devices = {
    getPrimary: async () => device,
    listByUser: async () => [device],
    updateLastUsed: async () => { calls?.push("updateLastUsed"); },
  } as any;
  const audit = { log: async (e: unknown) => { calls?.push(e); } } as any;
  return new MFAUseCase({} as any, devices, audit, {} as any, {} as any, secretBox, {} as any);
}

test("MFA-FAILCLOSED-001: an encrypted seed decrypts and verifies successfully", async () => {
  const secret = authenticator.generateSecret();
  const enc = box.sealBytes(Buffer.from(secret, "utf8"));
  const code = authenticator.generate(secret);
  await assert.doesNotReject(() => mfaWith(box, enc).verifyCode("u1", code));
});

test("MFA-FAILCLOSED-002: a plaintext seed is rejected at runtime (never trusted)", async () => {
  const secret = authenticator.generateSecret();
  const plaintext = Buffer.from(secret, "utf8"); // legacy raw base32 bytes
  const code = authenticator.generate(secret);   // even a 'correct' code must not pass
  await assert.rejects(() => mfaWith(box, plaintext).verifyCode("u1", code), MfaSecretError);
});

test("MFA-FAILCLOSED-003: malformed encrypted data is rejected", async () => {
  // Looks like an envelope (version byte 0x01, long enough) but is not valid.
  const malformed = Buffer.concat([Buffer.from([1]), randomBytes(40)]);
  await assert.rejects(() => mfaWith(box, malformed).verifyCode("u1", "000000"));
});

test("MFA-FAILCLOSED-004: tampered ciphertext is rejected (GCM auth failure)", async () => {
  const secret = authenticator.generateSecret();
  const enc = box.sealBytes(Buffer.from(secret, "utf8"));
  enc[enc.length - 1] = enc[enc.length - 1]! ^ 0xff; // flip a ciphertext byte
  await assert.rejects(() => mfaWith(box, enc).verifyCode("u1", authenticator.generate(secret)));
});

test("MFA-FAILCLOSED-005: a value sealed with a different key is rejected", async () => {
  const other = createSecretBox(randomBytes(32));
  const secret = authenticator.generateSecret();
  const enc = other.sealBytes(Buffer.from(secret, "utf8")); // wrong key
  await assert.rejects(() => mfaWith(box, enc).verifyCode("u1", authenticator.generate(secret)));
});

test("MFA-FAILCLOSED-006: the legacy migration converts a plaintext row correctly", async () => {
  const secret = authenticator.generateSecret();
  const rows: { id: string; secretEnc: Buffer }[] = [{ id: "d1", secretEnc: Buffer.from(secret, "utf8") }];
  const devices = {
    listAllSecrets: async () => rows.map((r) => ({ id: r.id, secretEnc: r.secretEnc })),
    updateSecret: async (id: string, enc: Buffer) => { rows.find((r) => r.id === id)!.secretEnc = enc; },
  } as any;
  const res = await reencryptLegacyMfaSecrets(devices, box, noopLog);
  assert.equal(res.migrated, 1);
  assert.ok(box.isSealedBytes(rows[0]!.secretEnc), "row is now a sealed envelope");
  // The migrated row now decrypts back to the original secret and verifies.
  await assert.doesNotReject(() => mfaWith(box, rows[0]!.secretEnc).verifyCode("u1", authenticator.generate(secret)));
});

test("MFA-FAILCLOSED-007: after migration no plaintext rows remain", async () => {
  const rows = [
    { id: "d1", secretEnc: Buffer.from(authenticator.generateSecret(), "utf8") }, // plaintext
    { id: "d2", secretEnc: box.sealBytes(Buffer.from(authenticator.generateSecret(), "utf8")) }, // already sealed
  ];
  const devices = {
    listAllSecrets: async () => rows.map((r) => ({ id: r.id, secretEnc: r.secretEnc })),
    updateSecret: async (id: string, enc: Buffer) => { rows.find((r) => r.id === id)!.secretEnc = enc; },
  } as any;
  await reencryptLegacyMfaSecrets(devices, box, noopLog);
  for (const r of rows) assert.ok(box.isSealedBytes(r.secretEnc), `${r.id} is sealed`);
  // Running again is a no-op (idempotent).
  const again = await reencryptLegacyMfaSecrets(devices, box, noopLog);
  assert.equal(again.migrated, 0);
});

test("MFA-FAILCLOSED-008: the secret never appears in the error or any log", async () => {
  const secret = authenticator.generateSecret();
  const plaintext = Buffer.from(secret, "utf8");
  const calls: unknown[] = [];
  let thrown: unknown;
  try {
    await mfaWith(box, plaintext, calls).verifyCode("u1", authenticator.generate(secret));
  } catch (e) { thrown = e; }
  assert.ok(thrown instanceof MfaSecretError);
  const errText = `${(thrown as Error).name}: ${(thrown as Error).message}`;
  assert.ok(!errText.includes(secret), "error message must not contain the secret");
  assert.ok(!JSON.stringify(calls).includes(secret), "no log/audit call may contain the secret");
});
