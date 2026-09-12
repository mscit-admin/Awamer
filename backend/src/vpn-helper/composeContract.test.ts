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
test("INFRA-VPN-009 / VPN-DATAPLANE-003: helper publishes ONLY the OpenVPN data port, never a control port", () => {
  // SEC-INFRA-DEPLOY-002: the helper publishes the OpenVPN SERVER data-plane
  // port (OPENVPN_SERVER_PORT, default 1194 udp+tcp) so external VPN clients can
  // connect. Its control/IPC surface is the Unix socket in the shared volume and
  // is NEVER published. Assert every published port is the OpenVPN data port and
  // that the IPC socket path is a volume, not a port.
  const portsBlock = /\n\s*ports:\s*\n((?:\s*-\s*"[^"]+"\s*\n?)+)/.exec(helper)?.[1] ?? "";
  const mappings = [...portsBlock.matchAll(/-\s*"([^"]+)"/g)].map((m) => m[1]!);
  assert.ok(mappings.length >= 1, "helper publishes the OpenVPN data port");
  for (const m of mappings) {
    assert.match(m, /OPENVPN_SERVER_PORT|1194/, `published port ${m} is the OpenVPN data port`);
    assert.match(m, /\/(udp|tcp)$/, `published port ${m} is a udp/tcp data mapping`);
  }
  // The IPC socket is never a published port.
  assert.doesNotMatch(portsBlock, /vpn-helper\.sock/);
  assert.doesNotMatch(helper, /-\s*"[^"]*:\/run\/awamer/);
});
test("INFRA-VPN-005b: vpn-helper sets no-new-privileges", () => {
  assert.match(helper, /no-new-privileges:true/);
});
