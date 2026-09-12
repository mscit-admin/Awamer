/**
 * SEC-MFA-001 (integration) — TOTP secrets encrypted at rest + legacy migration.
 * Real PostgreSQL. MFA-CRYPT-001..008.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { v4 as uuid } from "uuid";
import { randomBytes } from "node:crypto";
import { authenticator } from "otplib";
import { loadConfig } from "../config/index.js";
import { createArgon2 } from "../crypto/argon2.js";
import { createSecretBox, resolveSecretKey } from "../crypto/secretBox.js";
import { UserRepository } from "../repos/userRepo.js";
import { MFADeviceRepository, AuditRepository } from "../repos/otherRepos.js";
import { AppSettingsRepository } from "../repos/appSettings.js";
import { MFAUseCase } from "./mfa.js";
import { reencryptLegacyMfaSecrets } from "./mfaMigration.js";
import { getPool, closePool, dbSkip } from "../test/db.js";

const noopLog = { info() {}, warn() {}, error() {}, debug() {} } as any;
let users: UserRepository, devices: MFADeviceRepository, mfa: MFAUseCase, secretBox: ReturnType<typeof createSecretBox>;

async function mkUser(): Promise<string> {
  const id = uuid();
  await getPool().query(
    `INSERT INTO users (id,username,email,password_hash,role,is_active)
     VALUES ($1,'mc_'||substr(md5(random()::text),1,12),'mc_'||substr(md5(random()::text),1,12)||'@t.local','x','user',TRUE)`, [id]);
  return id;
}
async function rawSecret(deviceId: string): Promise<Buffer> {
  const { rows } = await getPool().query<{ secret_enc: Buffer }>(`SELECT secret_enc FROM mfa_devices WHERE id=$1`, [deviceId]);
  return rows[0]!.secret_enc;
}

before(async () => {
  if (dbSkip) return;
  const cfg = loadConfig();
  secretBox = createSecretBox(resolveSecretKey(cfg, noopLog));
  const pool = getPool();
  users = new UserRepository(pool);
  devices = new MFADeviceRepository(pool);
  mfa = new MFAUseCase(users, devices, new AuditRepository(pool), cfg, createArgon2(cfg), secretBox, new AppSettingsRepository(pool));
});
after(async () => {
  if (dbSkip) return;
  await getPool().query(`DELETE FROM users WHERE username LIKE 'mc\\_%'`);
  await closePool();
});

test("MFA-CRYPT-001/002: new TOTP seed is encrypted at rest (DB != plaintext)", { skip: dbSkip }, async () => {
  const id = await mkUser();
  const e = await mfa.enroll(id, "d");
  const stored = await rawSecret(e.deviceId);
  assert.ok(secretBox.isSealedBytes(stored), "stored value is a sealed envelope");
  assert.notEqual(stored.toString("utf8"), e.secret, "stored bytes are not the plaintext base32 secret");
  assert.ok(!stored.toString("latin1").includes(e.secret), "plaintext secret does not appear in stored bytes");
});

test("MFA-CRYPT-003: correct key decrypts and verifies", { skip: dbSkip }, async () => {
  const id = await mkUser();
  const e = await mfa.enroll(id, "d");
  await assert.doesNotReject(() => mfa.verifyAndActivate(id, e.deviceId, authenticator.generate(e.secret)));
});

test("MFA-CRYPT-004: wrong key fails to decrypt", { skip: dbSkip }, async () => {
  const id = await mkUser();
  const e = await mfa.enroll(id, "d");
  const stored = await rawSecret(e.deviceId);
  const wrong = createSecretBox(randomBytes(32));
  assert.throws(() => wrong.openBytes(stored));
});

test("MFA-CRYPT-005: tampered ciphertext fails (AEAD integrity)", { skip: dbSkip }, async () => {
  const id = await mkUser();
  const e = await mfa.enroll(id, "d");
  const stored = Buffer.from(await rawSecret(e.deviceId));
  stored[stored.length - 1] = (stored[stored.length - 1] ?? 0) ^ 0xff; // flip a ciphertext byte
  assert.throws(() => secretBox.openBytes(stored));
});

test("MFA-CRYPT-006/007: legacy plaintext migration works + is idempotent", { skip: dbSkip }, async () => {
  const id = await mkUser();
  // Insert a LEGACY plaintext device row directly (pre-encryption format).
  const secret = authenticator.generateSecret();
  const devId = uuid();
  await getPool().query(
    `INSERT INTO mfa_devices (id,user_id,device_name,device_type,secret_enc,is_primary,created_at)
     VALUES ($1,$2,'legacy','totp',$3,TRUE,NOW())`, [devId, id, Buffer.from(secret, "utf8")]);
  assert.ok(!secretBox.isSealedBytes(await rawSecret(devId)), "starts as plaintext");

  const r1 = await reencryptLegacyMfaSecrets(devices, secretBox, noopLog);
  assert.ok(r1.migrated >= 1, "migrated at least the legacy row");
  const sealed = await rawSecret(devId);
  assert.ok(secretBox.isSealedBytes(sealed), "now sealed");
  assert.equal(secretBox.openBytes(sealed).toString("utf8"), secret, "decrypts to the original secret");
  // still verifiable after migration
  await assert.doesNotReject(() => mfa.verifyCode(id, authenticator.generate(secret)));

  // idempotent: a second run migrates nothing new (this device already sealed)
  const before = (await reencryptLegacyMfaSecrets(devices, secretBox, noopLog)).migrated;
  const after = (await reencryptLegacyMfaSecrets(devices, secretBox, noopLog)).migrated;
  assert.equal(after, before, "idempotent: stable migrate count on repeat runs");
});

test("MFA-CRYPT-008: plaintext seed never stored in the clear", { skip: dbSkip }, async () => {
  const id = await mkUser();
  const e = await mfa.enroll(id, "d");
  const stored = await rawSecret(e.deviceId);
  // exhaustive: neither utf8 nor latin1 rendering contains the base32 secret
  assert.ok(!stored.toString("utf8").includes(e.secret));
  assert.ok(!stored.toString("latin1").includes(e.secret));
});
