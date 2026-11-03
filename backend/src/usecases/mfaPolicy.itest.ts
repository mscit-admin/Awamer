/**
 * SEC-MFA-POLICY-001 + SEC-EMAIL-001 (integration). Real PostgreSQL + real routes.
 *
 *   MFA-POLICY-001..008 — roles in `mfa_required_roles` (default super_admin +
 *     admin) are held at enrollment until they have MFA; WS entry points refuse
 *     them; they cannot self-disable; the policy is super-admin managed + audited.
 *   EMAIL-STEPUP-001..006 — changing the account email (the password-reset
 *     channel) needs an `email_change` step-up; the old address is notified.
 */
import { test, before, after, beforeEach } from "node:test";
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
import { makeAuthedRoutes, type NoticeMailer } from "../routes/users.js";
import { makeSessionSettingsRoutes } from "../routes/sessionSettings.js";
import { verifyCurrentAccessToken, AuthStateError } from "../middleware/auth.js";
import {
  DEFAULT_MFA_REQUIRED_ROLES, MFA_POLICY_KEY, loadMfaPolicy, mfaRequiredRoles, setMfaRequiredRoles,
} from "../domain/mfaPolicy.js";
import { getPool, closePool, dbSkip } from "../test/db.js";

const noopLog = { info() {}, warn() {}, error() {}, debug() {} } as any;
const PW = "Mfa-P0licy-Str0ng-Pass!";
let app: FastifyInstance, jwt: JwtService, users: UserRepository, stepUp: StepUpService;
let argon2: ReturnType<typeof createArgon2>, settings: AppSettingsRepository;
const sent: { to: string; subject: string; text: string }[] = [];
const mailer: NoticeMailer = {
  async isConfigured() { return true; },
  async send(m) { sent.push(m); },
};
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

async function mkUser(role: string): Promise<string> {
  const id = uuid();
  const hash = await argon2.hash(PW);
  await getPool().query(
    `INSERT INTO users (id,username,email,password_hash,role,is_active)
     VALUES ($1,'mp_'||substr(md5(random()::text),1,12),'mp_'||substr(md5(random()::text),1,12)||'@t.local',$2,$3,TRUE)`,
    [id, hash, role]);
  return id;
}
const tokenFor = async (id: string) => {
  const u = await users.getById(id);
  return (await jwt.issuePair(id, u.role, u.authVersion)).access.token;
};
const req = (method: "GET" | "POST" | "PATCH" | "PUT", url: string, tok: string, body?: Record<string, unknown>, extra: Record<string, string> = {}) =>
  app.inject({ method, url, headers: { ...bearer(tok), ...extra }, ...(body ? { payload: body } : {}) });

async function stepUpFor(tok: string, purpose: string, mfaCode?: string): Promise<string> {
  const res = await req("POST", "/api/v1/auth/step-up", tok, { password: PW, purpose, ...(mfaCode ? { mfa_code: mfaCode } : {}) });
  assert.equal(res.statusCode, 200, res.body);
  return JSON.parse(res.body).step_up_token;
}

before(async () => {
  if (dbSkip) return;
  const cfg = loadConfig();
  jwt = createJwt(cfg); argon2 = createArgon2(cfg);
  const pool = getPool();
  users = new UserRepository(pool);
  settings = new AppSettingsRepository(pool);
  const audit = new AuditRepository(pool);
  const box = createSecretBox(resolveSecretKey(cfg, noopLog));
  const refresh = new RefreshRepository(pool);
  const mfa = new MFAUseCase(users, new MFADeviceRepository(pool), audit, cfg, argon2, box, settings, refresh);
  const changePassword = new ChangePasswordUseCase(users, refresh, audit, argon2);
  stepUp = new StepUpService(jwt, users);
  app = Fastify();
  await app.register(makeAuthedRoutes({ users, mfa, changePassword, jwt, stepUp, audit, mailer, log: noopLog }), { prefix: "/api/v1" });
  await app.register(makeSessionSettingsRoutes({ settings, users, jwt, audit }), { prefix: "/api/v1/admin/session-settings" });
  // A stand-in for every other authenticated route.
  const { makeAuthMiddleware } = await import("../middleware/auth.js");
  app.get("/api/v1/hosts", { preHandler: makeAuthMiddleware(jwt, users) }, async () => ({ data: [] }));
  await app.ready();
});
// The shared harness disables the policy; this suite runs with the production default.
beforeEach(() => { setMfaRequiredRoles(DEFAULT_MFA_REQUIRED_ROLES); sent.length = 0; });
after(async () => {
  if (dbSkip) return;
  setMfaRequiredRoles([]);
  await app.close();
  await getPool().query(`DELETE FROM app_settings WHERE key = $1`, [MFA_POLICY_KEY]);
  await getPool().query(`DELETE FROM users WHERE username LIKE 'mp\\_%'`);
  await closePool();
});

// ---------------------------------------------------------------------------
// MFA policy
// ---------------------------------------------------------------------------

test("MFA-POLICY-001: default policy requires MFA for super_admin and admin only", { skip: dbSkip }, async () => {
  await getPool().query(`DELETE FROM app_settings WHERE key = $1`, [MFA_POLICY_KEY]);
  await loadMfaPolicy(settings);
  assert.deepEqual(mfaRequiredRoles(), ["admin", "super_admin"]);
});

test("MFA-POLICY-002: an admin without MFA is held at enrollment (403 mfa_enrollment_required)", { skip: dbSkip }, async () => {
  const id = await mkUser("admin"); const tok = await tokenFor(id);
  const res = await req("GET", "/api/v1/hosts", tok);
  assert.equal(res.statusCode, 403, res.body);
  assert.equal(JSON.parse(res.body).error.code, "mfa_enrollment_required");
  // ...but can still read itself, and is told why.
  const me = await req("GET", "/api/v1/users/me", tok);
  assert.equal(me.statusCode, 200, me.body);
  assert.equal(JSON.parse(me.body).mfa_enrollment_required, true);
});

test("MFA-POLICY-003: an ordinary user is not affected", { skip: dbSkip }, async () => {
  const id = await mkUser("user"); const tok = await tokenFor(id);
  assert.equal((await req("GET", "/api/v1/hosts", tok)).statusCode, 200);
  assert.equal(JSON.parse((await req("GET", "/api/v1/users/me", tok)).body).mfa_enrollment_required, false);
});

test("MFA-POLICY-004: the held admin can step up, enroll and activate; then has full access", { skip: dbSkip }, async () => {
  const id = await mkUser("admin"); const tok = await tokenFor(id);
  const su = await stepUpFor(tok, "mfa_change");
  const enr = await req("POST", "/api/v1/auth/mfa/enroll", tok, { device_name: "x" }, { "x-step-up-token": su });
  assert.equal(enr.statusCode, 200, enr.body);
  const { device_id, secret } = JSON.parse(enr.body);
  const act = await req("POST", "/api/v1/auth/mfa/activate", tok, { device_id, code: authenticator.generate(secret) });
  assert.equal(act.statusCode, 204, act.body);
  // activation ends existing sessions (auth_version bump) — a fresh login token works.
  const tok2 = await tokenFor(id);
  assert.equal((await req("GET", "/api/v1/hosts", tok2)).statusCode, 200);
  assert.equal(JSON.parse((await req("GET", "/api/v1/users/me", tok2)).body).mfa_enrollment_required, false);
});

test("MFA-POLICY-005: WebSocket entry points refuse an un-enrolled admin", { skip: dbSkip }, async () => {
  const id = await mkUser("admin"); const tok = await tokenFor(id);
  await assert.rejects(
    () => verifyCurrentAccessToken(jwt, users, tok),
    (e: unknown) => e instanceof AuthStateError && e.code === "mfa_enrollment_required",
  );
});

test("MFA-POLICY-006: a role that requires MFA cannot self-disable it", { skip: dbSkip }, async () => {
  const id = await mkUser("user"); let tok = await tokenFor(id);
  const su = await stepUpFor(tok, "mfa_change");
  const { device_id, secret } = JSON.parse((await req("POST", "/api/v1/auth/mfa/enroll", tok, {}, { "x-step-up-token": su })).body);
  await req("POST", "/api/v1/auth/mfa/activate", tok, { device_id, code: authenticator.generate(secret) });
  await getPool().query(`UPDATE users SET role = 'admin' WHERE id = $1`, [id]);
  tok = await tokenFor(id);
  const res = await req("POST", "/api/v1/auth/mfa/disable", tok, {});
  assert.equal(res.statusCode, 403, res.body);
  assert.equal(JSON.parse(res.body).error.code, "mfa_required_by_policy");
  assert.equal((await users.getById(id)).mfaEnabled, true);
});

test("MFA-POLICY-007: only settings:manage may change the policy; it applies at once and is audited", { skip: dbSkip }, async () => {
  const admin = await mkUser("admin");
  const sup = await mkUser("super_admin");
  // settings:manage is super-admin only (an admin gets 403 either way here).
  const denied = await req("PUT", "/api/v1/admin/session-settings", await tokenFor(admin), { mfa_required_roles: [] });
  assert.equal(denied.statusCode, 403);
  // An un-enrolled super_admin is itself held at enrollment by the default policy.
  const held = await req("PUT", "/api/v1/admin/session-settings", await tokenFor(sup), { mfa_required_roles: [] });
  assert.equal(JSON.parse(held.body).error.code, "mfa_enrollment_required");
  // With MFA on the super_admin the change goes through.
  await getPool().query(`UPDATE users SET mfa_enabled = TRUE WHERE id = $1`, [sup]);
  const ok = await req("PUT", "/api/v1/admin/session-settings", await tokenFor(sup), { mfa_required_roles: ["super_admin", "auditor", "super_admin"] });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.deepEqual(JSON.parse(ok.body).mfa_required_roles, ["auditor", "super_admin"]);
  assert.deepEqual(mfaRequiredRoles(), ["auditor", "super_admin"]);
  // admin is no longer required → reaches normal routes.
  assert.equal((await req("GET", "/api/v1/hosts", await tokenFor(admin))).statusCode, 200);
  // persisted and reloadable; audited.
  const s = await settings.getMany([MFA_POLICY_KEY]);
  assert.equal(s[MFA_POLICY_KEY], JSON.stringify(["auditor", "super_admin"]));
  const { rows } = await getPool().query(
    `SELECT 1 FROM audit_logs WHERE user_id = $1 AND details->>'op' = 'mfa_policy_update'`, [sup]);
  assert.equal(rows.length, 1);
});

test("MFA-POLICY-008: invalid role keys are rejected", { skip: dbSkip }, async () => {
  const sup = await mkUser("super_admin");
  await getPool().query(`UPDATE users SET mfa_enabled = TRUE WHERE id = $1`, [sup]);
  const res = await req("PUT", "/api/v1/admin/session-settings", await tokenFor(sup), { mfa_required_roles: ["Admin; DROP"] });
  assert.equal(res.statusCode, 400);
});

// ---------------------------------------------------------------------------
// Email change requires step-up
// ---------------------------------------------------------------------------

test("EMAIL-STEPUP-001: an access token alone cannot change the email", { skip: dbSkip }, async () => {
  const id = await mkUser("user"); const tok = await tokenFor(id);
  const before = (await users.getById(id)).email;
  const res = await req("PATCH", "/api/v1/users/me", tok, { email: "attacker@evil.example" });
  assert.equal(res.statusCode, 401, res.body);
  assert.equal(JSON.parse(res.body).error.code, "step_up_required");
  assert.equal((await users.getById(id)).email, before);
});

test("EMAIL-STEPUP-002: an mfa_change step-up is not valid for an email change", { skip: dbSkip }, async () => {
  const id = await mkUser("user"); const tok = await tokenFor(id);
  const su = await stepUpFor(tok, "mfa_change");
  const res = await req("PATCH", "/api/v1/users/me", tok, { email: "x@t.local" }, { "x-step-up-token": su });
  assert.equal(res.statusCode, 401, res.body);
});

test("EMAIL-STEPUP-003: with an email_change step-up the change succeeds, is audited, and the old address is notified", { skip: dbSkip }, async () => {
  const id = await mkUser("user"); const tok = await tokenFor(id);
  const oldEmail = (await users.getById(id)).email;
  const newEmail = `mp_new_${uuid().slice(0, 8)}@t.local`;
  const su = await stepUpFor(tok, "email_change");
  const res = await req("PATCH", "/api/v1/users/me", tok, { email: newEmail, step_up_token: su });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal((await users.getById(id)).email, newEmail);
  const { rows } = await getPool().query(
    `SELECT 1 FROM audit_logs WHERE user_id = $1 AND details->>'op' = 'email_change'`, [id]);
  assert.equal(rows.length, 1);
  await new Promise((r) => setImmediate(r)); // notice is sent off the request path
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.to, oldEmail);
});

test("EMAIL-STEPUP-004: the email_change step-up is single-use", { skip: dbSkip }, async () => {
  const id = await mkUser("user"); const tok = await tokenFor(id);
  const su = await stepUpFor(tok, "email_change");
  assert.equal((await req("PATCH", "/api/v1/users/me", tok, { email: `mp_a_${uuid().slice(0, 8)}@t.local` }, { "x-step-up-token": su })).statusCode, 200);
  assert.equal((await req("PATCH", "/api/v1/users/me", tok, { email: `mp_b_${uuid().slice(0, 8)}@t.local` }, { "x-step-up-token": su })).statusCode, 401);
});

test("EMAIL-STEPUP-005: an MFA account needs the current code to step up for an email change", { skip: dbSkip }, async () => {
  const id = await mkUser("user"); let tok = await tokenFor(id);
  const su = await stepUpFor(tok, "mfa_change");
  const { device_id, secret } = JSON.parse((await req("POST", "/api/v1/auth/mfa/enroll", tok, {}, { "x-step-up-token": su })).body);
  await req("POST", "/api/v1/auth/mfa/activate", tok, { device_id, code: authenticator.generate(secret) });
  tok = await tokenFor(id);
  const noCode = await req("POST", "/api/v1/auth/step-up", tok, { password: PW, purpose: "email_change" });
  assert.equal(noCode.statusCode, 401);
  assert.equal(JSON.parse(noCode.body).error.code, "mfa_required");
});

test("EMAIL-STEPUP-006: name-only and same-email (case-insensitive) updates need no step-up", { skip: dbSkip }, async () => {
  const id = await mkUser("user"); const tok = await tokenFor(id);
  const email = (await users.getById(id)).email;
  const res = await req("PATCH", "/api/v1/users/me", tok, { full_name: "New Name", email: email.toUpperCase() });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal((await users.getById(id)).fullName, "New Name");
  assert.equal(sent.length, 0);
});
