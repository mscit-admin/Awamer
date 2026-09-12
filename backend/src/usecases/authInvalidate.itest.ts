/**
 * SEC-SESSION-001 (integration) — a security-sensitive credential change must
 * invalidate ALL prior authenticated state: old access tokens (auth_version),
 * refresh sessions, and live SSH/Telnet/Tunnel/VNC sessions. Real PostgreSQL.
 * AUTH-INVALIDATE-001..015.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";
import { v4 as uuid } from "uuid";
import { authenticator } from "otplib";
import { loadConfig } from "../config/index.js";
import { createJwt, type JwtService } from "../jwt/index.js";
import { createArgon2 } from "../crypto/argon2.js";
import { UserRepository } from "../repos/userRepo.js";
import { MFADeviceRepository, RefreshRepository, AuditRepository } from "../repos/otherRepos.js";
import { AppSettingsRepository } from "../repos/appSettings.js";
import { ChangePasswordUseCase } from "./changePassword.js";
import { PasswordResetUseCase } from "./passwordReset.js";
import { PasswordResetRepository } from "../repos/passwordResetRepo.js";
import { MFAUseCase } from "./mfa.js";
import { ActiveSessionManager, type ActiveRemoteSession, type SessionKind } from "../session/activeSessions.js";
import { makeAuthMiddleware } from "../middleware/auth.js";
import { getPool, closePool, dbSkip } from "../test/db.js";

const noopLog = { info() {}, warn() {}, error() {}, debug() {}, child() { return noopLog; } } as any;

let app: FastifyInstance;
let jwt: JwtService;
let users: UserRepository;
let refresh: RefreshRepository;
let mfaDevices: MFADeviceRepository;
let active: ActiveSessionManager;
let changePw: ChangePasswordUseCase;
let resetUC: PasswordResetUseCase;
let mfaUC: MFAUseCase;
let argon2: ReturnType<typeof createArgon2>;
let resets: PasswordResetRepository;
const PW = "Sup3r-Str0ng-Pass!";
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

async function mkUser(pw = PW): Promise<string> {
  const id = uuid();
  const hash = await argon2.hash(pw);
  await getPool().query(
    `INSERT INTO users (id,username,email,password_hash,role,is_active)
     VALUES ($1,'ai_'||substr(md5(random()::text),1,12),'ai_'||substr(md5(random()::text),1,12)||'@t.local',$2,'user',TRUE)`,
    [id, hash],
  );
  return id;
}
async function tokenFor(id: string): Promise<string> {
  const u = await users.getById(id);
  return (await jwt.issuePair(id, u.role, u.authVersion)).access.token;
}
function fakeSession(userId: string, kind: SessionKind): { s: ActiveRemoteSession; closed: () => boolean } {
  let closedFlag = false;
  const s: ActiveRemoteSession = {
    sessionId: `${userId}:${kind}:${Math.random().toString(36).slice(2)}`,
    userId, kind, requiredPermission: "sessions:connect",
    close: () => { closedFlag = true; },
  };
  return { s, closed: () => closedFlag };
}

before(async () => {
  if (dbSkip) return;
  const cfg = loadConfig();
  jwt = createJwt(cfg);
  argon2 = createArgon2(cfg);
  const pool = getPool();
  users = new UserRepository(pool);
  refresh = new RefreshRepository(pool);
  mfaDevices = new MFADeviceRepository(pool);
  resets = new PasswordResetRepository(pool);
  const audit = new AuditRepository(pool);
  const settings = new AppSettingsRepository(pool);
  active = new ActiveSessionManager({ users, log: noopLog, audit });
  changePw = new ChangePasswordUseCase(users, refresh, audit, argon2, active);
  resetUC = new PasswordResetUseCase(users, resets, refresh,
    { baseUrl: async () => "", resetTtlMinutes: async () => 30, isConfigured: async () => false, sendPasswordReset: async () => {} } as any,
    argon2, audit, noopLog, { isProd: false, publicBaseUrl: null }, active);
  mfaUC = new MFAUseCase(users, mfaDevices, audit, cfg, argon2, settings, refresh, active);

  app = Fastify();
  await app.register(async (a) => {
    a.addHook("preHandler", makeAuthMiddleware(jwt, users));
    a.get("/priv", async () => ({ ok: true }));
  }, { prefix: "/api/v1/t" });
  await app.ready();
});

after(async () => {
  if (dbSkip) return;
  await app.close();
  await getPool().query(`DELETE FROM users WHERE username LIKE 'ai\\_%'`);
  await closePool();
});

test("AUTH-INVALIDATE-001: password change invalidates the old access token", { skip: dbSkip }, async () => {
  const id = await mkUser();
  const old = await tokenFor(id);
  assert.equal((await app.inject({ method: "GET", url: "/api/v1/t/priv", headers: bearer(old) })).statusCode, 200);
  await changePw.execute(id, PW, "An0ther-Str0ng-Pass!");
  const res = await app.inject({ method: "GET", url: "/api/v1/t/priv", headers: bearer(old) });
  assert.equal(res.statusCode, 401);
  assert.match(res.body, /session_invalidated/);
});

test("AUTH-INVALIDATE-002: forgot-password reset invalidates the old access token", { skip: dbSkip }, async () => {
  const id = await mkUser();
  const old = await tokenFor(id);
  // create a reset token directly, then consume it
  const raw = "resettok_" + uuid().replace(/-/g, "");
  const { createHash } = await import("node:crypto");
  const h = createHash("sha256").update(raw).digest("hex");
  await resets.create(id, h, new Date(Date.now() + 30 * 60000));
  await resetUC.resetPassword(raw, "Reset-Str0ng-Pass!");
  assert.equal((await app.inject({ method: "GET", url: "/api/v1/t/priv", headers: bearer(old) })).statusCode, 401);
});

test("AUTH-INVALIDATE-003: admin reset invalidates the old access token", { skip: dbSkip }, async () => {
  const id = await mkUser();
  const old = await tokenFor(id);
  await changePw.adminReset(uuid(), id, "Admin-Reset-Pass1!");
  assert.equal((await app.inject({ method: "GET", url: "/api/v1/t/priv", headers: bearer(old) })).statusCode, 401);
});

async function enrollAndActivate(id: string): Promise<string> {
  const e = await mfaUC.enroll(id, "test");
  const code = authenticator.generate(e.secret);
  await mfaUC.verifyAndActivate(id, e.deviceId, code);
  return e.secret;
}

test("AUTH-INVALIDATE-004: MFA disable invalidates the old access token", { skip: dbSkip }, async () => {
  const id = await mkUser();
  await enrollAndActivate(id);
  const old = await tokenFor(id); // fresh token AFTER enrollment
  await mfaUC.disable(id, PW);
  assert.equal((await app.inject({ method: "GET", url: "/api/v1/t/priv", headers: bearer(old) })).statusCode, 401);
});

test("AUTH-INVALIDATE-005: MFA replacement/activation invalidates the old access token", { skip: dbSkip }, async () => {
  const id = await mkUser();
  const old = await tokenFor(id);
  await enrollAndActivate(id); // activation bumps auth_version
  assert.equal((await app.inject({ method: "GET", url: "/api/v1/t/priv", headers: bearer(old) })).statusCode, 401);
});

test("AUTH-INVALIDATE-006: refresh sessions revoked after password change", { skip: dbSkip }, async () => {
  const id = await mkUser();
  await refresh.insert({ jti: uuid(), userId: id, expiresAt: new Date(Date.now() + 3600_000) });
  await changePw.execute(id, PW, "Refresh-Rev-Pass1!");
  const { rows } = await getPool().query<{ n: string }>(
    `SELECT COUNT(*)::text n FROM refresh_sessions WHERE user_id=$1 AND revoked_at IS NULL`, [id]);
  assert.equal(Number(rows[0]!.n), 0);
});

test("AUTH-INVALIDATE-007: refresh sessions revoked after MFA change", { skip: dbSkip }, async () => {
  const id = await mkUser();
  await refresh.insert({ jti: uuid(), userId: id, expiresAt: new Date(Date.now() + 3600_000) });
  await enrollAndActivate(id);
  const { rows } = await getPool().query<{ n: string }>(
    `SELECT COUNT(*)::text n FROM refresh_sessions WHERE user_id=$1 AND revoked_at IS NULL`, [id]);
  assert.equal(Number(rows[0]!.n), 0);
});

test("AUTH-INVALIDATE-008..011: SSH/Telnet/Tunnel/VNC closed after password change", { skip: dbSkip }, async () => {
  const id = await mkUser();
  const s = (["ssh", "telnet", "tunnel", "vnc"] as SessionKind[]).map((k) => fakeSession(id, k));
  s.forEach((x) => active.register(x.s));
  await changePw.execute(id, PW, "Kill-Sessions-Pass1!");
  for (const x of s) assert.ok(x.closed(), `${x.s.kind} closed`);
});

test("AUTH-INVALIDATE-012: SSH closed after MFA security change", { skip: dbSkip }, async () => {
  const id = await mkUser();
  const ssh = fakeSession(id, "ssh");
  active.register(ssh.s);
  await enrollAndActivate(id);
  assert.ok(ssh.closed());
});

test("AUTH-INVALIDATE-013: another user's sessions are unaffected", { skip: dbSkip }, async () => {
  const a = await mkUser();
  const b = await mkUser();
  const bs = fakeSession(b, "ssh");
  active.register(bs.s);
  await changePw.execute(a, PW, "Only-A-Changes-1!");
  assert.equal(bs.closed(), false, "user B session must stay open");
});

test("AUTH-INVALIDATE-014: a new login/token after the change works", { skip: dbSkip }, async () => {
  const id = await mkUser();
  await changePw.execute(id, PW, "New-Login-Works-1!");
  const fresh = await tokenFor(id); // minted with the new auth_version
  assert.equal((await app.inject({ method: "GET", url: "/api/v1/t/priv", headers: bearer(fresh) })).statusCode, 200);
});

test("AUTH-INVALIDATE-015: auth_version cannot be downgraded by client input", { skip: dbSkip }, async () => {
  const id = await mkUser();
  await changePw.execute(id, PW, "Downgrade-Test-1!"); // av -> 2
  // A client-forged token claiming av=1 with a bad signature must be rejected.
  const [h, p] = (await tokenFor(id)).split(".");
  const forged = `${h}.${p}.invalidsignature`;
  assert.equal((await app.inject({ method: "GET", url: "/api/v1/t/priv", headers: bearer(forged) })).statusCode, 401);
});
