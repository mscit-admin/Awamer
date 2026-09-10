/**
 * SEC-015 — cross-company explicit sharing must be denied (integration, real PG).
 * Covers TEST-TENANT-SHARE-001..008. Skips without DATABASE_URL.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { getPool, closePool, dbSkip } from "../test/db.js";
import { HostRepository } from "./sessionRepos.js";
import { NotesRepository } from "./notesRepo.js";

const pool = () => getPool();
const isCross = (e: unknown) => (e as { code?: string }).code === "cross_company_share";
const isNotFound = (e: unknown) => (e as { code?: string }).code === "host_not_found";

let compA = "", compB = "", ownerA = "", userA2 = "", userB = "", hostA = "", noteA = "";

async function mkCompany(n: string) { const { rows } = await pool().query<{ id: string }>(`INSERT INTO companies (id,name) VALUES (gen_random_uuid(),$1) RETURNING id`, [n]); return rows[0]!.id; }
async function mkUser(c: string) { const { rows } = await pool().query<{ id: string }>(`INSERT INTO users (id,username,email,password_hash,role,company_id) VALUES (gen_random_uuid(),'ts_'||substr(md5(random()::text),1,12),'ts_'||substr(md5(random()::text),1,12)||'@t.local','x','user',$1) RETURNING id`, [c]); return rows[0]!.id; }

before(async () => {
  if (dbSkip) return;
  compA = await mkCompany("TS A"); compB = await mkCompany("TS B");
  ownerA = await mkUser(compA); userA2 = await mkUser(compA); userB = await mkUser(compB);
  const hosts = new HostRepository(pool());
  const notes = new NotesRepository(pool());
  hostA = (await hosts.create({ userId: ownerA, name: "ts-host-" + Date.now(), hostname: "10.0.0.7", port: 22, protocol: "ssh", isShared: false })).id;
  noteA = (await notes.create(ownerA, { body: "ts note" })).id;
});

after(async () => {
  if (dbSkip) return;
  await pool().query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[ownerA, userA2, userB]]);
  await pool().query(`DELETE FROM companies WHERE id = ANY($1::uuid[])`, [[compA, compB]]);
  await closePool();
});

test("TEST-TENANT-SHARE-001: host share to a foreign-company user is denied", { skip: dbSkip }, async () => {
  const hosts = new HostRepository(pool());
  await assert.rejects(() => hosts.setShares(ownerA, hostA, [userB]), isCross);
  assert.deepEqual(await hosts.getShareUserIds(ownerA, hostA), [], "no share persisted");
});

test("TEST-TENANT-SHARE-002: same-company host share succeeds", { skip: dbSkip }, async () => {
  const hosts = new HostRepository(pool());
  await hosts.setShares(ownerA, hostA, [userA2]);
  assert.deepEqual(await hosts.getShareUserIds(ownerA, hostA), [userA2]);
});

test("TEST-TENANT-SHARE-003: note share to a foreign-company user is denied", { skip: dbSkip }, async () => {
  const notes = new NotesRepository(pool());
  await assert.rejects(() => notes.setShares(ownerA, noteA, [userB]), isCross);
});

test("TEST-TENANT-SHARE-004: same-company note share succeeds", { skip: dbSkip }, async () => {
  const notes = new NotesRepository(pool());
  assert.equal(await notes.setShares(ownerA, noteA, [userA2]), true);
});

test("TEST-TENANT-SHARE-005: mixed list [valid, foreign] denies the ENTIRE op (no partial)", { skip: dbSkip }, async () => {
  const hosts = new HostRepository(pool());
  // fresh host so we can assert nothing was written
  const fresh = (await hosts.create({ userId: ownerA, name: "ts-mix-" + Date.now(), hostname: "10.0.0.8", port: 22, protocol: "ssh" })).id;
  await assert.rejects(() => hosts.setShares(ownerA, fresh, [userA2, userB]), isCross);
  assert.deepEqual(await hosts.getShareUserIds(ownerA, fresh), [], "no recipient shared at all");
});

test("TEST-TENANT-SHARE-006: a stale cross-company share row is still denied on read (defense in depth)", { skip: dbSkip }, async () => {
  const hosts = new HostRepository(pool());
  // Bypass setShares to plant a forbidden row, simulating pre-fix data.
  await pool().query(`INSERT INTO host_shares (host_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [hostA, userB]);
  await assert.rejects(() => hosts.getById(userB, hostA), isNotFound, "cross-company read denied even with an explicit share row");
  const list = await hosts.list(userB);
  assert.equal(list.hosts.some((h) => h.id === hostA), false, "not in the foreign user's list");
  await assert.rejects(() => hosts.touch(userB, hostA), isNotFound);
  await pool().query(`DELETE FROM host_shares WHERE host_id=$1 AND user_id=$2`, [hostA, userB]);
});

test("TEST-TENANT-SHARE-007: same-company recipient CAN read the shared host; foreign cannot", { skip: dbSkip }, async () => {
  const hosts = new HostRepository(pool());
  await hosts.setShares(ownerA, hostA, [userA2]);
  await assert.doesNotReject(() => hosts.getById(userA2, hostA), "same-company share reads");
  assert.ok((await hosts.list(userA2)).hosts.some((h) => h.id === hostA));
  await assert.rejects(() => hosts.getById(userB, hostA), isNotFound);
});

test("TEST-TENANT-SHARE-008: foreign user cannot reach a shared host's credential path (getById denies)", { skip: dbSkip }, async () => {
  // Credential/connection resolution goes through HostRepository.getById, which
  // denies the foreign user — so no credential or connect capability leaks.
  const hosts = new HostRepository(pool());
  await hosts.update(ownerA, hostA, { isShared: true }); // even instance-shared
  await assert.rejects(() => hosts.getById(userB, hostA), isNotFound);
});
