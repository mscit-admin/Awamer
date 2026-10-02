import { test } from "node:test";
import assert from "node:assert/strict";
import { RefreshUseCase } from "./refresh.js";

// SEC-002 / SEC-007 regression tests: a valid, non-reused refresh token must
// still be denied when the account is no longer eligible (disabled, locked,
// deleted), and the whole session chain must be revoked on denial.

const hasCode = (code: string) => (e: unknown) => (e as { code?: string }).code === code;

interface Session {
  userId: string; jti: string; rotatedTo: string | null;
  revokedAt: Date | null; expiresAt: Date;
}

function makeDeps(opts: {
  user?: { id: string; role: string; isActive: boolean; isLocked: boolean; lockedUntil: Date | null } | null;
  session?: Partial<Session> | null;
} = {}) {
  const uid = "u1";
  const user = opts.user === undefined
    ? { id: uid, role: "user", isActive: true, isLocked: false, lockedUntil: null }
    : opts.user;
  const session: Session | null = opts.session === null ? null : {
    userId: uid, jti: "jti-old", rotatedTo: null, revokedAt: null,
    expiresAt: new Date(Date.now() + 60_000),
    ...opts.session,
  };
  const state = { revokedAll: 0, inserted: 0, rotated: 0, audits: [] as any[] };

  const users = {
    async getById(id: string) {
      if (!user) throw Object.assign(new Error("user not found"), { code: "user_not_found" });
      return { ...user, id };
    },
  };
  const refresh = {
    async get(_jti: string) { return session; },
    async insert(_r: any) { state.inserted++; },
    async markRotated(_a: string, _b: string) { state.rotated++; return true; },
    async revokeAllForUser(_id: string) { state.revokedAll++; },
  };
  const audit = { async log(e: any) { state.audits.push(e); } };
  const jwt = {
    async verifyRefresh(_t: string) { return { sub: uid, jti: "jti-old" }; },
    async issuePair(id: string, _role: string) {
      return {
        access: { token: "access-tok", expiresAt: new Date(Date.now() + 900_000) },
        refresh: { jti: "jti-new", token: "refresh-tok", expiresAt: new Date(Date.now() + 3_600_000) },
      };
    },
  };
  const log = { warn() {}, info() {}, error() {} };
  const uc = new RefreshUseCase(users as any, refresh as any, audit as any, jwt as any, log as any);
  return { uc, state };
}

test("active user + valid refresh token → issues a new pair", async () => {
  const { uc, state } = makeDeps();
  const r = await uc.execute("refresh-tok", "1.2.3.4", "ua");
  assert.equal(r.accessToken, "access-tok");
  assert.equal(r.refreshToken, "refresh-tok");
  assert.equal(state.inserted, 1);
  assert.equal(state.rotated, 1);
  assert.equal(state.revokedAll, 0, "no revocation on the happy path");
  assert.ok(state.audits.some((a) => a.action === "token_refresh" && a.success));
});

test("disabled user + valid refresh token → DENY and revoke the chain", async () => {
  const { uc, state } = makeDeps({ user: { id: "u1", role: "user", isActive: false, isLocked: false, lockedUntil: null } });
  await assert.rejects(() => uc.execute("refresh-tok", null, null), hasCode("account_inactive"));
  assert.equal(state.inserted, 0, "no new token issued");
  assert.equal(state.revokedAll, 1, "chain revoked");
  assert.ok(state.audits.some((a) => a.action === "token_refresh_denied" && a.details?.reason === "inactive"));
});

test("locked user + valid refresh token → DENY and revoke the chain", async () => {
  const { uc, state } = makeDeps({ user: { id: "u1", role: "user", isActive: true, isLocked: true, lockedUntil: null } });
  await assert.rejects(() => uc.execute("refresh-tok", null, null), hasCode("account_locked"));
  assert.equal(state.inserted, 0);
  assert.equal(state.revokedAll, 1);
  assert.ok(state.audits.some((a) => a.action === "token_refresh_denied" && a.details?.reason === "locked"));
});

test("temporarily locked (lockedUntil in future) → DENY", async () => {
  const { uc, state } = makeDeps({ user: { id: "u1", role: "user", isActive: true, isLocked: false, lockedUntil: new Date(Date.now() + 60_000) } });
  await assert.rejects(() => uc.execute("refresh-tok", null, null), hasCode("account_locked"));
  assert.equal(state.revokedAll, 1);
});

test("deleted user + valid refresh token → DENY and revoke the chain", async () => {
  const { uc, state } = makeDeps({ user: null });
  await assert.rejects(() => uc.execute("refresh-tok", null, null), hasCode("refresh_reuse"));
  assert.equal(state.inserted, 0);
  assert.equal(state.revokedAll, 1);
  assert.ok(state.audits.some((a) => a.action === "token_refresh_denied" && a.details?.reason === "user_gone"));
});

test("revoked session → DENY without issuing", async () => {
  const { uc, state } = makeDeps({ session: { revokedAt: new Date() } });
  await assert.rejects(() => uc.execute("refresh-tok", null, null), hasCode("refresh_reuse"));
  assert.equal(state.inserted, 0);
});

test("expired session → DENY without issuing", async () => {
  const { uc, state } = makeDeps({ session: { expiresAt: new Date(Date.now() - 1000) } });
  await assert.rejects(() => uc.execute("refresh-tok", null, null), hasCode("refresh_reuse"));
  assert.equal(state.inserted, 0);
});

test("reused (already-rotated) token → DENY and revoke all", async () => {
  const { uc, state } = makeDeps({ session: { rotatedTo: "jti-new" } });
  await assert.rejects(() => uc.execute("refresh-tok", null, null), hasCode("refresh_reuse"));
  assert.equal(state.revokedAll, 1, "reuse triggers full revocation");
  assert.ok(state.audits.some((a) => a.action === "token_reuse_detected"));
});

test("unknown session (no record) → DENY as reuse", async () => {
  const { uc, state } = makeDeps({ session: null });
  await assert.rejects(() => uc.execute("refresh-tok", null, null), hasCode("refresh_reuse"));
  assert.equal(state.inserted, 0);
});
