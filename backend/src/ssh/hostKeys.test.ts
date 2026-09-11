import { test } from "node:test";
import assert from "node:assert/strict";
import { fingerprint, makeHostVerifier, type HostKeyVerdict, type HostKeyStore } from "./hostKeys.js";

// SEC / Phase 3 — SSH host-key pinning decision logic.

const log = { warn() {}, info() {}, error() {} } as any;

function storeReturning(verdict: HostKeyVerdict | Error): HostKeyStore & { calls: number } {
  return {
    calls: 0,
    async verify() {
      this.calls++;
      if (verdict instanceof Error) throw verdict;
      return verdict;
    },
  };
}

const verify = (store: HostKeyStore) =>
  new Promise<boolean>((resolve) => makeHostVerifier(store, log, "h", 22)(Buffer.from("k"), resolve));

test("fingerprint is a stable SHA256:base64 (no padding)", () => {
  const fp = fingerprint(Buffer.from("hello"));
  assert.match(fp, /^SHA256:[A-Za-z0-9+/]+$/);
  assert.equal(fp, fingerprint(Buffer.from("hello")), "deterministic");
  assert.notEqual(fp, fingerprint(Buffer.from("hell0")), "collision-sensitive");
});

test("a matching pinned key is accepted", async () => {
  assert.equal(await verify(storeReturning("match")), true);
});

test("a first-seen key is pinned and accepted (TOFU)", async () => {
  assert.equal(await verify(storeReturning("new")), true);
});

test("a CHANGED key is refused (possible MITM)", async () => {
  assert.equal(await verify(storeReturning("mismatch")), false);
});

test("a store error fails OPEN (availability) but is the only fail-open path", async () => {
  assert.equal(await verify(storeReturning(new Error("db down"))), true);
});
