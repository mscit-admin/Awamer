/**
 * SEC-003 regression (integration) — shared resources must not cross company
 * boundaries. Runs against a real migrated PostgreSQL (see src/test/db.ts);
 * skips when no DATABASE_URL is configured.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { getPool, closePool, dbSkip } from "../test/db.js";
import { HostRepository } from "./sessionRepos.js";
import { NotesRepository } from "./notesRepo.js";
import { UserRepository } from "./userRepo.js";

const pool = () => getPool();

async function makeCompany(name: string): Promise<string> {
  const { rows } = await pool().query<{ id: string }>(
    `INSERT INTO companies (id, name) VALUES (gen_random_uuid(), $1) RETURNING id`, [name]);
  return rows[0]!.id;
}
async function makeUser(companyId: string): Promise<string> {
  const { rows } = await pool().query<{ id: string }>(
    `INSERT INTO users (id, username, email, password_hash, role, company_id)
     VALUES (gen_random_uuid(), 'ti_' || substr(md5(random()::text),1,12),
             'ti_' || substr(md5(random()::text),1,12) || '@t.local', 'x', 'user', $1)
     RETURNING id`, [companyId]);
  return rows[0]!.id;
}

let compA = "", compB = "", userA1 = "", userA2 = "", userB = "";

before(async () => {
  if (dbSkip) return;
  compA = await makeCompany("TI Company A");
  compB = await makeCompany("TI Company B");
  userA1 = await makeUser(compA);
  userA2 = await makeUser(compA);
  userB = await makeUser(compB);
});

after(async () => {
  if (dbSkip) return;
  await pool().query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[userA1, userA2, userB]]);
  await pool().query(`DELETE FROM companies WHERE id = ANY($1::uuid[])`, [[compA, compB]]);
  await closePool();
});

test("hosts: a shared host is visible in-company but NOT across companies", { skip: dbSkip }, async () => {
  const hosts = new HostRepository(pool());
  const h = await hosts.create({
    userId: userA1, name: "shared-A-" + Date.now(), hostname: "10.0.0.5", port: 22,
    protocol: "ssh", isShared: true,
  });

  // Same company sees it (list + getById).
  const a2List = await hosts.list(userA2);
  assert.ok(a2List.hosts.some((x) => x.id === h.id), "same-company user sees the shared host");
  await assert.doesNotReject(() => hosts.getById(userA2, h.id), "same-company getById succeeds");

  // Cross company must NOT see it — list omits it, getById 404s (non-disclosing).
  const bList = await hosts.list(userB);
  assert.equal(bList.hosts.some((x) => x.id === h.id), false, "cross-company user must NOT see the shared host");
  const isHostNotFound = (e: unknown) => (e as { code?: string }).code === "host_not_found";
  await assert.rejects(() => hosts.getById(userB, h.id), isHostNotFound, "cross-company getById denied");
  await assert.rejects(() => hosts.touch(userB, h.id), isHostNotFound, "cross-company touch denied");
});

test("notes: a shared note is visible in-company but NOT across companies", { skip: dbSkip }, async () => {
  const notes = new NotesRepository(pool());
  const n = await notes.create(userA1, { body: "secret note A" });
  await notes.update(userA1, n.id, { isShared: true });

  const a2 = await notes.list(userA2);
  assert.ok(a2.some((x) => x.id === n.id), "same-company user sees the shared note");

  const b = await notes.list(userB);
  assert.equal(b.some((x) => x.id === n.id), false, "cross-company user must NOT see the shared note");
});

test("moving a user's company moves their shared resources with them", { skip: dbSkip }, async () => {
  const hosts = new HostRepository(pool());
  const users = new UserRepository(pool());

  // A fresh owner in company A with a shared host.
  const owner = await makeUser(compA);
  const h = await hosts.create({ userId: owner, name: "moving-" + Date.now(), hostname: "10.0.0.9", port: 22, protocol: "ssh", isShared: true });
  assert.equal((await hosts.list(userB)).hosts.some((x) => x.id === h.id), false, "not visible to B before move");

  // Move the owner into company B → their shared host follows.
  await users.setOrg(owner, compB, null);
  assert.ok((await hosts.list(userB)).hosts.some((x) => x.id === h.id), "visible to B after owner moves to B");
  assert.equal((await hosts.list(userA2)).hosts.some((x) => x.id === h.id), false, "no longer visible to A after move");

  await pool().query(`DELETE FROM users WHERE id = $1`, [owner]);
});
