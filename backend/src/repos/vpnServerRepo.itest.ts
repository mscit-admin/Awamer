import { test, after } from "node:test";
import assert from "node:assert/strict";
import forge from "node-forge";
import { createSecretBox } from "../crypto/secretBox.js";
import { createArgon2 } from "../crypto/argon2.js";
import { loadConfig } from "../config/index.js";
import { VpnServerRepository } from "./vpnServerRepo.js";
import { assembleClientOvpn } from "../domain/vpnServer.js";
import { getPool, closePool, seedUser, deleteUser, dbSkip } from "../test/db.js";

const box = createSecretBox(Buffer.from("0123456789abcdef0123456789abcdef"));
const created: string[] = [];
after(async () => {
  for (const id of created) await deleteUser(id).catch(() => {});
  await closePool();
});

test("VPN server: PKI issuance, client cert chain, password verify, .ovpn, revoke", { skip: dbSkip }, async () => {
  const pool = getPool();
  const repo = new VpnServerRepository(pool, box, createArgon2(loadConfig()));
  const userId = await seedUser("admin");
  created.push(userId);

  // Create a server → generates CA + server cert + tls-crypt.
  // Port must be within the VPN port policy range (multi-server dynamic ports).
  const server = await repo.createServer(userId, { name: "hub", publicHost: "203.0.113.10", port: 20010, proto: "udp" });
  assert.match(server.caCert, /BEGIN CERTIFICATE/);
  assert.match(server.serverCert, /BEGIN CERTIFICATE/);
  assert.match(server.tlsCrypt, /OpenVPN Static key V1/);
  assert.match(server.caKey, /BEGIN RSA PRIVATE KEY/); // decrypted on read

  // Private key is encrypted at rest (no plaintext key in the row).
  const raw = await pool.query<{ ca_key_enc: unknown }>(`SELECT ca_key_enc FROM vpn_servers WHERE id=$1`, [server.id]);
  assert.ok(!JSON.stringify(raw.rows[0]!.ca_key_enc).includes("RSA PRIVATE KEY"), "CA key must be encrypted");

  // Create a client → CA-signed cert + password hash.
  const client = await repo.createClient(userId, server.id, { name: "edge-01", username: "edge01", password: "S3cret!pw" });
  const caCert = forge.pki.certificateFromPem(server.caCert);
  const clientCert = forge.pki.certificateFromPem(client.cert);
  assert.ok(caCert.verify(clientCert), "client cert must be signed by the server's CA");

  // Password verifies against the stored argon2 hash; wrong one fails.
  const argon2 = createArgon2(loadConfig());
  assert.equal(await argon2.verify(client.passwordHash, "S3cret!pw"), true);
  assert.equal(await argon2.verify(client.passwordHash, "wrong"), false);

  // Assemble the downloadable .ovpn for this client.
  const ovpn = assembleClientOvpn({
    proto: server.proto, publicHost: server.publicHost, port: server.port, cipher: server.cipher,
    caCert: server.caCert, clientCert: client.cert, clientKey: client.key, tlsCrypt: server.tlsCrypt,
  });
  assert.match(ovpn, /^remote 203\.0\.113\.10 20010$/m);
  assert.match(ovpn, /<cert>/);
  assert.match(ovpn, /BEGIN OpenVPN Static key V1/);

  // Revoke → flag flips; counts exclude revoked.
  await repo.setClientRevoked(userId, server.id, client.id, true);
  assert.equal((await repo.getClient(userId, server.id, client.id)).revoked, true);
  const counts = await repo.clientCounts([server.id]);
  assert.equal(counts.get(server.id) ?? 0, 0);
});
