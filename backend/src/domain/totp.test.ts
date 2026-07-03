import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTotpInput, normaliseBase32Secret } from "./totp.js";

test("normaliseBase32Secret upper-cases and strips spaces/padding", () => {
  assert.equal(normaliseBase32Secret("gezd gnbv gy3t qojq"), "GEZDGNBVGY3TQOJQ");
  assert.equal(normaliseBase32Secret("GEZDGNBVGY3TQOJQ===="), "GEZDGNBVGY3TQOJQ");
});

test("normaliseBase32Secret rejects non-base32", () => {
  assert.throws(() => normaliseBase32Secret("not base32 !!!"));
  assert.throws(() => normaliseBase32Secret("")); // empty
  assert.throws(() => normaliseBase32Secret("01890")); // 0,1,8,9 not in base32
});

test("parseTotpInput accepts a raw secret with defaults", () => {
  const p = parseTotpInput({ secret: "GEZDGNBVGY3TQOJQ" });
  assert.deepEqual(p, { secret: "GEZDGNBVGY3TQOJQ", algorithm: "SHA1", digits: 6, period: 30 });
});

test("parseTotpInput parses an otpauth URI", () => {
  const p = parseTotpInput({
    otpauthUri: "otpauth://totp/GitHub:me?secret=GEZDGNBVGY3TQOJQ&issuer=GitHub&digits=8&period=60&algorithm=SHA256",
  });
  assert.equal(p.secret, "GEZDGNBVGY3TQOJQ");
  assert.equal(p.digits, 8);
  assert.equal(p.period, 60);
  assert.equal(p.algorithm, "SHA256");
});

test("explicit fields override URI-derived values", () => {
  const p = parseTotpInput({
    otpauthUri: "otpauth://totp/x?secret=GEZDGNBVGY3TQOJQ&digits=8",
    digits: 6,
    algorithm: "SHA512",
  });
  assert.equal(p.digits, 6);
  assert.equal(p.algorithm, "SHA512");
});

test("parseTotpInput clamps out-of-range digits/period to defaults", () => {
  const p = parseTotpInput({ secret: "GEZDGNBVGY3TQOJQ", digits: 12, period: 5 });
  assert.equal(p.digits, 6);   // 12 out of [6,8] → default 6
  assert.equal(p.period, 30);  // 5 out of [15,60] → default 30
});

test("parseTotpInput rejects a non-otpauth URI and a missing secret", () => {
  assert.throws(() => parseTotpInput({ otpauthUri: "https://evil.example/?secret=GEZDGNBVGY3TQOJQ" }));
  assert.throws(() => parseTotpInput({}));
});
