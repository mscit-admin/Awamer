/**
 * SEC-PW-TEMP-001 + SEC-PW-POLICY-001 (integration, real PostgreSQL + real routes).
 *
 *   TEMP-PW-001 an admin-created account must replace its password before anything else
 *   TEMP-PW-002 changing it lifts the restriction (and needs a fresh sign-in)
 *   TEMP-PW-003 an admin reset makes the password temporary again
 *   TEMP-PW-004 an unused temporary password expires (only after the password verified)
 *   TEMP-PW-005 WebSocket entry points refuse a temporary-password account
 *   TEMP-PW-006 the reset link sets the user's own password and clears the flag
 *   TEMP-PW-007 password first, then MFA enrollment, for a privileged role
 *   RESET-LINK-001..003 admin "send reset link": no SMTP → 409; sent + audited; tenant-scoped
 *   PW-POLICY-IT-001..002 the policy applies to admin create and self change
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";
import { createHash, randomUUID } from "node:crypto";
import { loadConfig } from "../config/index.js";
import { createJwt, type JwtService } from "../jwt/index.js";
import { createArgon2 } from "../crypto/argon2.js";
import { createSecretBox, resolveSecretKey } from "../crypto/secretBox.js";
import { RoleRepository } from "../repos/roleRepo.js";
import { RoleService } from "../domain/roleService.js";
import { UserRepository } from "../repos/userRepo.js";
import { RefreshRepository, AuditRepository, MFADeviceRepository } from "../repos/otherRepos.js";
import { AppSettingsRepository } from "../repos/appSettings.js";
import { PasswordResetRepository } from "../repos/passwordResetRepo.js";
import { RegisterUseCase } from "./register.js";
import { ChangePasswordUseCase } from "./changePassword.js";
import { MFAUseCase } from "./mfa.js";
import { LoginUseCase } from "./login.js";
import { RefreshUseCase } from "./refresh.js";
import { StepUpService } from "./stepUp.js";
import { PasswordResetUseCase } from "./passwordReset.js";
import { makeAuthRoutes } from "../routes/auth.js";
import { makeAuthedRoutes } from "../routes/users.js";
import { makeAdminRoutes } from "../routes/admin.js";
import { makeAuthMiddleware, verifyCurrentAccessToken, AuthStateError } from "../middleware/auth.js";
import { DEFAULT_MFA_REQUIRED_ROLES, setMfaRequiredRoles } from "../domain/mfaPolicy.js";
import { getPool, closePool, dbSkip } from "../test/db.js";

const noopLog = { info() {}, warn() {}, error() {}, debug() {} } as never;
const ADMIN_PW = "Temp-Adm1n-Passphrase";
let app: FastifyInstance, jwt: JwtService, users: UserRepository, resets: PasswordResetRepository;
let resetUC: PasswordResetUseCase;
const ids = { compA: "", compB: "", adminA: "", adminB: "" };
const sent: { email: string }[] = [];
let smtpConfigured = false;

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const tokenFor = async (id: string) => {
  const u = await users.getById(id);
  return (await jwt.issuePair(id, u.role, u.authVersion)).access.token;
};
const req = (method: "GET" | "POST", url: string, tok?: string, body?: Record<string, unknown>) =>
  app.inject({ method, url, headers: tok ? bearer(tok) : {}, ...(body ? { payload: body } : {}) });
const uname = () => "tp_" + randomUUID().slice(0, 10).replace(/-/g, "");

async function mkCompany(name: string) {
  const { rows } = await getPool().query<{ id: string }>(`INSERT INTO companies (id, name) VALUES (gen_random_uuid(), $1) RETURNING id`, [name]);
  return rows[0]!.id;
}
/** An admin with an ordinary (non-temporary) password, inserted directly. */
async function mkAdmin(companyId: string, hash: string) {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO users (id, username, email, password_hash, role, company_id, is_active, mfa_enabled)
     VALUES (gen_random_uuid(), $1, $1||'@t.local', $2, 'admin', $3, TRUE, TRUE) RETURNING id`, [uname(), hash, companyId]);
  return rows[0]!.id;
}
/** Create a user through the REAL admin API (so the password is temporary). */
async function adminCreates(password: string, role = "user") {
  const username = uname();
  const res = await req("POST", "/api/v1/admin/users", await tokenFor(ids.adminA), { username, email: `${username}@t.local`, password, role });
  return { res, username };
}
async function login(username: string, password: string) {
  return req("POST", "/api/v1/auth/login", undefined, { username, password });
}

before(async () => {
  if (dbSkip) return;
  const cfg = loadConfig();
  const pool = getPool();
  jwt = createJwt(cfg);
  const argon2 = createArgon2(cfg);
  const roles = new RoleRepository(pool);
  const roleService = new RoleService(roles);
  await roleService.syncBuiltins();
  await roleService.reload();
  users = new UserRepository(pool);
  const audit = new AuditRepository(pool);
  const refresh = new RefreshRepository(pool);
  const settings = new AppSettingsRepository(pool);
  resets = new PasswordResetRepository(pool);
  const box = createSecretBox(resolveSecretKey(cfg, noopLog));
  const mfa = new MFAUseCase(users, new MFADeviceRepository(pool), audit, cfg, argon2, box, settings, refresh);
  const changePassword = new ChangePasswordUseCase(users, refresh, audit, argon2, undefined, 3600);
  const register = new RegisterUseCase(users, audit, argon2, 3600);
  const login = new LoginUseCase(users, refresh, audit, jwt, argon2, cfg, noopLog);
  const refreshUC = new RefreshUseCase(users, refresh, audit, jwt, noopLog);
  const mailer = {
    async isConfigured() { return smtpConfigured; },
    async baseUrl() { return "http://localhost:1420"; },
    async resetTtlMinutes() { return 30; },
    async sendPasswordReset(email: string) { sent.push({ email }); },
  } as never;
  resetUC = new PasswordResetUseCase(users, resets, refresh, mailer, argon2, audit, noopLog, { isProd: false, publicBaseUrl: null });
  const sessions = {
    register() {}, unregister() {}, revokeUser() { return 0; }, revalidateUser: async () => {},
    count() { return 0; }, countForUser() { return 0; }, startPeriodic() {}, stop() {},
  } as never;

  ids.compA = await mkCompany("TEMP A");
  ids.compB = await mkCompany("TEMP B");
  const hash = await argon2.hash(ADMIN_PW);
  ids.adminA = await mkAdmin(ids.compA, hash);
  ids.adminB = await mkAdmin(ids.compB, hash);

  app = Fastify();
  await app.register(makeAuthRoutes({ login, refresh: refreshUC, mfa, users, jwt, loginRateMax: 1000, refreshCookieMaxAgeSec: 3600, sessions }), { prefix: "/api/v1/auth" });
  await app.register(makeAuthedRoutes({ users, mfa, changePassword, jwt, stepUp: new StepUpService(jwt, users), audit }), { prefix: "/api/v1" });
  await app.register(makeAdminRoutes({ audit, sessions, users, register, changePassword, mfa, roleService, jwt, refresh, passwordReset: resetUC }), { prefix: "/api/v1/admin" });
  app.get("/api/v1/hosts", { preHandler: makeAuthMiddleware(jwt, users) }, async () => ({ data: [] }));
  await app.ready();
});
beforeEach(() => { setMfaRequiredRoles([]); sent.length = 0; smtpConfigured = false; });
after(async () => {
  if (dbSkip) return;
  await app.close();
  await getPool().query(`DELETE FROM users WHERE username LIKE 'tp\\_%'`);
  await getPool().query(`DELETE FROM companies WHERE name IN ('TEMP A', 'TEMP B')`);
  await closePool();
});

test("TEMP-PW-001: an admin-created account must replace its password before anything else", { skip: dbSkip }, async () => {
  const { res, username } = await adminCreates("Initial-Temp-Passphrase");
  assert.equal(res.statusCode, 201, res.body);
  assert.equal(JSON.parse(res.body).password_change_required, true);
  const lg = await login(username, "Initial-Temp-Passphrase");
  assert.equal(lg.statusCode, 200, lg.body);
  const t = JSON.parse(lg.body).access_token;
  assert.equal(JSON.parse(lg.body).user.password_change_required, true);
  const hosts = await req("GET", "/api/v1/hosts", t);
  assert.equal(hosts.statusCode, 403);
  assert.equal(JSON.parse(hosts.body).error.code, "password_change_required");
  assert.equal((await req("GET", "/api/v1/users/me", t)).statusCode, 200);
  // even MFA enrollment waits until the password is the user's own
  assert.equal(JSON.parse((await req("POST", "/api/v1/auth/step-up", t, { password: "Initial-Temp-Passphrase" })).body).error.code, "password_change_required");
});

test("TEMP-PW-002: changing it lifts the restriction (after a fresh sign-in)", { skip: dbSkip }, async () => {
  const { username } = await adminCreates("Initial-Temp-Passphrase");
  const t = JSON.parse((await login(username, "Initial-Temp-Passphrase")).body).access_token;
  const ch = await req("POST", "/api/v1/auth/change-password", t, { current_password: "Initial-Temp-Passphrase", new_password: "my own quiet harbour lights" });
  assert.equal(ch.statusCode, 200, ch.body);
  const u = await users.getByUsername(username);
  assert.equal(u.passwordMustChange, false);
  assert.equal(u.tempPasswordExpiresAt, null);
  const t2 = JSON.parse((await login(username, "my own quiet harbour lights")).body).access_token;
  assert.equal((await req("GET", "/api/v1/hosts", t2)).statusCode, 200);
});

test("TEMP-PW-003: an admin reset makes the password temporary again and ends sessions", { skip: dbSkip }, async () => {
  const { username } = await adminCreates("Initial-Temp-Passphrase");
  const id = (await users.getByUsername(username)).id;
  await getPool().query(`UPDATE users SET password_must_change = FALSE, temp_password_expires_at = NULL WHERE id = $1`, [id]);
  const before = await tokenFor(id);
  assert.equal((await req("GET", "/api/v1/hosts", before)).statusCode, 200);
  const r = await req("POST", `/api/v1/admin/users/${id}/reset-password`, await tokenFor(ids.adminA), { password: "Admin-Chosen-Passphrase" });
  assert.equal(r.statusCode, 200, r.body);
  const u = await users.getById(id);
  assert.equal(u.passwordMustChange, true);
  assert.ok(u.tempPasswordExpiresAt && u.tempPasswordExpiresAt.getTime() > Date.now());
  assert.equal((await req("GET", "/api/v1/hosts", before)).statusCode, 401, "old session ended");
});

test("TEMP-PW-004: an unused temporary password expires — revealed only with the right password", { skip: dbSkip }, async () => {
  const { username } = await adminCreates("Initial-Temp-Passphrase");
  await getPool().query(`UPDATE users SET temp_password_expires_at = NOW() - interval '1 minute' WHERE username = $1`, [username]);
  const wrong = await login(username, "Wrong-Guess-Passphrase");
  assert.equal(wrong.statusCode, 401);
  assert.equal(JSON.parse(wrong.body).error.code, "invalid_credentials");
  const right = await login(username, "Initial-Temp-Passphrase");
  assert.equal(right.statusCode, 403, right.body);
  assert.equal(JSON.parse(right.body).error.code, "temporary_password_expired");
});

test("TEMP-PW-005: WebSocket entry points refuse a temporary-password account", { skip: dbSkip }, async () => {
  const { username } = await adminCreates("Initial-Temp-Passphrase");
  const t = await tokenFor((await users.getByUsername(username)).id);
  await assert.rejects(() => verifyCurrentAccessToken(jwt, users, t),
    (e: unknown) => e instanceof AuthStateError && e.code === "password_change_required");
});

test("TEMP-PW-006: the reset link sets the user's own password and clears the flag", { skip: dbSkip }, async () => {
  const { username } = await adminCreates("Initial-Temp-Passphrase");
  const id = (await users.getByUsername(username)).id;
  const raw = "tok_" + randomUUID().replace(/-/g, "");
  await resets.create(id, createHash("sha256").update(raw).digest("hex"), new Date(Date.now() + 600_000));
  await resetUC.resetPassword(raw, "chosen by me via the link");
  assert.equal((await users.getById(id)).passwordMustChange, false);
});

test("TEMP-PW-007: a privileged role changes the password first, then enrolls MFA", { skip: dbSkip }, async () => {
  setMfaRequiredRoles(DEFAULT_MFA_REQUIRED_ROLES);
  const { res, username } = await adminCreates("Initial-Temp-Passphrase", "admin");
  assert.equal(res.statusCode, 201, res.body);
  let t = JSON.parse((await login(username, "Initial-Temp-Passphrase")).body).access_token;
  assert.equal(JSON.parse((await req("GET", "/api/v1/hosts", t)).body).error.code, "password_change_required");
  await req("POST", "/api/v1/auth/change-password", t, { current_password: "Initial-Temp-Passphrase", new_password: "my own quiet harbour lights" });
  t = JSON.parse((await login(username, "my own quiet harbour lights")).body).access_token;
  assert.equal(JSON.parse((await req("GET", "/api/v1/hosts", t)).body).error.code, "mfa_enrollment_required");
});

test("RESET-LINK-001: without SMTP the admin is told to configure it (409)", { skip: dbSkip }, async () => {
  const { username } = await adminCreates("Initial-Temp-Passphrase");
  const id = (await users.getByUsername(username)).id;
  const r = await req("POST", `/api/v1/admin/users/${id}/send-reset-link`, await tokenFor(ids.adminA));
  assert.equal(r.statusCode, 409);
  assert.equal(JSON.parse(r.body).error.code, "smtp_not_configured");
});

test("RESET-LINK-002: with SMTP the link goes to the user's email and the action is audited", { skip: dbSkip }, async () => {
  smtpConfigured = true;
  const { username } = await adminCreates("Initial-Temp-Passphrase");
  const id = (await users.getByUsername(username)).id;
  const r = await req("POST", `/api/v1/admin/users/${id}/send-reset-link`, await tokenFor(ids.adminA));
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(sent, [{ email: `${username}@t.local` }]);
  const { rows } = await getPool().query(
    `SELECT 1 FROM audit_logs WHERE user_id = $1 AND resource_id = $2 AND details->>'admin_reset_link' = 'true'`, [ids.adminA, id]);
  assert.equal(rows.length, 1);
});

test("RESET-LINK-003: an admin of another company cannot trigger it (404)", { skip: dbSkip }, async () => {
  smtpConfigured = true;
  const { username } = await adminCreates("Initial-Temp-Passphrase");
  const id = (await users.getByUsername(username)).id;
  const r = await req("POST", `/api/v1/admin/users/${id}/send-reset-link`, await tokenFor(ids.adminB));
  assert.equal(r.statusCode, 404);
  assert.equal(sent.length, 0);
});

test("PW-POLICY-IT-001: admin create refuses a common password and accepts a plain passphrase", { skip: dbSkip }, async () => {
  const bad = await adminCreates("qwerty123456");
  assert.equal(bad.res.statusCode, 400);
  assert.match(JSON.parse(bad.res.body).error.message, /too common/);
  const ok = await adminCreates("lowercase words only here");
  assert.equal(ok.res.statusCode, 201, ok.res.body);
});

test("PW-POLICY-IT-002: self change refuses a password containing the username", { skip: dbSkip }, async () => {
  const { username } = await adminCreates("Initial-Temp-Passphrase");
  const t = JSON.parse((await login(username, "Initial-Temp-Passphrase")).body).access_token;
  const r = await req("POST", "/api/v1/auth/change-password", t, { current_password: "Initial-Temp-Passphrase", new_password: `${username}-is-my-password` });
  assert.equal(r.statusCode, 422, r.body);
  assert.match(JSON.parse(r.body).error.message, /username/);
});
