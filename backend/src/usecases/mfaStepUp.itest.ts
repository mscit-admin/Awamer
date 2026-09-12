/**
 * SEC-MFA-002 (integration) — step-up re-auth for MFA changes.
 * Real PostgreSQL + real routes. MFA-STEPUP-001..008.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";
import { v4 as uuid } from "uuid";
import { authenticator } from "otplib";
import { loadConfig } from "../config/index.js";
import { createJwt, type JwtService } from "../jwt/index.js";
import { createArgon2 } from "../crypto/argon2.js";
import { createSecretBox, resolveSecretKey } from "../crypto/secretBox.js";
import { UserRepository } from "../repos/userRepo.js";
import { MFADeviceRepository, RefreshRepository, AuditRepository } from "../repos/otherRepos.js";
import { AppSettingsRepository } from "../repos/appSettings.js";
import { MFAUseCase } from "./mfa.js";
import { ChangePasswordUseCase } from "./changePassword.js";
import { StepUpService } from "./stepUp.js";
import { makeAuthedRoutes } from "../routes/users.js";
import { getPool, closePool, dbSkip } from "../test/db.js";

const noopLog = { info() {}, warn() {}, error() {}, debug() {} } as any;
const PW = "St3pUp-Str0ng-Pass!";
let app: FastifyInstance, jwt: JwtService, users: UserRepository, mfa: MFAUseCase, stepUp: StepUpService, argon2: ReturnType<typeof createArgon2>;
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

async function mkUser(): Promise<string> {
  const id = uuid();
  const hash = await argon2.hash(PW);
  await getPool().query(
    `INSERT INTO users (id,username,email,password_hash,role,is_active)
     VALUES ($1,'su_'||substr(md5(random()::text),1,12),'su_'||substr(md5(random()::text),1,12)||'@t.local',$2,'user',TRUE)`, [id, hash]);
  return id;
}
const tokenFor = async (id: string) => {
  const u = await users.getById(id);
  return (await jwt.issuePair(id, u.role, u.authVersion)).access.token;
};
const post = (url: string, tok: string, body: Record<string, unknown>, extra: Record<string, string> = {}) =>
  app.inject({ method: "POST", url, headers: { ...bearer(tok), ...extra }, payload: body });

before(async () => {
  if (dbSkip) return;
  const cfg = loadConfig();
  jwt = createJwt(cfg); argon2 = createArgon2(cfg);
  const pool = getPool();
  users = new UserRepository(pool);
  const audit = new AuditRepository(pool);
  const secretBox = createSecretBox(resolveSecretKey(cfg, noopLog));
  mfa = new MFAUseCase(users, new MFADeviceRepository(pool), audit, cfg, argon2, secretBox, new AppSettingsRepository(pool), new RefreshRepository(pool));
  const changePassword = new ChangePasswordUseCase(users, new RefreshRepository(pool), audit, argon2);
  stepUp = new StepUpService(jwt);
  app = Fastify();
  await app.register(makeAuthedRoutes({ users, mfa, changePassword, jwt, stepUp }), { prefix: "/api/v1" });
  await app.ready();
});
after(async () => {
  if (dbSkip) return;
  await app.close();
  await getPool().query(`DELETE FROM users WHERE username LIKE 'su\\_%'`);
  await closePool();
});

async function getStepUp(id: string, tok: string, mfaCode?: string): Promise<string> {
  const res = await post("/api/v1/auth/step-up", tok, { password: PW, ...(mfaCode ? { mfa_code: mfaCode } : {}) });
  assert.equal(res.statusCode, 200, res.body);
  return JSON.parse(res.body).step_up_token;
}

test("MFA-STEPUP-001: access token alone cannot enroll MFA", { skip: dbSkip }, async () => {
  const id = await mkUser(); const tok = await tokenFor(id);
  const res = await post("/api/v1/auth/mfa/enroll", tok, { device_name: "x" });
  assert.equal(res.statusCode, 401);
  assert.match(res.body, /re-authentication required/);
});

test("MFA-STEPUP-002: password step-up works, then enroll succeeds", { skip: dbSkip }, async () => {
  const id = await mkUser(); const tok = await tokenFor(id);
  const su = await getStepUp(id, tok);
  const res = await post("/api/v1/auth/mfa/enroll", tok, { device_name: "x" }, { "x-step-up-token": su });
  assert.equal(res.statusCode, 200, res.body);
  assert.ok(JSON.parse(res.body).secret);
});

test("MFA-STEPUP-003: existing MFA required for step-up when enabled", { skip: dbSkip }, async () => {
  const id = await mkUser(); const tok = await tokenFor(id);
  // enroll+activate to enable MFA
  const su = await getStepUp(id, tok);
  const enr = JSON.parse((await post("/api/v1/auth/mfa/enroll", tok, {}, { "x-step-up-token": su })).body);
  await post("/api/v1/auth/mfa/activate", tok, { device_id: enr.device_id, code: authenticator.generate(enr.secret) });
  // activation bumped auth_version → mint a fresh token to keep authenticating
  const tok2 = await tokenFor(id);
  // now step-up with password only must fail (MFA code required)
  const res = await post("/api/v1/auth/step-up", tok2, { password: PW });
  assert.equal(res.statusCode, 401);
  assert.match(res.body, /mfa_required/);
  // with a valid code it succeeds
  const ok = await post("/api/v1/auth/step-up", tok2, { password: PW, mfa_code: authenticator.generate(enr.secret) });
  assert.equal(ok.statusCode, 200, ok.body);
});

test("MFA-STEPUP-004: expired step-up token rejected", { skip: dbSkip }, async () => {
  const id = await mkUser();
  const expired = (await jwt.issueStepUp(id, "mfa_change", -10)).token; // already expired
  await assert.rejects(() => stepUp.consume(expired, id, "mfa_change"), /re-authentication required/);
});

test("MFA-STEPUP-005: step-up token cannot be reused", { skip: dbSkip }, async () => {
  const id = await mkUser();
  const t = (await stepUp.issue(id, "mfa_change")).token;
  await stepUp.consume(t, id, "mfa_change");                 // first use ok
  await assert.rejects(() => stepUp.consume(t, id, "mfa_change"), /already been used|re-authentication required/);
});

test("MFA-STEPUP-006: step-up token is action-bound (purpose)", { skip: dbSkip }, async () => {
  const id = await mkUser();
  const t = (await jwt.issueStepUp(id, "other_action", 300)).token;
  await assert.rejects(() => stepUp.consume(t, id, "mfa_change"), /not valid|re-authentication required/);
  // also bound to the user
  const t2 = (await stepUp.issue(id, "mfa_change")).token;
  await assert.rejects(() => stepUp.consume(t2, uuid(), "mfa_change"), /does not match|re-authentication required/);
});

test("MFA-STEPUP-007: MFA disable requires step-up", { skip: dbSkip }, async () => {
  const id = await mkUser(); const tok = await tokenFor(id);
  const res = await post("/api/v1/auth/mfa/disable", tok, { password: PW });
  assert.equal(res.statusCode, 401);
  assert.match(res.body, /re-authentication required/);
});

test("MFA-STEPUP-008: MFA activation increments auth_version", { skip: dbSkip }, async () => {
  const id = await mkUser(); const tok = await tokenFor(id);
  const before = (await users.getById(id)).authVersion;
  const su = await getStepUp(id, tok);
  const enr = JSON.parse((await post("/api/v1/auth/mfa/enroll", tok, {}, { "x-step-up-token": su })).body);
  await post("/api/v1/auth/mfa/activate", tok, { device_id: enr.device_id, code: authenticator.generate(enr.secret) });
  const after = (await users.getById(id)).authVersion;
  assert.ok(after > before, `auth_version bumped ${before} -> ${after}`);
});
