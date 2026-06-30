import { test } from "node:test";
import assert from "node:assert/strict";
import { can, permissionsFor } from "./permissions.js";

test("admin and super_admin have every permission", () => {
  for (const role of ["admin", "super_admin"]) {
    assert.ok(can(role, "resources:write"));
    assert.ok(can(role, "sessions:connect"));
    assert.ok(can(role, "credentials:reveal"));
    assert.ok(can(role, "users:manage"));
    assert.ok(can(role, "audit:read"));
  }
});

test("user can self-serve but not manage users", () => {
  assert.ok(can("user", "resources:write"));
  assert.ok(can("user", "sessions:connect"));
  assert.ok(can("user", "credentials:reveal"));
  assert.equal(can("user", "users:manage"), false);
});

test("readonly cannot write, connect, or reveal", () => {
  assert.equal(can("readonly", "resources:write"), false);
  assert.equal(can("readonly", "sessions:connect"), false);
  assert.equal(can("readonly", "credentials:reveal"), false);
  assert.deepEqual(permissionsFor("readonly"), []);
});

test("auditor can read audit but not write/connect", () => {
  assert.ok(can("auditor", "audit:read"));
  assert.equal(can("auditor", "resources:write"), false);
  assert.equal(can("auditor", "sessions:connect"), false);
});

test("unknown role has no permissions", () => {
  assert.deepEqual(permissionsFor("nope"), []);
  assert.equal(can("nope", "resources:write"), false);
});
