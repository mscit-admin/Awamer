/**
 * AWM-SEC-022 — ActiveSessionManager unit tests (no DB). Covers the revocation
 * logic, idempotency, permission-awareness, fallback failure policy and
 * registry cleanup. AUTHZ-STATE-017 (no false disconnect), 018 (revalidation
 * failure), 019 (multiple sessions), 020 (other users), 021 (double close).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ActiveSessionManager, type ActiveRemoteSession, type SessionKind } from "./activeSessions.js";
import type { AuthUserState } from "../middleware/auth.js";

const log = { warn() {}, info() {}, error() {}, debug() {}, fatal() {}, trace() {}, child() { return log; } } as never;

type UserState = AuthUserState;
/** A controllable users source: returns states, or throws a coded error. */
function fakeUsers(states: Record<string, UserState | "not_found" | "db_error">) {
  return {
    async getById(id: string): Promise<UserState> {
      const s = states[id];
      if (s === undefined || s === "not_found") { const e = new Error("user not found") as Error & { code?: string }; e.code = "user_not_found"; throw e; }
      if (s === "db_error") { throw new Error("connection terminated unexpectedly"); }
      return s;
    },
  };
}
const active = (role = "user"): UserState => ({ role, isActive: true, isLocked: false, lockedUntil: null, companyId: null, authVersion: 1, mfaEnabled: true });

/** A fake session whose close records the reason and is idempotent. */
function fakeSession(userId: string, kind: SessionKind, perm: ActiveRemoteSession["requiredPermission"]) {
  const rec = { closed: 0, reason: "" as string };
  const s: ActiveRemoteSession = {
    sessionId: `${userId}:${kind}:${Math.random().toString(36).slice(2)}`,
    userId, kind, requiredPermission: perm,
    close: (reason) => { rec.closed += 1; rec.reason = reason; },
  };
  return { s, rec };
}

test("register/unregister maintains counts", () => {
  const m = new ActiveSessionManager({ users: fakeUsers({}), log });
  const { s } = fakeSession("u1", "ssh", "sessions:connect");
  m.register(s);
  assert.equal(m.count(), 1);
  assert.equal(m.countForUser("u1"), 1);
  m.unregister(s.sessionId);
  assert.equal(m.count(), 0);
  assert.equal(m.countForUser("u1"), 0);
});

test("revokeUser closes ALL of a user's sessions and cleans the registry", () => {
  const m = new ActiveSessionManager({ users: fakeUsers({}), log });
  const a = fakeSession("u1", "ssh", "sessions:connect");
  const b = fakeSession("u1", "telnet", "sessions:connect");
  m.register(a.s); m.register(b.s);
  const n = m.revokeUser("u1", "USER_DISABLED");
  assert.equal(n, 2);
  assert.equal(a.rec.closed, 1);
  assert.equal(b.rec.closed, 1);
  assert.equal(m.count(), 0, "registry emptied");
});

test("AUTHZ-STATE-019: multiple session kinds for one user all terminate", async () => {
  const m = new ActiveSessionManager({ users: fakeUsers({ u1: "not_found" }), log });
  const kinds: Array<[SessionKind, ActiveRemoteSession["requiredPermission"]]> = [["ssh", "sessions:connect"], ["telnet", "sessions:connect"], ["tunnel", "tunnels:manage"], ["vnc", "sessions:connect"]];
  const recs = kinds.map(([k, p]) => { const f = fakeSession("u1", k, p); m.register(f.s); return f.rec; });
  await m.revalidateUser("u1"); // user deleted → all close
  assert.deepEqual(recs.map((r) => r.closed), [1, 1, 1, 1]);
  assert.equal(m.count(), 0);
});

test("AUTHZ-STATE-020: revoking one user does not affect another", () => {
  const m = new ActiveSessionManager({ users: fakeUsers({}), log });
  const a = fakeSession("A", "ssh", "sessions:connect");
  const b = fakeSession("B", "ssh", "sessions:connect");
  m.register(a.s); m.register(b.s);
  m.revokeUser("A", "USER_DISABLED");
  assert.equal(a.rec.closed, 1);
  assert.equal(b.rec.closed, 0, "user B untouched");
  assert.equal(m.countForUser("B"), 1);
});

test("revalidateUser: disabled and locked users have all sessions closed", async () => {
  const disabled = { ...active(), isActive: false };
  const locked = { ...active(), isLocked: true };
  const tempLocked = { ...active(), lockedUntil: new Date(Date.now() + 60_000) };
  for (const [state, why] of [[disabled, "USER_DISABLED"], [locked, "USER_LOCKED"], [tempLocked, "USER_LOCKED"]] as const) {
    const m = new ActiveSessionManager({ users: fakeUsers({ u: state }), log });
    const f = fakeSession("u", "ssh", "sessions:connect");
    m.register(f.s);
    await m.revalidateUser("u");
    assert.equal(f.rec.closed, 1, why);
    assert.equal(f.rec.reason, why);
  }
});

test("revalidateUser is permission-aware on role change", async () => {
  // readonly has neither sessions:connect nor tunnels:manage → both close.
  const m = new ActiveSessionManager({ users: fakeUsers({ u: active("readonly") }), log });
  const ssh = fakeSession("u", "ssh", "sessions:connect");
  const tun = fakeSession("u", "tunnel", "tunnels:manage");
  m.register(ssh.s); m.register(tun.s);
  await m.revalidateUser("u");
  assert.equal(ssh.rec.closed, 1, "readonly loses sessions:connect");
  assert.equal(tun.rec.closed, 1, "readonly loses tunnels:manage");
  assert.equal(ssh.rec.reason, "PERMISSION_REVOKED");
});

test("AUTHZ-STATE-017: an unchanged authorized user keeps its session (no false disconnect)", async () => {
  const m = new ActiveSessionManager({ users: fakeUsers({ u: active("user") }), log });
  const ssh = fakeSession("u", "ssh", "sessions:connect"); // user has sessions:connect
  m.register(ssh.s);
  await m.revalidateUser("u");
  await m.revalidateAll();
  assert.equal(ssh.rec.closed, 0, "still authorized → session stays open");
  assert.equal(m.count(), 1);
});

test("AUTHZ-STATE-018: transient DB failure gets a grace window, then fails closed", async () => {
  const m = new ActiveSessionManager({ users: fakeUsers({ u: "db_error" }), log, failCloseThreshold: 3 });
  const ssh = fakeSession("u", "ssh", "sessions:connect");
  m.register(ssh.s);
  await m.revalidateUser("u"); // fail 1
  await m.revalidateUser("u"); // fail 2
  assert.equal(ssh.rec.closed, 0, "grace: not closed on transient blips");
  await m.revalidateUser("u"); // fail 3 → threshold → fail closed
  assert.equal(ssh.rec.closed, 1, "persistent failure → fail closed");
  assert.equal(ssh.rec.reason, "PERIODIC_REVALIDATION_FAILED");
});

test("transient failure counter resets after a successful revalidation", async () => {
  const states: Record<string, UserState | "db_error"> = { u: "db_error" };
  const m = new ActiveSessionManager({ users: { async getById(id: string) { const s = states[id]; if (s === "db_error") throw new Error("db down"); return s as UserState; } }, log, failCloseThreshold: 3 });
  const ssh = fakeSession("u", "ssh", "sessions:connect");
  m.register(ssh.s);
  await m.revalidateUser("u"); await m.revalidateUser("u"); // 2 failures
  states.u = active("user"); // DB recovers
  await m.revalidateUser("u"); // success → counter reset, still authorized
  states.u = "db_error";
  await m.revalidateUser("u"); await m.revalidateUser("u"); // 2 more failures (not 4)
  assert.equal(ssh.rec.closed, 0, "counter reset prevented a premature fail-close");
});

test("AUTHZ-STATE-021: double revocation (event + periodic) is idempotent", async () => {
  const m = new ActiveSessionManager({ users: fakeUsers({ u: { ...active(), isActive: false } }), log });
  const ssh = fakeSession("u", "ssh", "sessions:connect");
  m.register(ssh.s);
  m.revokeUser("u", "USER_DISABLED");      // event-driven
  await m.revalidateUser("u");             // periodic sees the same state
  await assert.doesNotReject(() => m.revalidateAll());
  assert.equal(ssh.rec.closed, 1, "closed exactly once; no duplicate side effects");
});

test("a throwing close callback does not break revocation of siblings", () => {
  const m = new ActiveSessionManager({ users: fakeUsers({}), log });
  const bad: ActiveRemoteSession = { sessionId: "x", userId: "u", kind: "ssh", requiredPermission: "sessions:connect", close: () => { throw new Error("boom"); } };
  const good = fakeSession("u", "telnet", "sessions:connect");
  m.register(bad); m.register(good.s);
  assert.doesNotThrow(() => m.revokeUser("u", "USER_DISABLED"));
  assert.equal(good.rec.closed, 1, "sibling still closed despite the throwing one");
  assert.equal(m.count(), 0);
});
