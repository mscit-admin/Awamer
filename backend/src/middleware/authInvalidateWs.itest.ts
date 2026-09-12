/**
 * SEC-SESSION-002 (integration) — a stale access token, issued BEFORE a
 * security-sensitive change (password change, forgot-password reset, admin
 * reset, MFA replacement/disable), must NOT be able to open a NEW direct-token
 * WebSocket session (SSH / Telnet / TCP tunnel). The HTTP path was already
 * covered (AUTH-INVALIDATE-001..); this proves the WS gateways enforce the same
 * live auth_version rule via the shared `verifyCurrentAccessToken`.
 *
 * AUTH-INVALIDATE-WS-001..010 (+ VNC ticket-issuance regression). Real PostgreSQL.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import { WebSocket } from "ws";
import { v4 as uuid } from "uuid";
import { authenticator } from "otplib";
import { loadConfig } from "../config/index.js";
import { createJwt, type JwtService } from "../jwt/index.js";
import { createArgon2 } from "../crypto/argon2.js";
import { createSecretBox, resolveSecretKey } from "../crypto/secretBox.js";
import { createLogger } from "../logger/index.js";
import { UserRepository } from "../repos/userRepo.js";
import { MFADeviceRepository, RefreshRepository, AuditRepository } from "../repos/otherRepos.js";
import { AppSettingsRepository } from "../repos/appSettings.js";
import { PasswordResetRepository } from "../repos/passwordResetRepo.js";
import { ChangePasswordUseCase } from "../usecases/changePassword.js";
import { PasswordResetUseCase } from "../usecases/passwordReset.js";
import { MFAUseCase } from "../usecases/mfa.js";
import { ActiveSessionManager } from "../session/activeSessions.js";
import { makeSshGateway } from "../ssh/gateway.js";
import { makeTelnetGateway } from "../telnet/gateway.js";
import { makeWsTunnelGateway } from "../ssh/wsTunnelGateway.js";
import { makeVncGateway } from "../vnc/gateway.js";
import { getPool, closePool, dbSkip } from "../test/db.js";

const noopLog = { info() {}, warn() {}, error() {}, debug() {}, child() { return noopLog; } } as any;
const PW = "St4le-T0ken-Str0ng!";
let app: FastifyInstance, jwt: JwtService, users: UserRepository;
let changePw: ChangePasswordUseCase, resetUC: PasswordResetUseCase, mfaUC: MFAUseCase;
let resets: PasswordResetRepository, argon2: ReturnType<typeof createArgon2>;
let baseWs = "", baseHttp = "", tcpPort = 0;
let tcpServer: net.Server;

async function mkUser(): Promise<string> {
  const id = uuid();
  const hash = await argon2.hash(PW);
  await getPool().query(
    `INSERT INTO users (id,username,email,password_hash,role,is_active)
     VALUES ($1,'aws_'||substr(md5(random()::text),1,12),'aws_'||substr(md5(random()::text),1,12)||'@t.local',$2,'user',TRUE)`,
    [id, hash],
  );
  return id;
}
/** Mint an access token pinned to the account's CURRENT auth_version. */
async function tokenFor(id: string): Promise<string> {
  const u = await users.getById(id);
  return (await jwt.issuePair(id, u.role, u.authVersion)).access.token;
}
async function enrollAndActivate(id: string): Promise<void> {
  const e = await mfaUC.enroll(id, "test");
  await mfaUC.verifyAndActivate(id, e.deviceId, authenticator.generate(e.secret));
}
async function forgotReset(id: string): Promise<void> {
  const raw = "resettok_" + uuid().replace(/-/g, "");
  const { createHash } = await import("node:crypto");
  const h = createHash("sha256").update(raw).digest("hex");
  await resets.create(id, h, new Date(Date.now() + 30 * 60000));
  await resetUC.resetPassword(raw, "Forgot-Reset-Str0ng-1!");
}

/** Open a WS, send the auth frame, and report whether auth was PASSED. */
function wsTrial(path: string, query: string, tokenStr: string): Promise<{ code?: string; passedAuth: boolean }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${baseWs}${path}?${query}`);
    let settled = false;
    const done = (r: { code?: string; passedAuth: boolean }) => { if (settled) return; settled = true; try { ws.close(); } catch { /* ignore */ } resolve(r); };
    ws.on("open", () => ws.send(JSON.stringify({ type: "auth", token: tokenStr })));
    ws.on("message", (d, isBinary) => {
      if (isBinary) return done({ passedAuth: true });
      const m = JSON.parse(d.toString());
      if (m.type === "status" && m.status === "authenticating") return; // pre-auth banner
      if (m.type === "status") return done({ passedAuth: true }); // connecting/etc → past auth
      done({ code: m.code, passedAuth: false }); // error frame
    });
    ws.on("close", () => done({ passedAuth: false }));
    ws.on("error", () => done({ passedAuth: false }));
    setTimeout(() => done({ passedAuth: false }), 3000);
  });
}
const HID = "00000000-0000-0000-0000-000000000000";
const sshTrial = (t: string) => wsTrial("/api/v1/ssh/connect", `host_id=${HID}`, t);
const telnetTrial = (t: string) => wsTrial("/api/v1/telnet/connect", `host_id=${HID}`, t);
const tunnelTrial = (t: string) => wsTrial("/api/v1/tunnel/connect", `host_id=${HID}&dst_host=127.0.0.1&dst_port=${tcpPort}`, t);

before(async () => {
  if (dbSkip) return;
  const cfg = loadConfig();
  jwt = createJwt(cfg);
  argon2 = createArgon2(cfg);
  const log = createLogger(cfg);
  const pool = getPool();
  users = new UserRepository(pool);
  const refresh = new RefreshRepository(pool);
  const audit = new AuditRepository(pool);
  resets = new PasswordResetRepository(pool);
  const secretBox = createSecretBox(resolveSecretKey(cfg, noopLog));
  const active = new ActiveSessionManager({ users, log: noopLog, audit });
  changePw = new ChangePasswordUseCase(users, refresh, audit, argon2, active);
  resetUC = new PasswordResetUseCase(users, resets, refresh,
    { baseUrl: async () => "", resetTtlMinutes: async () => 30, isConfigured: async () => false, sendPasswordReset: async () => {} } as any,
    argon2, audit, noopLog, { isProd: false, publicBaseUrl: null }, active);
  mfaUC = new MFAUseCase(users, new MFADeviceRepository(pool), audit, cfg, argon2, secretBox, new AppSettingsRepository(pool), refresh, active);

  tcpServer = net.createServer((s) => s.on("data", () => {}));
  await new Promise<void>((r) => tcpServer.listen(0, "127.0.0.1", r));
  tcpPort = (tcpServer.address() as net.AddressInfo).port;

  const sessions = { register() {}, unregister() {}, revokeUser() { return 0; }, revalidateUser: async () => {}, count() { return 0; }, countForUser() { return 0; }, startPeriodic() {}, stop() {} } as never;
  const hosts = { async getById(_u: string, id: string) { return { id, name: "h", hostname: "127.0.0.1", port: tcpPort }; } };
  const history = { async start() { return 1; }, async end() {} };
  const stub = {} as never;

  app = Fastify();
  await app.register(websocket);
  await app.register(makeSshGateway({ sessions, jwt, users, hosts: hosts as never, credentials: stub, history: history as never, settings: stub, log, hostKeys: stub }), { prefix: "/api/v1/ssh" });
  await app.register(makeTelnetGateway({ sessions, jwt, users, hosts: hosts as never, history: history as never, log }), { prefix: "/api/v1/telnet" });
  await app.register(makeWsTunnelGateway({ sessions, jwt, users, hosts: hosts as never, credentials: stub, log, hostKeys: stub }), { prefix: "/api/v1/tunnel" });
  await app.register(makeVncGateway({ sessions, jwt, users, hosts: hosts as never, history: history as never, log }), { prefix: "/api/v1/vnc" });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address() as net.AddressInfo;
  baseWs = `ws://127.0.0.1:${addr.port}`;
  baseHttp = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  if (dbSkip) return;
  await app?.close();
  await new Promise<void>((r) => tcpServer.close(() => r()));
  await getPool().query(`DELETE FROM users WHERE username LIKE 'aws\\_%'`);
  await closePool();
});

test("AUTH-INVALIDATE-WS-001: old token cannot open a new SSH session after password change", { skip: dbSkip }, async () => {
  const id = await mkUser();
  const old = await tokenFor(id);
  await changePw.execute(id, PW, "New-Pass-After-1!");
  const r = await sshTrial(old);
  assert.equal(r.passedAuth, false, "stale token must be rejected");
  assert.equal(r.code, "invalid_token");
});

test("AUTH-INVALIDATE-WS-002: old token cannot open a new Telnet session after password change", { skip: dbSkip }, async () => {
  const id = await mkUser();
  const old = await tokenFor(id);
  await changePw.execute(id, PW, "New-Pass-After-2!");
  assert.equal((await telnetTrial(old)).passedAuth, false);
});

test("AUTH-INVALIDATE-WS-003: old token cannot open a new Tunnel session after password change", { skip: dbSkip }, async () => {
  const id = await mkUser();
  const old = await tokenFor(id);
  await changePw.execute(id, PW, "New-Pass-After-3!");
  assert.equal((await tunnelTrial(old)).passedAuth, false);
});

test("AUTH-INVALIDATE-WS-004: old token cannot open SSH after a forgot-password reset", { skip: dbSkip }, async () => {
  const id = await mkUser();
  const old = await tokenFor(id);
  await forgotReset(id);
  assert.equal((await sshTrial(old)).passedAuth, false);
});

test("AUTH-INVALIDATE-WS-005: old token cannot open SSH after an admin password reset", { skip: dbSkip }, async () => {
  const id = await mkUser();
  const old = await tokenFor(id);
  await changePw.adminReset(uuid(), id, "Admin-Reset-Str0ng-1!");
  assert.equal((await sshTrial(old)).passedAuth, false);
});

test("AUTH-INVALIDATE-WS-006: old token cannot open SSH after MFA replacement", { skip: dbSkip }, async () => {
  const id = await mkUser();
  const old = await tokenFor(id); // minted before MFA activation
  await enrollAndActivate(id);    // activation bumps auth_version
  assert.equal((await sshTrial(old)).passedAuth, false);
});

test("AUTH-INVALIDATE-WS-007: old token cannot open SSH after MFA disable", { skip: dbSkip }, async () => {
  const id = await mkUser();
  await enrollAndActivate(id);
  const old = await tokenFor(id); // fresh token AFTER enrollment
  await mfaUC.disable(id, PW);     // disable bumps auth_version again
  assert.equal((await sshTrial(old)).passedAuth, false);
});

test("AUTH-INVALIDATE-WS-008: a fresh token after a password change opens SSH normally", { skip: dbSkip }, async () => {
  const id = await mkUser();
  await changePw.execute(id, PW, "Fresh-Works-Pass-8!");
  const fresh = await tokenFor(id); // minted with the NEW auth_version
  const r = await sshTrial(fresh);
  assert.notEqual(r.code, "invalid_token", "fresh token passes auth (a later credential error is fine)");
  assert.notEqual(r.code, "forbidden");
});

test("AUTH-INVALIDATE-WS-009: a fresh token after an MFA change works normally", { skip: dbSkip }, async () => {
  const id = await mkUser();
  await enrollAndActivate(id);
  const fresh = await tokenFor(id); // minted with the post-activation auth_version
  const r = await sshTrial(fresh);
  assert.notEqual(r.code, "invalid_token");
  assert.notEqual(r.code, "forbidden");
});

test("AUTH-INVALIDATE-WS-010: an unrelated user's token is unaffected by another user's change", { skip: dbSkip }, async () => {
  const a = await mkUser();
  const b = await mkUser();
  const tokenB = await tokenFor(b);
  await changePw.execute(a, PW, "Only-A-Changes-WS-1!");
  const r = await sshTrial(tokenB);
  assert.notEqual(r.code, "invalid_token", "user B's token still passes auth after user A's change");
  assert.notEqual(r.code, "forbidden");
});

test("AUTH-INVALIDATE-WS-VNC: stale token cannot mint a VNC ticket; a fresh one can", { skip: dbSkip }, async () => {
  const id = await mkUser();
  const old = await tokenFor(id);
  await changePw.execute(id, PW, "Vnc-Regression-Pass-1!");
  const denied = await fetch(`${baseHttp}/api/v1/vnc/ticket`, {
    method: "POST",
    headers: { authorization: `Bearer ${old}`, "content-type": "application/json" },
    body: JSON.stringify({ host_id: HID }),
  });
  assert.equal(denied.status, 401, "stale token rejected before a ticket is issued");
  const fresh = await tokenFor(id);
  const ok = await fetch(`${baseHttp}/api/v1/vnc/ticket`, {
    method: "POST",
    headers: { authorization: `Bearer ${fresh}`, "content-type": "application/json" },
    body: JSON.stringify({ host_id: HID }),
  });
  assert.equal(ok.status, 200, "fresh token can mint a ticket");
});
