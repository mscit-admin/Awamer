import { test } from "node:test";
import assert from "node:assert/strict";
import { ChangePasswordUseCase } from "./changePassword.js";

// Minimal fakes — argon2 "verify" treats the stored hash as `hash:<plain>`.
function makeArgon2() {
  return {
    async hash(p: string) { return `hash:${p}`; },
    async verify(stored: string, p: string) { return stored === `hash:${p}`; },
    needsRehash() { return false; },
  };
}

function makeDeps(currentPlain: string) {
  const state = { hash: `hash:${currentPlain}`, revoked: 0, audits: [] as any[] };
  const users = {
    async getById(id: string) { return { id, passwordHash: state.hash }; },
    async updatePasswordHash(_id: string, h: string) { state.hash = h; },
  };
  const refresh = { async revokeAllForUser(_id: string) { state.revoked++; } };
  const audit = { async log(e: any) { state.audits.push(e); } };
  const uc = new ChangePasswordUseCase(users as any, refresh as any, audit as any, makeArgon2() as any);
  return { uc, state };
}

const STRONG = "NewStrongPass1!";

test("changes the password when current is correct and new is strong", async () => {
  const { uc, state } = makeDeps("OldStrongPass1!");
  await uc.execute("u1", "OldStrongPass1!", STRONG);
  assert.equal(state.hash, `hash:${STRONG}`);
  assert.equal(state.revoked, 1, "should revoke refresh sessions");
  assert.ok(state.audits.some((a) => a.action === "password_change" && a.success));
});

const hasCode = (code: string) => (e: unknown) => (e as { code?: string }).code === code;

test("rejects a wrong current password", async () => {
  const { uc, state } = makeDeps("OldStrongPass1!");
  await assert.rejects(() => uc.execute("u1", "wrong", STRONG), hasCode("invalid_credentials"));
  assert.equal(state.hash, "hash:OldStrongPass1!", "hash unchanged");
  assert.equal(state.revoked, 0);
  assert.ok(state.audits.some((a) => a.action === "password_change" && !a.success));
});

test("rejects a weak new password", async () => {
  const { uc } = makeDeps("OldStrongPass1!");
  await assert.rejects(() => uc.execute("u1", "OldStrongPass1!", "short"), hasCode("weak_password"));
});

test("rejects reusing the same password", async () => {
  const { uc } = makeDeps(STRONG);
  await assert.rejects(() => uc.execute("u1", STRONG, STRONG), hasCode("password_unchanged"));
});
