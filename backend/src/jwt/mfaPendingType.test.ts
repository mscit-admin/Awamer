/**
 * SEC-MFA-BYPASS-001 regression — the post-password MFA challenge token must
 * never be usable as an access token.
 *
 * Before the fix the challenge token was minted with `typ:"access"` (signed with
 * the access key, no `av` claim). `verify()` defaults a missing `av` to 1, so for
 * any MFA account whose live auth_version was still 1 the challenge token passed
 * `verifyCurrentAccessToken` and the auth middleware then swapped in the live
 * role — a full session without the TOTP code.
 *
 *   MFA-TYP-001 the challenge token is rejected by verifyAccess
 *   MFA-TYP-002 the challenge token is accepted by verifyMfaPending
 *   MFA-TYP-003 a real access token is rejected by verifyMfaPending
 *   MFA-TYP-004 a legacy typ:"access"/role:"mfa_pending" token is not an MFA token
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { SignJWT } from "jose";
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
const UID = "11111111-2222-3333-4444-555555555555";
const rejected = (e: unknown) => (e as Error)?.name === "JwtInvalid" || (e as Error)?.constructor?.name === "JwtInvalid";

test("MFA-TYP-001: the MFA challenge token is rejected as an access token", async () => {
  const mfa = await jwt.issueOne(UID, "mfa_pending", "mfa_pending", 300);
  await assert.rejects(() => jwt.verifyAccess(mfa.token), rejected);
});

test("MFA-TYP-002: the MFA challenge token verifies as mfa_pending", async () => {
  const mfa = await jwt.issueOne(UID, "mfa_pending", "mfa_pending", 300);
  const claims = await jwt.verifyMfaPending(mfa.token);
  assert.equal(claims.sub, UID);
  assert.equal(claims.typ, "mfa_pending");
});

test("MFA-TYP-003: a normal access token cannot be used at the MFA challenge", async () => {
  const { access } = await jwt.issuePair(UID, "admin", 1);
  await assert.rejects(() => jwt.verifyMfaPending(access.token), rejected);
});

test("MFA-TYP-004: a legacy typ:access challenge token is not accepted as mfa_pending", async () => {
  const legacy = await new SignJWT({ typ: "access", role: "mfa_pending" })
    .setProtectedHeader({ alg: "HS256" }).setIssuer(ISSUER).setSubject(UID)
    .setIssuedAt().setExpirationTime("5m").sign(new TextEncoder().encode(ACCESS));
  await assert.rejects(() => jwt.verifyMfaPending(legacy), rejected);
});
