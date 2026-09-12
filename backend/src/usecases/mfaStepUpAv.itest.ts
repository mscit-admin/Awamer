/**
 * Step-up token auth_version binding (focused fix) — a step-up token is bound to
 * the account's security version at issue time and is rejected on consume once
 * that version changes (password change, forgot-password reset, admin reset, MFA
 * replacement). Combined with the pre-existing purpose / single-use / expiry /
 * user-binding protections.
 *
 * STEPUP-AV-001..010. Real PostgreSQL.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { v4 as uuid } from "uuid";
import { authenticator } from "otplib";
import { loadConfig } from "../config/index.js";
import { createJwt, type JwtService } from "../jwt/index.js";
import { createArgon2 } from "../crypto/argon2.js";
import { createSecretBox, resolveSecretKey } from "../crypto/secretBox.js";
import { UserRepository } from "../repos/userRepo.js";
import { MFADeviceRepository, RefreshRepository, AuditRepository } from "../repos/otherRepos.js";
import { AppSettingsRepository } from "../repos/appSettings.js";
import { PasswordResetRepository } from "../repos/passwordResetRepo.js";
import { ChangePasswordUseCase } from "./changePassword.js";
import { PasswordResetUseCase } from "./passwordReset.js";
import { MFAUseCase } from "./mfa.js";
import { StepUpService, StepUpError } from "./stepUp.js";
import { getPool, closePool, dbSkip } from "../test/db.js";

const noopLog = { info() {}, warn() {}, error() {}, debug() {} } as any;
const PW = "St3pUp-Av-Str0ng!";
let jwt: JwtService, users: UserRepository, stepUp: StepUpService;
let changePw: ChangePasswordUseCase, resetUC: PasswordResetUseCase, mfaUC: MFAUseCase;
let resets: PasswordResetRepository, argon2: ReturnType<typeof createArgon2>;

async function mkUser(): Promise<string> {
  const id = uuid();
  const hash = await argon2.hash(PW);
  await getPool().query(
    `INSERT INTO users (id,username,email,password_hash,role,is_active)
     VALUES ($1,'sa_'||substr(md5(random()::text),1,12),'sa_'||substr(md5(random()::text),1,12)||'@t.local',$2,'user',TRUE)`,
    [id, hash],
  );
  return id;
}
async function forgotReset(id: string): Promise<void> {
  const raw = "resettok_" + uuid().replace(/-/g, "");
  const { createHash } = await import("node:crypto");
  const h = createHash("sha256").update(raw).digest("hex");
  await resets.create(id, h, new Date(Date.now() + 30 * 60000));
  await resetUC.resetPassword(raw, "Sa-Forgot-Str0ng-1!");
}
async function enrollAndActivate(id: string): Promise<void> {
  const e = await mfaUC.enroll(id, "test");
  await mfaUC.verifyAndActivate(id, e.deviceId, authenticator.generate(e.secret));
}

before(async () => {
  if (dbSkip) return;
  const cfg = loadConfig();
  jwt = createJwt(cfg);
  argon2 = createArgon2(cfg);
  const pool = getPool();
  users = new UserRepository(pool);
  const refresh = new RefreshRepository(pool);
  const audit = new AuditRepository(pool);
  resets = new PasswordResetRepository(pool);
  const secretBox = createSecretBox(resolveSecretKey(cfg, noopLog));
  stepUp = new StepUpService(jwt, users);
  changePw = new ChangePasswordUseCase(users, refresh, audit, argon2);
  resetUC = new PasswordResetUseCase(users, resets, refresh,
    { baseUrl: async () => "", resetTtlMinutes: async () => 30, isConfigured: async () => false, sendPasswordReset: async () => {} } as any,
    argon2, audit, noopLog, { isProd: false, publicBaseUrl: null });
  mfaUC = new MFAUseCase(users, new MFADeviceRepository(pool), audit, cfg, argon2, secretBox, new AppSettingsRepository(pool), refresh);
});
after(async () => {
  if (dbSkip) return;
  await getPool().query(`DELETE FROM users WHERE username LIKE 'sa\\_%'`);
  await closePool();
});

test("STEPUP-AV-001: a step-up consumes normally at the same auth_version", { skip: dbSkip }, async () => {
  const id = await mkUser();
  const t = (await stepUp.issue(id, "mfa_change")).token;
  await assert.doesNotReject(() => stepUp.consume(t, id, "mfa_change"));
});

test("STEPUP-AV-002: a password change invalidates an outstanding step-up token", { skip: dbSkip }, async () => {
  const id = await mkUser();
  const t = (await stepUp.issue(id, "mfa_change")).token;
  await changePw.execute(id, PW, "Sa-NewPass-Str0ng-2!");
  await assert.rejects(() => stepUp.consume(t, id, "mfa_change"), StepUpError);
});

test("STEPUP-AV-003: a forgot-password reset invalidates the step-up token", { skip: dbSkip }, async () => {
  const id = await mkUser();
  const t = (await stepUp.issue(id, "mfa_change")).token;
  await forgotReset(id);
  await assert.rejects(() => stepUp.consume(t, id, "mfa_change"), StepUpError);
});

test("STEPUP-AV-004: an admin password reset invalidates the step-up token", { skip: dbSkip }, async () => {
  const id = await mkUser();
  const t = (await stepUp.issue(id, "mfa_change")).token;
  await changePw.adminReset(uuid(), id, "Sa-AdminReset-Str0ng-1!");
  await assert.rejects(() => stepUp.consume(t, id, "mfa_change"), StepUpError);
});

test("STEPUP-AV-005: an MFA replacement invalidates a previous step-up token", { skip: dbSkip }, async () => {
  const id = await mkUser();
  const t = (await stepUp.issue(id, "mfa_change")).token;
  await enrollAndActivate(id); // activation increments auth_version
  await assert.rejects(() => stepUp.consume(t, id, "mfa_change"), StepUpError);
});

test("STEPUP-AV-006: an expired step-up token is rejected", { skip: dbSkip }, async () => {
  const id = await mkUser();
  const av = (await users.getById(id)).authVersion;
  const expired = (await jwt.issueStepUp(id, "mfa_change", -10, av)).token;
  await assert.rejects(() => stepUp.consume(expired, id, "mfa_change"), StepUpError);
});

test("STEPUP-AV-007: a consumed step-up token cannot be reused", { skip: dbSkip }, async () => {
  const id = await mkUser();
  const t = (await stepUp.issue(id, "mfa_change")).token;
  await stepUp.consume(t, id, "mfa_change");
  await assert.rejects(() => stepUp.consume(t, id, "mfa_change"), StepUpError);
});

test("STEPUP-AV-008: a wrong-purpose token is rejected", { skip: dbSkip }, async () => {
  const id = await mkUser();
  const av = (await users.getById(id)).authVersion;
  const t = (await jwt.issueStepUp(id, "other_action", 300, av)).token;
  await assert.rejects(() => stepUp.consume(t, id, "mfa_change" as any), StepUpError);
});

test("STEPUP-AV-009: another user's step-up token is rejected", { skip: dbSkip }, async () => {
  const id = await mkUser();
  const t = (await stepUp.issue(id, "mfa_change")).token;
  await assert.rejects(() => stepUp.consume(t, uuid(), "mfa_change"), StepUpError);
});

test("STEPUP-AV-010: a fresh step-up minted after a security change works", { skip: dbSkip }, async () => {
  const id = await mkUser();
  await changePw.execute(id, PW, "Sa-AfterChange-Str0ng-1!");
  const t = (await stepUp.issue(id, "mfa_change")).token; // minted at the new auth_version
  await assert.doesNotReject(() => stepUp.consume(t, id, "mfa_change"));
});
