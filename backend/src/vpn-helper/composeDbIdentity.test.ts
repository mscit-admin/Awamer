/**
 * DB-LEAST-PRIVILEGE / GO-LIVE — static production-compose contract.
 * No long-running service may hold the cluster-admin (superuser) credentials;
 * each service uses its least-privilege role; migrations run as a separate
 * one-shot job before the backend; the backend never migrates or uses the
 * migration owner; images carry the release identity.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const COMPOSE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "deploy", "docker-compose.production.yml");
const stripComments = (s: string) => s.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
const svc: Record<string, string> = {};
before(() => {
  const full = stripComments(readFileSync(COMPOSE, "utf8"));
  const body = full.slice(full.indexOf("\nservices:"), full.indexOf("\nvolumes:"));
  for (const m of body.split(/\n(?= {2}[a-z][a-z0-9-]*:\s*\n)/)) {
    const name = /^\s*([a-z][a-z0-9-]*):/.exec(m)?.[1];
    if (name && name !== "services") svc[name] = m;
  }
  for (const n of ["postgres", "db-provision", "migrate", "auth-service", "vpn-helper"]) assert.ok(svc[n], `service ${n} present`);
});

test("COMPOSE-DB-001: cluster-admin credentials only in postgres + the one-shot db-provision", () => {
  for (const [name, body] of Object.entries(svc)) {
    if (name === "postgres" || name === "db-provision") continue;
    assert.doesNotMatch(body, /POSTGRES_USER|POSTGRES_PASSWORD/, name);
  }
  assert.match(svc["db-provision"]!, /restart:\s*"no"/);
});

test("COMPOSE-DB-002: each service connects with its least-privilege role", () => {
  assert.match(svc["auth-service"]!, /DATABASE_URL:\s*postgres:\/\/awamer_app:\$\{AWAMER_APP_DB_PASSWORD/);
  assert.match(svc["migrate"]!, /DATABASE_URL:\s*postgres:\/\/awamer_migrator:\$\{AWAMER_MIGRATOR_DB_PASSWORD/);
  assert.match(svc["vpn-helper"]!, /DATABASE_URL:\s*postgres:\/\/awamer_vpn_auth:\$\{AWAMER_VPN_AUTH_DB_PASSWORD/);
  assert.doesNotMatch(svc["auth-service"]!, /awamer_migrator|DB_ALLOW_PRIVILEGED_RUNTIME/);
});

test("COMPOSE-DB-003: provision → migrate → backend ordering; backend does not migrate", () => {
  assert.match(svc["migrate"]!, /db-provision:\s*\n\s*condition:\s*service_completed_successfully/);
  assert.match(svc["auth-service"]!, /migrate:\s*\n\s*condition:\s*service_completed_successfully/);
  assert.doesNotMatch(svc["auth-service"]!, /migrate\.js/);
  assert.match(svc["migrate"]!, /dist\/migrate\.js", "up"/);
});

test("COMPOSE-HARDEN-001: backend/migrate/provision are read-only, unprivileged, no docker socket", () => {
  for (const n of ["auth-service", "migrate", "db-provision"]) {
    assert.match(svc[n]!, /read_only:\s*true/, n);
    assert.match(svc[n]!, /cap_drop:\s*\n\s*-\s*ALL/, n);
    assert.match(svc[n]!, /no-new-privileges:true/, n);
  }
  for (const [name, body] of Object.entries(svc)) {
    assert.doesNotMatch(body, /docker\.sock/, name);
    assert.doesNotMatch(body, /privileged:\s*true/, name);
    if (name !== "vpn-helper") assert.doesNotMatch(body, /NET_ADMIN|network_mode:\s*host/, name);
  }
});

test("COMPOSE-REL-001: images are tagged with the mandatory release and built with traceability args", () => {
  for (const n of ["auth-service", "vpn-helper"]) {
    assert.match(svc[n]!, /image:\s*netsphere\/[a-z-]+:\$\{APP_VERSION:\?/, n);
    assert.match(svc[n]!, /GIT_COMMIT:\s*\$\{GIT_COMMIT/, n);
  }
  assert.match(svc["migrate"]!, /pull_policy:\s*never/);
});
