import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../config/index.js";
import { createLogger } from "../logger/index.js";
import { createArgon2 } from "../crypto/argon2.js";
import { createJwt } from "../jwt/index.js";
import { UserRepository } from "../repos/userRepo.js";
import { RefreshRepository, AuditRepository } from "../repos/otherRepos.js";
import { LoginUseCase } from "./login.js";
import { isAccountLocked } from "../domain/index.js";
import { getPool, closePool, deleteUser, dbSkip } from "../test/db.js";

const created: string[] = [];
after(async () => {
  for (const id of created) await deleteUser(id).catch(() => {});
  await closePool();
});

test("login: full flow — success, temporary lockout at threshold, expiry, reset", { skip: dbSkip }, async () => {
  // Small threshold to keep the argon2 work light.
  process.env.ACCOUNT_LOCKOUT_THRESHOLD = "2";
  process.env.ACCOUNT_LOCKOUT_MINUTES = "15";

  const cfg = loadConfig();
  const log = createLogger(cfg);
  const pool = getPool();
  const argon2 = createArgon2(cfg);
  const jwt = createJwt(cfg);
  const users = new UserRepository(pool);
  const uc = new LoginUseCase(users, new RefreshRepository(pool), new AuditRepository(pool), jwt, argon2, cfg, log);

  const id = randomUUID();
  created.push(id);
  const username = "loginit_" + id.slice(0, 8);
  await users.create({ id, username, email: `${username}@test.local`, passwordHash: await argon2.hash("CorrectPass!123"), role: "user" });

  // 1) Correct password → tokens, no MFA.
  const ok = await uc.execute({ username, password: "CorrectPass!123", ip: "1.1.1.1", ua: "t" });
  assert.equal(ok.mfaRequired, false);
  assert.ok(ok.accessToken && ok.refreshToken);

  // 2) Two wrong attempts reach the threshold and temporarily lock.
  await assert.rejects(uc.execute({ username, password: "wrong", ip: null, ua: null }));
  await assert.rejects(uc.execute({ username, password: "wrong", ip: null, ua: null }));
  let u = await users.getByUsername(username);
  assert.ok(u.lockedUntil && u.lockedUntil.getTime() > Date.now(), "should be temporarily locked");
  assert.equal(isAccountLocked(u, new Date()), true);

  // 3) Even the correct password is refused while locked.
  await assert.rejects(uc.execute({ username, password: "CorrectPass!123", ip: null, ua: null }));

  // 4) Lock expires → correct password works again and clears the lock + counter.
  await pool.query(`UPDATE users SET locked_until = NOW() - interval '1 minute' WHERE id = $1`, [id]);
  const ok2 = await uc.execute({ username, password: "CorrectPass!123", ip: null, ua: null });
  assert.ok(ok2.accessToken);
  u = await users.getByUsername(username);
  assert.equal(u.lockedUntil, null, "successful login clears the temporary lock");
  assert.equal(u.failedAttempts, 0, "successful login resets the failed-attempt counter");
});
