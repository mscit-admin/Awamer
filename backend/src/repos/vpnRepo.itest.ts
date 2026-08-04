import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createSecretBox } from "../crypto/secretBox.js";
import { VpnProfileRepository } from "./vpnRepo.js";
import { getPool, closePool, seedUser, deleteUser, dbSkip } from "../test/db.js";

const box = createSecretBox(Buffer.from("0123456789abcdef0123456789abcdef")); // 32 bytes
const createdUsers: string[] = [];

after(async () => {
  for (const id of createdUsers) await deleteUser(id).catch(() => {});
  await closePool();
});

test("vpnRepo: encrypts secrets at rest and round-trips them", { skip: dbSkip }, async () => {
  const pool = getPool();
  const repo = new VpnProfileRepository(pool, box);
  const userId = await seedUser();
  createdUsers.push(userId);

  const profile = await repo.create(userId, {
    name: "hq", runtime: "backend", source: "config", authMode: "userpass",
    secret: { ovpn: "client\ndev tun\n", username: "u", password: "p" },
  });

  // Stored ciphertext is not plaintext.
  const raw = await pool.query<{ secret_data: unknown }>(
    `SELECT secret_data FROM vpn_profiles WHERE id = $1`, [profile.id]);
  const stored = JSON.stringify(raw.rows[0]!.secret_data);
  assert.ok(!stored.includes("client"), "config text must not be stored in plaintext");
  assert.ok(!stored.includes("\"p\""), "password must not be stored in plaintext");

  // Repository read decrypts transparently.
  const got = await repo.getById(userId, profile.id);
  assert.equal(got.secret.username, "u");
  assert.equal(got.secret.password, "p");
  assert.match(got.secret.ovpn ?? "", /client/);

  // Update replaces the secret bundle.
  const upd = await repo.update(userId, profile.id, { secret: { ovpn: "client\nremote x 1\n" } });
  assert.match(upd.secret.ovpn ?? "", /remote x 1/);
  assert.equal(upd.secret.username, undefined);

  assert.equal((await repo.listForUser(userId)).length, 1);
});

test("vpnRepo.resolveForHost: host override wins, else nearest ancestor folder", { skip: dbSkip }, async () => {
  const pool = getPool();
  const repo = new VpnProfileRepository(pool, box);
  const userId = await seedUser();
  createdUsers.push(userId);

  const pA = await repo.create(userId, { name: "profA", secret: { ovpn: "client\n" } });
  const pHost = await repo.create(userId, { name: "profHost", secret: { ovpn: "client\n" } });

  // folderA(vpn=pA) -> folderB(no vpn) -> host
  const fa = await pool.query<{ id: string }>(
    `INSERT INTO folders (user_id, name, vpn_profile_id) VALUES ($1,'A',$2) RETURNING id`, [userId, pA.id]);
  const fb = await pool.query<{ id: string }>(
    `INSERT INTO folders (user_id, parent_id, name) VALUES ($1,$2,'B') RETURNING id`, [userId, fa.rows[0]!.id]);
  const host = await pool.query<{ id: string }>(
    `INSERT INTO hosts (user_id, folder_id, name, hostname, port, protocol)
     VALUES ($1,$2,'h1','10.0.0.1',22,'ssh') RETURNING id`, [userId, fb.rows[0]!.id]);
  const hostId = host.rows[0]!.id;

  // No host profile → inherits folderA's via the B→A chain.
  let resolved = await repo.resolveForHost(userId, hostId);
  assert.equal(resolved?.id, pA.id, "should inherit nearest ancestor folder profile");

  // Host's own profile overrides the inherited one.
  await pool.query(`UPDATE hosts SET vpn_profile_id = $2 WHERE id = $1`, [hostId, pHost.id]);
  resolved = await repo.resolveForHost(userId, hostId);
  assert.equal(resolved?.id, pHost.id, "host's own profile should win");

  // No host profile and no ancestor profile → null.
  await pool.query(`UPDATE hosts SET vpn_profile_id = NULL, folder_id = NULL WHERE id = $1`, [hostId]);
  resolved = await repo.resolveForHost(userId, hostId);
  assert.equal(resolved, null);
});
