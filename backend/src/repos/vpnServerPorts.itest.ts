/**
 * Multi-VPN-Server dynamic-port repository tests (real PostgreSQL).
 * VPN-SERVER-PORT-001.. : per-server port/proto, range/reserved validation,
 * (port,proto) uniqueness → vpn_port_in_use, subnet overlap, auto-assign,
 * legacy-port preservation on edit, and concurrency (VPN-CONCURRENCY).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createSecretBox } from "../crypto/secretBox.js";
import { createArgon2 } from "../crypto/argon2.js";
import { loadConfig } from "../config/index.js";
import { makeVpnPortPolicy } from "../domain/vpnPortPolicy.js";
import { VpnServerRepository } from "./vpnServerRepo.js";
import { getPool, closePool, seedUser, deleteUser, dbSkip } from "../test/db.js";

const box = createSecretBox(Buffer.from("0123456789abcdef0123456789abcdef"));
const policy = makeVpnPortPolicy({ min: 20000, max: 30000, reserved: [22, 80, 443, 8081, 5432, 6379] });
let repo: VpnServerRepository, userId = "";
const codeOf = (fn: () => Promise<unknown>) => fn().then(() => "OK", (e) => (e as { code?: string }).code ?? e.message);

before(async () => {
  if (dbSkip) return;
  repo = new VpnServerRepository(getPool(), box, createArgon2(loadConfig()), policy);
  userId = await seedUser("admin");
});
after(async () => {
  if (dbSkip) return;
  await getPool().query(`DELETE FROM vpn_servers WHERE user_id=$1`, [userId]).catch(() => {});
  await deleteUser(userId).catch(() => {});
  await closePool();
});
let n = 0;
const mk = (over: Record<string, unknown> = {}) => repo.createServer(userId, {
  name: `srv-${Date.now()}-${n++}`, publicHost: "203.0.113.10", proto: "udp", subnet: `10.9.${n}.0/24`, ...over,
});

test("VPN-SERVER-PORT-001: create with an in-range port succeeds and is authoritative", { skip: dbSkip }, async () => {
  const s = await mk({ port: 20001, proto: "udp", subnet: "10.20.1.0/24" });
  assert.equal(s.port, 20001); assert.equal(s.proto, "udp");
});
test("VPN-SERVER-PORT-002: out-of-range port rejected", { skip: dbSkip }, async () => {
  assert.equal(await codeOf(() => mk({ port: 1194, subnet: "10.20.2.0/24" })), "vpn_port_out_of_range");
  assert.equal(await codeOf(() => mk({ port: 30001, subnet: "10.20.3.0/24" })), "vpn_port_out_of_range");
});
test("VPN-SERVER-PORT-003: reserved port rejected", { skip: dbSkip }, async () => {
  const p = new VpnServerRepository(getPool(), box, createArgon2(loadConfig()), makeVpnPortPolicy({ min: 1, max: 65535, reserved: [443, 8081] }));
  assert.equal(await codeOf(() => p.createServer(userId, { name: `r-${n++}`, publicHost: "203.0.113.1", port: 443, proto: "udp", subnet: "10.21.0.0/24" })), "vpn_port_reserved");
});
test("VPN-SERVER-PORT-004: duplicate (port,proto) → vpn_port_in_use", { skip: dbSkip }, async () => {
  await mk({ port: 20050, proto: "udp", subnet: "10.22.1.0/24" });
  assert.equal(await codeOf(() => mk({ port: 20050, proto: "udp", subnet: "10.22.2.0/24" })), "vpn_port_in_use");
});
test("VPN-SERVER-PORT-005: same port, different protocol is allowed", { skip: dbSkip }, async () => {
  await mk({ port: 20060, proto: "udp", subnet: "10.23.1.0/24" });
  const tcp = await mk({ port: 20060, proto: "tcp", subnet: "10.23.2.0/24" });
  assert.equal(tcp.port, 20060); assert.equal(tcp.proto, "tcp");
});
test("VPN-SERVER-PORT-006: subnet overlap rejected; distinct accepted", { skip: dbSkip }, async () => {
  await mk({ port: 20070, subnet: "10.24.0.0/24" });
  assert.equal(await codeOf(() => mk({ port: 20071, subnet: "10.24.0.128/25" })), "vpn_subnet_overlap");
  const ok = await mk({ port: 20072, subnet: "10.25.0.0/24" });
  assert.equal(ok.subnet, "10.25.0.0/24");
});
test("VPN-SERVER-PORT-007: auto-assign picks a free in-range port", { skip: dbSkip }, async () => {
  const s = await mk({ autoAssignPort: true, proto: "tcp", subnet: "10.26.0.0/24" });
  assert.ok(s.port >= policy.min && s.port <= policy.max, `assigned ${s.port}`);
});
test("VPN-SERVER-PORT-008: editing an unrelated field preserves a grandfathered legacy port", { skip: dbSkip }, async () => {
  // Simulate a legacy row with a port outside the current range (pre-migration).
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO vpn_servers (user_id,name,public_host,port,proto,subnet,ca_cert,server_cert)
     VALUES ($1,$2,'203.0.113.9',1194,'udp','10.27.0.0/24','x','y') RETURNING id`, [userId, `legacy-${n++}`]);
  const id = rows[0]!.id;
  const upd = await repo.updateServer(userId, id, { description: "renamed" }); // port unchanged
  assert.equal(upd.port, 1194, "legacy port preserved when not changed");
  // But changing it to another out-of-range port is rejected.
  assert.equal(await codeOf(() => repo.updateServer(userId, id, { port: 1195 })), "vpn_port_out_of_range");
});
test("VPN-CONCURRENCY: 20 concurrent creates on the same port → 1 success, 19 conflict", { skip: dbSkip }, async () => {
  const port = 20500;
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) =>
    codeOf(() => repo.createServer(userId, { name: `cc-${Date.now()}-${i}`, publicHost: "203.0.113.5", port, proto: "udp", subnet: `10.40.${i}.0/24` }))));
  const ok = results.filter((r) => r === "OK").length;
  const conflict = results.filter((r) => r === "vpn_port_in_use").length;
  assert.equal(ok, 1, `exactly one success (got ${ok})`);
  assert.equal(conflict, 19, `nineteen conflicts (got ${conflict})`);
});
test("VPN-CONCURRENCY-AUTO: concurrent auto-assign yields unique ports", { skip: dbSkip }, async () => {
  const rp = new VpnServerRepository(getPool(), box, createArgon2(loadConfig()), makeVpnPortPolicy({ min: 25000, max: 25010, reserved: [] }));
  const servers = await Promise.all(Array.from({ length: 8 }, (_, i) =>
    rp.createServer(userId, { name: `aa-${Date.now()}-${i}`, publicHost: "203.0.113.6", proto: "udp", autoAssignPort: true, subnet: `10.41.${i}.0/24` })
      .then((s) => s.port, () => null)));
  const ports = servers.filter((p): p is number => p !== null);
  assert.equal(new Set(ports).size, ports.length, `all assigned ports unique: ${ports}`);
});
