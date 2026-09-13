/**
 * SEC-INFRA-001 — static compose contract (INFRA-VPN-001..009). Asserts the
 * production docker-compose keeps the backend UNPRIVILEGED and confines the
 * privileged bits to the vpn-helper. The mandatory proof is the live Docker
 * runtime validation (see FINAL_SEC_INFRA_001_REMEDIATION_REPORT.md); this guards
 * the compose file against regressions in CI without needing a daemon.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const COMPOSE = join(HERE, "..", "..", "..", "deploy", "docker-compose.production.yml");

let full = "", backend = "", helper = "";
/** Drop full-line comments so assertions test DIRECTIVES, not explanatory prose. */
const stripComments = (s: string) => s.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
before(() => {
  full = readFileSync(COMPOSE, "utf8");
  // Split into per-service slices by their top-level keys (2-space indent).
  const authIdx = full.indexOf("\n  auth-service:");
  const helperIdx = full.indexOf("\n  vpn-helper:");
  const volIdx = full.indexOf("\nvolumes:");
  assert.ok(authIdx > 0 && helperIdx > authIdx && volIdx > helperIdx, "expected auth-service then vpn-helper then volumes");
  backend = stripComments(full.slice(authIdx, helperIdx));
  helper = stripComments(full.slice(helperIdx, volIdx));
});

test("INFRA-VPN-001: backend runs as a non-root user (10001)", () => {
  assert.match(backend, /user:\s*"10001:10001"/);
  assert.doesNotMatch(backend, /user:\s*"0:0"/);
});
test("INFRA-VPN-002: backend has NO NET_ADMIN", () => {
  assert.doesNotMatch(backend, /NET_ADMIN/);
});
test("INFRA-VPN-003: backend has NO /dev/net/tun device", () => {
  assert.doesNotMatch(backend, /\/dev\/net\/tun/);
});
test("INFRA-VPN-004: backend drops ALL capabilities", () => {
  assert.match(backend, /cap_drop:\s*\n\s*-\s*ALL/);
});
test("INFRA-VPN-005: backend sets no-new-privileges", () => {
  assert.match(backend, /no-new-privileges:true/);
});
test("INFRA-VPN-008a: backend is not privileged", () => {
  assert.doesNotMatch(backend, /privileged:\s*true/);
});
test("INFRA-VPN-006: vpn-helper adds NET_ADMIN", () => {
  assert.match(helper, /cap_add:\s*\n\s*-\s*NET_ADMIN/);
});
test("INFRA-VPN-007: vpn-helper has the /dev/net/tun device", () => {
  assert.match(helper, /\/dev\/net\/tun:\/dev\/net\/tun/);
});
test("INFRA-VPN-008b: vpn-helper drops ALL then adds only NET_ADMIN, not privileged", () => {
  assert.match(helper, /cap_drop:\s*\n\s*-\s*ALL/);
  assert.doesNotMatch(helper, /privileged:\s*true/);
  // No capability other than NET_ADMIN is added.
  const adds = [...helper.matchAll(/cap_add:\s*\n((?:\s*-\s*\w+\s*\n?)+)/g)].map((m) => m[1]).join("");
  const caps = [...adds.matchAll(/-\s*(\w+)/g)].map((m) => m[1]);
  assert.deepEqual(caps, ["NET_ADMIN"]);
});
test("INFRA-VPN-009 / VPN-DATAPLANE-003: helper uses host networking (dynamic ports) and publishes NO control port", () => {
  // Multi-VPN-Server: with network_mode host each VPN Server's OpenVPN listener
  // binds its own host port dynamically (no static publish, no recreation). The
  // helper has NO `ports:` mapping at all, and its control/IPC surface is the
  // Unix socket in the shared volume — never a published network port.
  assert.match(helper, /network_mode:\s*host/, "helper uses host networking for dynamic VPN ports");
  assert.doesNotMatch(helper, /\n\s*ports:\s*\n/, "helper defines no static published ports");
  // The IPC socket is a volume, never a port mapping.
  assert.doesNotMatch(helper, /-\s*"[^"]*:\/run\/awamer/);
});
test("VPN-DATAPLANE: firewall backend + port range env are present on the helper", () => {
  assert.match(helper, /VPN_FIREWALL_BACKEND/);
  assert.match(helper, /VPN_SERVER_PORT_MIN/);
  assert.match(helper, /VPN_SERVER_PORT_MAX/);
});
test("INFRA-VPN-005b: vpn-helper sets no-new-privileges", () => {
  assert.match(helper, /no-new-privileges:true/);
});
