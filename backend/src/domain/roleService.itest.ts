import { test, after } from "node:test";
import assert from "node:assert/strict";
import { RoleRepository } from "../repos/roleRepo.js";
import { RoleService } from "./roleService.js";
import { can, setPermissionResolver } from "./permissions.js";
import { getPool, closePool, dbSkip } from "../test/db.js";

after(async () => {
  setPermissionResolver(null); // revert to the static matrix
  await closePool();
});

test("RoleService reconciles built-ins and resolves permissions from the DB", { skip: dbSkip }, async () => {
  const svc = new RoleService(new RoleRepository(getPool()));
  await svc.syncBuiltins();
  await svc.reload();

  // Resolver now reflects the DB-backed built-in roles.
  assert.equal(can("super_admin", "companies:manage"), true);
  assert.equal(can("admin", "users:manage"), true);
  assert.equal(can("admin", "companies:manage"), false); // super-admin-only
  assert.equal(can("readonly", "users:manage"), false);
  // New permissions added this pass reach the built-ins via syncBuiltins.
  assert.equal(can("user", "vpn:manage"), true);
  assert.equal(can("user", "vpn:reveal"), true);
  assert.ok(svc.has("auditor"));
  assert.equal(svc.has("ghost_role"), false);
});
