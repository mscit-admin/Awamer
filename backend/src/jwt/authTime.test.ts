/**
 * SEC-SESSION-ABS-001 — the refresh token carries the original sign-in time
 * (`at`, signed) and never outlives `at + SESSION_ABSOLUTE_LIFETIME`.
 *   JWT-AT-001 fresh login: at = now, exp = now + refresh TTL
 *   JWT-AT-002 rotation: at preserved, exp capped at at + absolute lifetime
 *   JWT-AT-003 legacy refresh token without `at` falls back to iat
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { SignJWT } from "jose";
import { createJwt } from "./index.js";
import type { Config } from "../config/index.js";

const REFRESH = "b".repeat(48);
const cfg = {
  env: { JWT_ACCESS_SECRET: "a".repeat(48), JWT_REFRESH_SECRET: REFRESH, JWT_ISSUER: "netsphere" },
  jwtAccessTtlSec: 900, jwtRefreshTtlSec: 3600, sessionAbsoluteLifetimeSec: 7200,
} as unknown as Config;
const jwt = createJwt(cfg);
const UID = "11111111-2222-3333-4444-555555555555";
const now = () => Math.floor(Date.now() / 1000);

test("JWT-AT-001: a fresh login stamps at=now and the normal refresh TTL", async () => {
  const { refresh } = await jwt.issuePair(UID, "user", 1);
  const c = await jwt.verifyRefresh(refresh.token);
  assert.ok(Math.abs(c.at - now()) <= 2);
  assert.ok(Math.abs(c.exp - (c.at + 3600)) <= 2);
});

test("JWT-AT-002: a rotation keeps at and caps exp at at + absolute lifetime", async () => {
  const signedIn = now() - 6000; // 100 min ago; absolute = 120 min
  const { refresh } = await jwt.issuePair(UID, "user", 1, signedIn);
  const c = await jwt.verifyRefresh(refresh.token);
  assert.equal(c.at, signedIn);
  assert.equal(c.exp, signedIn + 7200, "not now + 3600");
});

test("JWT-AT-003: a legacy refresh token without at uses iat", async () => {
  const iat = now() - 60;
  const legacy = await new SignJWT({ typ: "refresh", role: "user" })
    .setProtectedHeader({ alg: "HS256" }).setIssuer("netsphere").setSubject(UID).setJti("j1")
    .setIssuedAt(iat).setNotBefore(iat).setExpirationTime(iat + 3600)
    .sign(new TextEncoder().encode(REFRESH));
  assert.equal((await jwt.verifyRefresh(legacy)).at, iat);
});
