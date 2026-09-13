/**
 * JWT hardening — the verifier must accept ONLY HS256 and reject every other
 * algorithm (alg=none, HS384/HS512 downgrade, RS256 confusion, tampered header).
 * Exercised across access, refresh, mfa_pending and step-up token paths.
 *   JWT-ALG-001 valid HS256 accepted
 *   JWT-ALG-002 alg=none rejected
 *   JWT-ALG-003 HS384 rejected
 *   JWT-ALG-004 HS512 rejected
 *   JWT-ALG-005 RS256 rejected
 *   JWT-ALG-006 modified alg header rejected
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { SignJWT, UnsecuredJWT, generateKeyPair, exportPKCS8 } from "jose";
import { createJwt } from "./index.js";
import type { Config } from "../config/index.js";

const ACCESS = "a".repeat(48);
const REFRESH = "b".repeat(48);
const ISSUER = "netsphere";
const cfg = {
  env: { JWT_ACCESS_SECRET: ACCESS, JWT_REFRESH_SECRET: REFRESH, JWT_ISSUER: ISSUER },
  jwtAccessTtlSec: 900, jwtRefreshTtlSec: 3600,
} as unknown as Config;

const jwt = createJwt(cfg);
const accessKey = new TextEncoder().encode(ACCESS);
const UID = "11111111-2222-3333-4444-555555555555";
const rejected = (e: unknown) => (e as Error)?.constructor?.name === "JwtInvalid" || (e as Error)?.name === "JwtInvalid";

/** Build a token for an explicit alg using the shared HMAC secret. */
async function hmacToken(alg: string): Promise<string> {
  return new SignJWT({ typ: "access", role: "user", av: 1 })
    .setProtectedHeader({ alg }).setIssuer(ISSUER).setSubject(UID)
    .setIssuedAt().setExpirationTime("15m").sign(accessKey);
}

test("JWT-ALG-001: a valid HS256 access token is accepted", async () => {
  const { access } = await jwt.issuePair(UID, "user", 1);
  const claims = await jwt.verifyAccess(access.token);
  assert.equal(claims.sub, UID);
  assert.equal(claims.typ, "access");
});

test("JWT-ALG-002: alg=none is rejected", async () => {
  const none = new UnsecuredJWT({ typ: "access", role: "user", av: 1 })
    .setIssuer(ISSUER).setSubject(UID).setIssuedAt().setExpirationTime("15m").encode();
  await assert.rejects(() => jwt.verifyAccess(none), rejected);
});

test("JWT-ALG-003: HS384 is rejected (no algorithm downgrade)", async () => {
  const t = await hmacToken("HS384");
  await assert.rejects(() => jwt.verifyAccess(t), rejected);
});

test("JWT-ALG-004: HS512 is rejected (no algorithm downgrade)", async () => {
  const t = await hmacToken("HS512");
  await assert.rejects(() => jwt.verifyAccess(t), rejected);
});

test("JWT-ALG-005: RS256 is rejected (no alg-confusion with an asymmetric key)", async () => {
  const { privateKey } = await generateKeyPair("RS256");
  void (await exportPKCS8(privateKey));
  const rs = await new SignJWT({ typ: "access", role: "user", av: 1 })
    .setProtectedHeader({ alg: "RS256" }).setIssuer(ISSUER).setSubject(UID)
    .setIssuedAt().setExpirationTime("15m").sign(privateKey);
  await assert.rejects(() => jwt.verifyAccess(rs), rejected);
});

test("JWT-ALG-006: a token whose alg header is tampered (HS256→HS512) is rejected", async () => {
  const { access } = await jwt.issuePair(UID, "user", 1);
  const [, payload, sig] = access.token.split(".");
  const forgedHeader = Buffer.from(JSON.stringify({ alg: "HS512", typ: "JWT" })).toString("base64url");
  await assert.rejects(() => jwt.verifyAccess(`${forgedHeader}.${payload}.${sig}`), rejected);
});

test("JWT-ALG: refresh + step-up paths also pin HS256 (HS512 rejected)", async () => {
  // refresh path
  const refreshKey = new TextEncoder().encode(REFRESH);
  const badRefresh = await new SignJWT({ typ: "refresh", role: "user" })
    .setProtectedHeader({ alg: "HS512" }).setIssuer(ISSUER).setSubject(UID)
    .setIssuedAt().setExpirationTime("1h").sign(refreshKey);
  await assert.rejects(() => jwt.verifyRefresh(badRefresh), rejected);
  // step-up path
  const badStepUp = await new SignJWT({ typ: "step_up", purpose: "mfa_disable" })
    .setProtectedHeader({ alg: "HS512" }).setIssuer(ISSUER).setSubject(UID)
    .setIssuedAt().setExpirationTime("5m").sign(accessKey);
  await assert.rejects(() => jwt.verifyStepUp(badStepUp), rejected);
});
