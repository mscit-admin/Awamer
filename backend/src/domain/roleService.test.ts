import { test } from "node:test";
import assert from "node:assert/strict";
import { RoleService } from "./roleService.js";
import { can, permissionsFor, setPermissionResolver } from "./permissions.js";
import type { RoleRepository, RoleRecord } from "../repos/roleRepo.js";

// Minimal in-memory RoleRepository — only the methods RoleService touches.
function fakeRepo(roles: Array<Pick<RoleRecord, "key" | "permissions">>) {
  const upserted: string[] = [];
  const repo = {
    async listAll() {
      return roles.map((r) => ({
        key: r.key, name: r.key, description: "", permissions: r.permissions,
        isBuiltin: false, createdAt: new Date(0), updatedAt: new Date(0),
      })) as unknown as RoleRecord[];
    },
    async upsertBuiltin(b: { key: string }) { upserted.push(b.key); },
  } as unknown as RoleRepository;
  return { repo, upserted };
}

test("reload installs a resolver reflecting the DB role definitions", async () => {
  const { repo } = fakeRepo([
    { key: "custom_auditor", permissions: ["audit:read"] },
    { key: "custom_empty", permissions: [] },
  ]);
  const svc = new RoleService(repo);
  try {
    await svc.reload();
    assert.deepEqual([...permissionsFor("custom_auditor")], ["audit:read"]);
    assert.equal(can("custom_auditor", "audit:read"), true);
    assert.equal(can("custom_auditor", "users:manage"), false);
    assert.equal(can("custom_empty", "audit:read"), false);
    // Unknown role resolves to no permissions, never throws.
    assert.deepEqual([...permissionsFor("nonexistent")], []);
    assert.equal(svc.has("custom_auditor"), true);
    assert.equal(svc.has("ghost"), false);
  } finally {
    setPermissionResolver(null); // revert to the static matrix for other tests
  }
});

test("syncBuiltins upserts every built-in role from the code catalog", async () => {
  const { repo, upserted } = fakeRepo([]);
  const svc = new RoleService(repo);
  await svc.syncBuiltins();
  for (const key of ["super_admin", "admin", "user", "readonly", "auditor"]) {
    assert.ok(upserted.includes(key), `expected built-in ${key} to be upserted`);
  }
});
