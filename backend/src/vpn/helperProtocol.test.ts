/**
 * SEC-INFRA-001 — VPN helper IPC protocol unit tests (auth, replay, integrity).
 * Underpins the IPC security gates (INFRA-VPN-025..032).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalize, signRequest, verifyRequest, signResponse, verifyResponse,
  safeEqualHex, NonceCache, PROTOCOL_VERSION, isValidRef, isHelperOp,
} from "./helperProtocol.js";

const SECRET = "x".repeat(48);
const mkReq = (over: Record<string, unknown> = {}) => ({ v: PROTOCOL_VERSION, op: "health" as const, id: "req-1", ts: Date.now(), payload: {}, ...over });

test("canonicalize sorts object keys deterministically", () => {
  assert.equal(canonicalize({ b: 1, a: 2 }), canonicalize({ a: 2, b: 1 }));
  assert.notEqual(canonicalize({ a: 1 }), canonicalize({ a: 2 }));
});

test("a correctly signed request verifies", () => {
  const signed = signRequest(SECRET, mkReq());
  const v = verifyRequest(SECRET, signed);
  assert.equal(v.op, "health");
});

test("a tampered payload fails verification (integrity)", () => {
  const signed = signRequest(SECRET, mkReq({ op: "client_stop", payload: { sessionRef: "a" } }));
  signed.payload.sessionRef = "b"; // tamper after signing
  assert.throws(() => verifyRequest(SECRET, signed), /bad_mac/);
});

test("a wrong secret fails verification", () => {
  const signed = signRequest(SECRET, mkReq());
  assert.throws(() => verifyRequest("y".repeat(48), signed), /bad_mac/);
});

test("a missing MAC is rejected", () => {
  const { mac, ...unsigned } = signRequest(SECRET, mkReq()); void mac;
  assert.throws(() => verifyRequest(SECRET, unsigned), /missing_mac/);
});

test("a stale timestamp is rejected", () => {
  const signed = signRequest(SECRET, mkReq({ ts: Date.now() - 120_000 }));
  assert.throws(() => verifyRequest(SECRET, signed, { skewMs: 30_000 }), /stale/);
});

test("an unknown op is rejected", () => {
  const signed = signRequest(SECRET, mkReq({ op: "exec" as any }));
  assert.throws(() => verifyRequest(SECRET, signed), /unknown_op/);
});

test("responses are signed and bound to the request id", () => {
  const res = signResponse(SECRET, { ok: true, result: { ready: true }, id: "req-9", ts: Date.now() });
  const v = verifyResponse(SECRET, res, "req-9");
  assert.equal(v.ok, true);
  assert.throws(() => verifyResponse(SECRET, res, "other-id"), /id_mismatch/);
});

test("NonceCache accepts an id once then rejects the replay", () => {
  const c = new NonceCache(1000);
  assert.equal(c.check("n1"), true);
  assert.equal(c.check("n1"), false);
  assert.equal(c.check("n2"), true);
});

test("safeEqualHex is false on mismatch/length and true on equal", () => {
  assert.equal(safeEqualHex("abcd", "abcd"), true);
  assert.equal(safeEqualHex("abcd", "abce"), false);
  assert.equal(safeEqualHex("ab", "abcd"), false);
  assert.equal(safeEqualHex("", ""), false);
});

test("isValidRef rejects traversal and accepts uuids", () => {
  assert.equal(isValidRef("6d1f0c2e-1111-2222-3333-444455556666"), true);
  assert.equal(isValidRef("../../etc/passwd"), false);
  assert.equal(isValidRef("/etc/shadow"), false);
  assert.equal(isValidRef("a/b"), false);
  assert.equal(isValidRef(".."), false);
  assert.equal(isHelperOp("client_connect"), true);
  assert.equal(isHelperOp("exec"), false);
});
