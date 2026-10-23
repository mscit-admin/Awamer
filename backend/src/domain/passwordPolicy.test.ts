/** SEC-PW-POLICY-001 (ASVS V6.2) — PW-POLICY-001..008. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkPassword, PASSWORD_MAX_LENGTH } from "./passwordPolicy.js";
import { COMMON_PASSWORDS } from "./data/commonPasswords.js";
import { assertPasswordPolicy } from "../usecases/register.js";

const ctx = { username: "jsmith", email: "john.smith@contoso.com", fullName: "John Smith" };

test("PW-POLICY-001: no composition rules — a long lower-case passphrase is accepted (V6.2.5)", () => {
  assert.equal(checkPassword("correct horse battery staple", ctx), null);
  assert.equal(checkPassword("zebra-lantern-quietly-orbits", ctx), null);
});

test("PW-POLICY-002: minimum 12, maximum 128 code points; any character allowed (V6.2.1/6.2.9)", () => {
  assert.equal(checkPassword("Short1!aB", ctx), "too_short");
  assert.equal(checkPassword("x".repeat(11) + "é"), null, "12 code points");
  assert.equal(checkPassword("🔑".repeat(11)), "too_short", "emoji count as one character each");
  assert.equal(checkPassword("q".repeat(PASSWORD_MAX_LENGTH) + "z"), "too_long");
  assert.equal(checkPassword("كلمة سر طويلة جدا"), null);
});

test("PW-POLICY-003: the bundled list holds 10,000 lower-case entries of 12+ characters", () => {
  assert.equal(COMMON_PASSWORDS.length, 10000);
  assert.ok(COMMON_PASSWORDS.every((w) => w.length >= 12 && w === w.toLowerCase()));
});

test("PW-POLICY-004: common leaked passwords are refused, case-insensitively (V6.2.4)", () => {
  for (const pw of ["qwerty123456", "QWERTY123456", "1qaz2wsx3edc", "123456789012"]) {
    assert.equal(checkPassword(pw), "common", pw);
  }
});

test("PW-POLICY-005: passwords containing account words are refused (V6.2.11)", () => {
  assert.equal(checkPassword("jsmith-garden-lamp", ctx), "contextual", "username");
  assert.equal(checkPassword("my-john.smith-pass", ctx), "contextual", "email local part");
  assert.equal(checkPassword("Contoso-River-Bend", ctx), "contextual", "email domain name");
  assert.equal(checkPassword("velvet-SMITH-orbit", ctx), "contextual", "name part");
});

test("PW-POLICY-006: product names are refused for everyone", () => {
  assert.equal(checkPassword("my-Awamer-password"), "contextual");
  assert.equal(checkPassword("netsphere-rocks-99"), "contextual");
});

test("PW-POLICY-007: short context words do not over-block", () => {
  // a 2-letter username or a 3-letter name part is not treated as a context word
  assert.equal(checkPassword("velvet-lantern-orbit", { username: "al", fullName: "Al Bo" }), null);
});

test("PW-POLICY-008: the use-case guard raises weak_password with the specific reason", () => {
  assert.throws(() => assertPasswordPolicy("qwerty123456"), (e: unknown) => (e as { code?: string }).code === "weak_password" && /too common/.test((e as Error).message));
  assert.throws(() => assertPasswordPolicy("short"), (e: unknown) => (e as { code?: string }).code === "weak_password" && /at least 12/.test((e as Error).message));
  assert.doesNotThrow(() => assertPasswordPolicy("correct horse battery staple", ctx));
});
