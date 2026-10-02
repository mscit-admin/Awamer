/**
 * Final security closure — regression tests (integration, real PostgreSQL).
 * Boots the REAL auth / users / admin / org / roles / SMTP / branding /
 * session-settings routes and drives them over app.inject.
 *
 *   FINAL-MFA-001  the login MFA-challenge token is NOT a session (MFA bypass)
 *   FINAL-MFA-002  the challenge still completes with a valid code
 *   FINAL-MFA-003  MFA guesses lock the account per-account (re-login no reset)
 *   FINAL-CEIL-001 company admin cannot reset/disable-MFA/lock/delete a
 *                  co-located super_admin (cross-tenant takeover chain)
 *   FINAL-CEIL-002 company admin still manages ordinary users (no regression)
 *   FINAL-CEIL-003 a users:manage helpdesk role cannot demote its admin
 *   FINAL-INST-001 company admin cannot change SMTP / branding / session policy
 *   FINAL-INST-002 super_admin can, and the change is audited
 *   FINAL-INST-003 admin cannot mint a custom role holding settings:manage
 *   FINAL-REFRESH-001 concurrent refreshes of one token: exactly one wins
 *   FINAL-LOGOUTALL-001 logout-all kills the outstanding access token
 * Skips without DATABASE_URL.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { authenticator } from "otplib";
import { loadConfig } from "../config/index.js";
import { createLogger } from "../logger/index.js";
import { createJwt, type JwtService } from "../jwt/index.js";
import { createArgon2 } from "../crypto/argon2.js";
import { createSecretBox, resolveSecretKey } from "../crypto/secretBox.js";
import { RoleRepository } from "../repos/roleRepo.js";
import { RoleService } from "../domain/roleService.js";
import { UserRepository } from "../repos/userRepo.js";
import { RefreshRepository, AuditRepository, MFADeviceRepository } from "../repos/otherRepos.js";
import { AppSettingsRepository } from "../repos/appSettings.js";
import { CompanyRepository, OrgUnitRepository } from "../repos/orgRepos.js";
import { RegisterUseCase } from "../usecases/register.js";
import { ChangePasswordUseCase } from "../usecases/changePassword.js";
import { MFAUseCase } from "../usecases/mfa.js";
import { LoginUseCase } from "../usecases/login.js";
import { RefreshUseCase } from "../usecases/refresh.js";
import { StepUpService } from "../usecases/stepUp.js";
import { MailService } from "../email/mailer.js";
import { makeAuthRoutes } from "./auth.js";
import { makeAuthedRoutes } from "./users.js";
import { makeAdminRoutes } from "./admin.js";
import { makeOrganizationRoutes } from "./organization.js";
import { makeRoleRoutes } from "./roles.js";
import { makeSmtpRoutes } from "./smtp.js";
import { makeBrandingRoutes } from "./branding.js";
import { makeSessionSettingsRoutes } from "./sessionSettings.js";
import { getPool, closePool, dbSkip } from "../test/db.js";

const PW = "Fin4l-Secur1ty-Pass!";
let app: FastifyInstance;
let jwt: JwtService;
let users: UserRepository;
let roles: RoleRepository;
const revoked: string[] = [];
const sessions = {
  register() {}, unregister() {}, revokeUser(id: string) { revoked.push(id); return 0; },
  revalidateUser: async () => {}, count() { return 0; }, countForUser() { return 0; }, startPeriodic() {}, stop() {},
} as never;
const ids = { compA: "", superA: "", adminA: "", userA: "", helpdesk: "", mfaUser: "" };
const tok: Record<string, string> = {};
const roleIds: string[] = [];
let mfaSecret = "";

async function mkCompany(name: string): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(`INSERT INTO companies (id, name) VALUES (gen_random_uuid(), $1) RETURNING id`, [name]);
  return rows[0]!.id;
}
async function mkUser(role: string, companyId: string, hash = "x"): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO users (id, username, email, password_hash, role, company_id, is_active)
     VALUES (gen_random_uuid(), 'fs_'||substr(md5(random()::text),1,12), 'fs_'||substr(md5(random()::text),1,12)||'@t.local',$3,$1,$2,TRUE) RETURNING id`,
    [role, companyId, hash]);
  return rows[0]!.id;
}
const bearer = (t: string | undefined) => ({ authorization: `Bearer ${t ?? ""}` });
const tokenFor = async (id: string) => {
  const u = await users.getById(id);
  return (await jwt.issuePair(id, u.role, u.authVersion)).access.token;
};
/** A code from a step no earlier than any already claimed (replay protection). */
const freshCode = async () => {
  await getPool().query(`UPDATE mfa_devices SET last_used_at = NULL WHERE user_id = $1`, [ids.mfaUser]);
  return authenticator.generate(mfaSecret);
};

before(async () => {
  if (dbSkip) return;
  const cfg = loadConfig();
  const log = createLogger(cfg);
  const pool = getPool();
  jwt = createJwt(cfg);
  const argon2 = createArgon2(cfg);
  roles = new RoleRepository(pool);
  const roleService = new RoleService(roles);
  users = new UserRepository(pool);
  const audit = new AuditRepository(pool);
  const refresh = new RefreshRepository(pool);
  const devices = new MFADeviceRepository(pool);
  const settings = new AppSettingsRepository(pool);
  const box = createSecretBox(resolveSecretKey(cfg, log));
  await roleService.syncBuiltins();

  ids.compA = await mkCompany("FINAL A");
  const helpdesk = await roles.create({ key: "fs_helpdesk_" + Date.now(), name: "FS Helpdesk", permissions: ["users:manage"], companyId: ids.compA });
  roleIds.push(helpdesk.id);
  await roleService.reload();

  const hash = await argon2.hash(PW);
  ids.superA = await mkUser("super_admin", ids.compA);
  ids.adminA = await mkUser("admin", ids.compA);
  ids.userA = await mkUser("user", ids.compA, hash);
  ids.helpdesk = await mkUser(helpdesk.key, ids.compA);
  ids.mfaUser = await mkUser("user", ids.compA, hash);

  // MFA account with auth_version left at 1 — the exact precondition of the
  // pre-fix bypass (MFA enabled before migration 027 / never re-keyed).
  mfaSecret = authenticator.generateSecret();
  await devices.create({ id: randomUUID(), userId: ids.mfaUser, deviceName: "t", deviceType: "totp", secretEnc: box.sealBytes(Buffer.from(mfaSecret, "utf8")), isPrimary: true });
  await pool.query(`UPDATE users SET mfa_enabled = TRUE, auth_version = 1 WHERE id = $1`, [ids.mfaUser]);

  for (const k of ["superA", "adminA", "userA", "helpdesk"] as const) tok[k] = await tokenFor(ids[k]);

  const mfa = new MFAUseCase(users, devices, audit, cfg, argon2, box, settings, refresh);
  const login = new LoginUseCase(users, refresh, audit, jwt, argon2, cfg, log);
  const refreshUC = new RefreshUseCase(users, refresh, audit, jwt, log);
  const changePassword = new ChangePasswordUseCase(users, refresh, audit, argon2);
  const register = new RegisterUseCase(users, audit, argon2);

  app = Fastify();
  await app.register(makeAuthRoutes({ login, refresh: refreshUC, mfa, users, jwt, loginRateMax: 1000, refreshCookieMaxAgeSec: 3600, sessions }), { prefix: "/api/v1/auth" });
  await app.register(makeAuthedRoutes({ users, mfa, changePassword, jwt, stepUp: new StepUpService(jwt, users) }), { prefix: "/api/v1" });
  await app.register(makeAdminRoutes({ audit, sessions, users, register, changePassword, mfa, roleService, jwt, refresh }), { prefix: "/api/v1/admin" });
  await app.register(makeOrganizationRoutes({ sessions, companies: new CompanyRepository(pool), units: new OrgUnitRepository(pool), users, audit, jwt, roleService }), { prefix: "/api/v1/org" });
  await app.register(makeRoleRoutes({ roles, roleService, audit, jwt, users }), { prefix: "/api/v1/roles" });
  await app.register(makeSmtpRoutes({ mailer: new MailService(settings, box, log), users, jwt, audit }), { prefix: "/api/v1/admin/smtp" });
  await app.register(makeBrandingRoutes({ settings, users, jwt, audit }), { prefix: "/api/v1/branding" });
  await app.register(makeSessionSettingsRoutes({ settings, users, jwt, audit }), { prefix: "/api/v1/admin/session-settings" });
  await app.ready();
});

after(async () => {
  if (dbSkip) return;
  await app?.close();
  const pool = getPool();
  await pool.query(`DELETE FROM users WHERE company_id = $1`, [ids.compA]);
  await pool.query(`DELETE FROM roles WHERE id = ANY($1::uuid[])`, [roleIds]);
  await pool.query(`DELETE FROM companies WHERE id = $1`, [ids.compA]);
  await closePool();
});

// ---------------------------------------------------------------- MFA ----

async function loginMfa(): Promise<string> {
  const u = await users.getById(ids.mfaUser);
  const r = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: u.username, password: PW } });
  assert.equal(r.statusCode, 200, r.body);
  const body = JSON.parse(r.body);
  assert.equal(body.mfa_required, true);
  return body.mfa_token as string;
}

test("FINAL-MFA-001: the MFA challenge token cannot be used as an access token", { skip: dbSkip }, async () => {
  const mfaToken = await loginMfa();
  const me = await app.inject({ method: "GET", url: "/api/v1/users/me", headers: bearer(mfaToken) });
  assert.equal(me.statusCode, 401, "challenge token must not open an authenticated session");
  const adminProbe = await app.inject({ method: "GET", url: "/api/v1/roles", headers: bearer(mfaToken) });
  assert.equal(adminProbe.statusCode, 401);
});

test("FINAL-MFA-002: the challenge completes with a valid code (and only at /mfa/verify)", { skip: dbSkip }, async () => {
  const mfaToken = await loginMfa();
  const ok = await app.inject({ method: "POST", url: "/api/v1/auth/mfa/verify", headers: bearer(mfaToken), payload: { code: await freshCode() } });
  assert.equal(ok.statusCode, 200, ok.body);
  const access = JSON.parse(ok.body).access_token as string;
  const me = await app.inject({ method: "GET", url: "/api/v1/users/me", headers: bearer(access) });
  assert.equal(me.statusCode, 200);
  // A real access token is not accepted as a challenge token.
  const swap = await app.inject({ method: "POST", url: "/api/v1/auth/mfa/verify", headers: bearer(access), payload: { code: "000000" } });
  assert.equal(swap.statusCode, 401);
});

test("FINAL-MFA-003: wrong MFA codes lock the account; re-login does not reset the counter", { skip: dbSkip }, async () => {
  await getPool().query(`UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = $1`, [ids.mfaUser]);
  for (let i = 0; i < 5; i++) {
    const t = await loginMfa(); // a fresh login between guesses must NOT reset the counter
    const bad = await app.inject({ method: "POST", url: "/api/v1/auth/mfa/verify", headers: bearer(t), payload: { code: "000000" } });
    assert.equal(bad.statusCode, 401);
  }
  const u = await users.getById(ids.mfaUser);
  assert.ok(u.lockedUntil && u.lockedUntil > new Date(), "account must be temporarily locked");
  const { rows } = await getPool().query(`SELECT count(*)::int AS n FROM audit_logs WHERE user_id = $1 AND details->>'reason' = 'bad_mfa_code'`, [ids.mfaUser]);
  assert.ok(rows[0].n >= 5, "MFA failures are audited");
  await getPool().query(`UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = $1`, [ids.mfaUser]);
});

// ------------------------------------------------ target privilege ceiling ----

test("FINAL-CEIL-001: company admin cannot take over a co-located super_admin", { skip: dbSkip }, async () => {
  const h = bearer(tok.adminA);
  const reset = await app.inject({ method: "POST", url: `/api/v1/admin/users/${ids.superA}/reset-password`, headers: h, payload: { password: "Att4cker-Chosen-Pw!" } });
  assert.equal(reset.statusCode, 403, reset.body);
  const mfa = await app.inject({ method: "POST", url: `/api/v1/admin/users/${ids.superA}/disable-mfa`, headers: h });
  assert.equal(mfa.statusCode, 403);
  for (const payload of [{ is_locked: true }, { is_active: false }, { email: "attacker@evil.test" }, { role: "readonly" }]) {
    const r = await app.inject({ method: "PATCH", url: `/api/v1/admin/users/${ids.superA}`, headers: h, payload });
    assert.equal(r.statusCode, 403, JSON.stringify(payload));
  }
  const del = await app.inject({ method: "DELETE", url: `/api/v1/admin/users/${ids.superA}`, headers: h });
  assert.equal(del.statusCode, 403);
  const demote = await app.inject({ method: "PUT", url: `/api/v1/org/users/${ids.superA}/assignment`, headers: h, payload: { role: "readonly" } });
  assert.equal(demote.statusCode, 403);
  const su = await users.getById(ids.superA);
  assert.equal(su.role, "super_admin");
  assert.equal(su.isActive, true);
  assert.equal(su.isLocked, false);
  const { rows } = await getPool().query(`SELECT count(*)::int AS n FROM audit_logs WHERE user_id = $1 AND action = 'permission_denied' AND resource_id = $2`, [ids.adminA, ids.superA]);
  assert.ok(rows[0].n >= 1, "denied attempts are audited");
});

test("FINAL-CEIL-002: company admin still manages ordinary users (and it is audited)", { skip: dbSkip }, async () => {
  const h = bearer(tok.adminA);
  const lock = await app.inject({ method: "PATCH", url: `/api/v1/admin/users/${ids.userA}`, headers: h, payload: { is_locked: true } });
  assert.equal(lock.statusCode, 200, lock.body);
  const unlock = await app.inject({ method: "PATCH", url: `/api/v1/admin/users/${ids.userA}`, headers: h, payload: { is_locked: false } });
  assert.equal(unlock.statusCode, 200);
  const { rows } = await getPool().query(`SELECT count(*)::int AS n FROM audit_logs WHERE user_id = $1 AND action = 'user_update' AND resource_id = $2`, [ids.adminA, ids.userA]);
  assert.ok(rows[0].n >= 2, "user administration is audited");
  const super2admin = await app.inject({ method: "PATCH", url: `/api/v1/admin/users/${ids.adminA}`, headers: bearer(tok.superA), payload: { full_name: "Admin A" } });
  assert.equal(super2admin.statusCode, 200, "super_admin keeps full control");
});

test("FINAL-CEIL-003: a users:manage helpdesk role cannot demote its company admin", { skip: dbSkip }, async () => {
  const r = await app.inject({ method: "PUT", url: `/api/v1/org/users/${ids.adminA}/assignment`, headers: bearer(tok.helpdesk), payload: { role: "readonly" } });
  assert.equal(r.statusCode, 403, r.body);
  assert.equal((await users.getById(ids.adminA)).role, "admin");
});

// ---------------------------------------------- installation-wide settings ----

test("FINAL-INST-001: company admin cannot change SMTP, branding or session policy", { skip: dbSkip }, async () => {
  const h = bearer(tok.adminA);
  assert.equal((await app.inject({ method: "PUT", url: "/api/v1/admin/smtp", headers: h, payload: { host: "attacker.example", from: "x@attacker.example" } })).statusCode, 403);
  assert.equal((await app.inject({ method: "GET", url: "/api/v1/admin/smtp", headers: h })).statusCode, 403);
  assert.equal((await app.inject({ method: "POST", url: "/api/v1/admin/smtp/test", headers: h, payload: { to: "a@b.test" } })).statusCode, 403);
  assert.equal((await app.inject({ method: "PUT", url: "/api/v1/branding", headers: h, payload: { app_name: "pwned" } })).statusCode, 403);
  assert.equal((await app.inject({ method: "PUT", url: "/api/v1/admin/session-settings", headers: h, payload: { ssh_idle_timeout_minutes: 1 } })).statusCode, 403);
  // Public branding read is unaffected.
  assert.equal((await app.inject({ method: "GET", url: "/api/v1/branding" })).statusCode, 200);
});

test("FINAL-INST-002: super_admin can manage instance settings and the change is audited", { skip: dbSkip }, async () => {
  const h = bearer(tok.superA);
  const get = await app.inject({ method: "GET", url: "/api/v1/admin/smtp", headers: h });
  assert.equal(get.statusCode, 200);
  const put = await app.inject({ method: "PUT", url: "/api/v1/admin/smtp", headers: h, payload: {} }); // no-op: no global side effects
  assert.equal(put.statusCode, 200, put.body);
  const { rows } = await getPool().query(`SELECT count(*)::int AS n FROM audit_logs WHERE user_id = $1 AND resource_type = 'smtp'`, [ids.superA]);
  assert.ok(rows[0].n >= 1);
});

test("FINAL-INST-003: admin cannot create a custom role holding settings:manage", { skip: dbSkip }, async () => {
  const r = await app.inject({ method: "POST", url: "/api/v1/roles", headers: bearer(tok.adminA), payload: { name: "fs sneaky " + Date.now(), permissions: ["settings:manage"] } });
  assert.equal(r.statusCode, 403, r.body);
});

// ------------------------------------------------------- refresh / logout ----

async function loginUserA(): Promise<{ access: string; refresh: string }> {
  const u = await users.getById(ids.userA);
  const r = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: u.username, password: PW } });
  assert.equal(r.statusCode, 200, r.body);
  const b = JSON.parse(r.body);
  return { access: b.access_token, refresh: b.refresh_token };
}

test("FINAL-REFRESH-001: concurrent refreshes of one token — exactly one succeeds", { skip: dbSkip }, async () => {
  const { refresh } = await loginUserA();
  const results = await Promise.all(Array.from({ length: 4 }, () =>
    app.inject({ method: "POST", url: "/api/v1/auth/refresh", payload: { refresh_token: refresh } })));
  const ok = results.filter((r) => r.statusCode === 200).length;
  assert.equal(ok, 1, `exactly one rotation may win, got ${results.map((r) => r.statusCode).join(",")}`);
});

test("FINAL-LOGOUTALL-001: logout-all invalidates the outstanding access token and live sessions", { skip: dbSkip }, async () => {
  const { access } = await loginUserA();
  assert.equal((await app.inject({ method: "GET", url: "/api/v1/users/me", headers: bearer(access) })).statusCode, 200);
  const out = await app.inject({ method: "POST", url: "/api/v1/auth/logout-all", headers: bearer(access) });
  assert.equal(out.statusCode, 204);
  assert.equal((await app.inject({ method: "GET", url: "/api/v1/users/me", headers: bearer(access) })).statusCode, 401);
  assert.ok(revoked.includes(ids.userA), "live remote sessions are revoked");
});
