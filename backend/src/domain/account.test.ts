import { test } from "node:test";
import assert from "node:assert/strict";
import { isAccountLocked } from "./index.js";

const now = new Date("2026-01-01T00:00:00Z");

test("isAccountLocked: not locked", () => {
  assert.equal(isAccountLocked({ isLocked: false, lockedUntil: null }, now), false);
});

test("isAccountLocked: admin permanent lock always locked", () => {
  assert.equal(isAccountLocked({ isLocked: true, lockedUntil: null }, now), true);
});

test("isAccountLocked: temporary lock in the future is locked", () => {
  const until = new Date(now.getTime() + 60_000);
  assert.equal(isAccountLocked({ isLocked: false, lockedUntil: until }, now), true);
});

test("isAccountLocked: expired temporary lock unlocks itself", () => {
  const until = new Date(now.getTime() - 60_000);
  assert.equal(isAccountLocked({ isLocked: false, lockedUntil: until }, now), false);
});
