/**
 * SEC-019 — browser cookie refresh flow via app.inject (integration, real PG).
 * Verifies web-mode refresh uses the HttpOnly cookie and withholds the token
 * from the body, while Tauri (no header) keeps the body-token flow; and that
 * logout clears the cookie and revokes the session. Skips without DATABASE_URL.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../config/index.js";
import { createLogger } from "../logger/index.js";
import { createJwt, type JwtService } from "../jwt/index.js";
import { UserRepository } from "../repos/userRepo.js";
import { RefreshRepository, AuditRepository } from "../repos/otherRepos.js";
import { RefreshUseCase } from "../usecases/refresh.js";
import { makeAuthRoutes } from "./auth.js";
import { REFRESH_COOKIE } from "./authCookies.js";
import { getPool, closePool, deleteUser, dbSkip } from "../test/db.js";

let app: FastifyInstance;
let jwt: JwtService;
let refreshRepo: RefreshRepository;
let userId = "";

async function session(): Promise<string> {
  const { refresh } = await jwt.issuePair(userId, "user");
  await refreshRepo.insert({ jti: refresh.jti, userId, expiresAt: refresh.expiresAt });
  return refresh.token;
}
const cookieVal = (setCookie: string | string[] | undefined): string => {
  const s = Array.isArray(setCookie) ? setCookie[0]! : (setCookie ?? "");
  return s.split(";")[0]!.split("=").slice(1).join("=");
};

before(async () => {
  if (dbSkip) return;
  const cfg = loadConfig();
  const pool = getPool();
  jwt = createJwt(cfg);
  const users = new UserRepository(pool);
  refreshRepo = new RefreshRepository(pool);
  const uc = new RefreshUseCase(users, refreshRepo, new AuditRepository(pool), jwt, createLogger(cfg));
  userId = randomUUID();
  await users.create({ id: userId, username: "ck_" + userId.slice(0, 8), email: `ck_${userId.slice(0, 8)}@t.local`, passwordHash: "x", role: "user" });

  app = Fastify();
  await app.register(makeAuthRoutes({
    login: {} as never, refresh: uc, mfa: {} as never, users, jwt,
    loginRateMax: 100, refreshCookieMaxAgeSec: 604800,
  }), { prefix: "/api/v1/auth" });
  await app.ready();
});

after(async () => {
  if (dbSkip) return;
  await app?.close();
  await deleteUser(userId).catch(() => {});
  await closePool();
});

test("TEST-BROWSER-AUTH-003: web refresh via cookie sets a new HttpOnly cookie and withholds the token from the body", { skip: dbSkip }, async () => {
  const rt = await session();
  const res = await app.inject({
    method: "POST", url: "/api/v1/auth/refresh",
    headers: { "x-awamer-client": "web", cookie: `${REFRESH_COOKIE}=${rt}` },
    payload: {},
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(body.access_token, "access token in body");
  assert.equal(body.refresh_token, undefined, "refresh token withheld from body (JS cannot read it)");
  const sc = res.headers["set-cookie"];
  assert.ok(sc, "sets a refresh cookie");
  assert.match(String(sc), /HttpOnly/);
  assert.ok(cookieVal(sc).length > 0, "cookie carries the rotated refresh token");
});

test("Tauri (no web header) still receives the refresh token in the body (unchanged)", { skip: dbSkip }, async () => {
  const rt = await session();
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/refresh", payload: { refresh_token: rt } });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(body.refresh_token, "body carries the refresh token for the keyring");
  assert.equal(res.headers["set-cookie"], undefined, "no cookie for the Tauri flow");
});

test("TEST-BROWSER-AUTH-004: logout clears the cookie and revokes the session", { skip: dbSkip }, async () => {
  const rt = await session();
  const res = await app.inject({
    method: "POST", url: "/api/v1/auth/logout",
    headers: { "x-awamer-client": "web", cookie: `${REFRESH_COOKIE}=${rt}` },
    payload: {},
  });
  assert.equal(res.statusCode, 204);
  assert.match(String(res.headers["set-cookie"]), /Max-Age=0/, "cookie cleared");
  // The revoked session can no longer refresh.
  const again = await app.inject({
    method: "POST", url: "/api/v1/auth/refresh",
    headers: { "x-awamer-client": "web", cookie: `${REFRESH_COOKIE}=${rt}` }, payload: {},
  });
  assert.equal(again.statusCode, 401, "refresh denied after logout");
});

test("TEST-BROWSER-AUTH-006: an expired/rotated cookie refresh is rejected", { skip: dbSkip }, async () => {
  const rt = await session();
  // first refresh rotates it
  await app.inject({ method: "POST", url: "/api/v1/auth/refresh", headers: { "x-awamer-client": "web", cookie: `${REFRESH_COOKIE}=${rt}` }, payload: {} });
  // reusing the old cookie token is denied (reuse detection)
  const reuse = await app.inject({ method: "POST", url: "/api/v1/auth/refresh", headers: { "x-awamer-client": "web", cookie: `${REFRESH_COOKIE}=${rt}` }, payload: {} });
  assert.equal(reuse.statusCode, 401);
});
