/**
 * SEC-017 — logout revokes the server-side refresh session (integration, real PG).
 * Covers TEST-AUTH-LOGOUT-001..004. Skips without DATABASE_URL.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../config/index.js";
import { createLogger } from "../logger/index.js";
import { createJwt, type JwtService } from "../jwt/index.js";
import { UserRepository } from "../repos/userRepo.js";
import { RefreshRepository, AuditRepository } from "../repos/otherRepos.js";
import { RefreshUseCase } from "./refresh.js";
import { getPool, closePool, deleteUser, dbSkip } from "../test/db.js";

let uc: RefreshUseCase;
let jwt: JwtService;
let refreshRepo: RefreshRepository;
let userId = "";
const denied = (e: unknown) => (e as { code?: string }).code === "refresh_reuse";

async function newSession(): Promise<{ token: string }> {
  const { refresh } = await jwt.issuePair(userId, "user");
  await refreshRepo.insert({ jti: refresh.jti, userId, expiresAt: refresh.expiresAt });
  return { token: refresh.token };
}

before(async () => {
  if (dbSkip) return;
  const cfg = loadConfig();
  const log = createLogger(cfg);
  const pool = getPool();
  jwt = createJwt(cfg);
  const users = new UserRepository(pool);
  refreshRepo = new RefreshRepository(pool);
  uc = new RefreshUseCase(users, refreshRepo, new AuditRepository(pool), jwt, log);
  userId = randomUUID();
  await users.create({ id: userId, username: "lo_" + userId.slice(0, 8), email: `lo_${userId.slice(0, 8)}@t.local`, passwordHash: "x", role: "user" });
});

after(async () => {
  if (dbSkip) return;
  await deleteUser(userId).catch(() => {});
  await closePool();
});

test("TEST-AUTH-LOGOUT-001: after logout the refresh token is denied", { skip: dbSkip }, async () => {
  const s = await newSession();
  await uc.logout(s.token, null, null);
  await assert.rejects(() => uc.execute(s.token, null, null), denied);
});

test("TEST-AUTH-LOGOUT-002: a copy of the refresh token taken before logout is also denied", { skip: dbSkip }, async () => {
  const s = await newSession();
  const stolenCopy = s.token; // same bearer captured by an attacker
  await uc.logout(s.token, null, null);
  await assert.rejects(() => uc.execute(stolenCopy, null, null), denied);
});

test("TEST-AUTH-LOGOUT-003: logging out session A does not affect session B", { skip: dbSkip }, async () => {
  const a = await newSession();
  const b = await newSession();
  await uc.logout(a.token, null, null);
  await assert.rejects(() => uc.execute(a.token, null, null), denied);
  await assert.doesNotReject(() => uc.execute(b.token, null, null), "session B still refreshes");
});

test("TEST-AUTH-LOGOUT-004: logout-all revokes every session", { skip: dbSkip }, async () => {
  const a = await newSession();
  const b = await newSession();
  await uc.logoutAll(userId, null, null);
  await assert.rejects(() => uc.execute(a.token, null, null), denied);
  await assert.rejects(() => uc.execute(b.token, null, null), denied);
});
