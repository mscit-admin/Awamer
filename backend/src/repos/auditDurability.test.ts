/**
 * SEC-AUDIT-001 — audit writes are durable/observable, not silently swallowed.
 * AUDIT-DURABILITY-001..006. Unit tests with a fake pool + spy logger.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { AuditRepository, getAuditWriteFailuresTotal } from "./otherRepos.js";

function spyLogger() {
  const calls: { obj: Record<string, unknown>; msg: string }[] = [];
  return {
    logger: { error: (obj: Record<string, unknown>, msg: string) => calls.push({ obj, msg }) } as any,
    calls,
  };
}
function okPool() {
  const queries: unknown[][] = [];
  return { pool: { query: async (_sql: string, params: unknown[]) => { queries.push(params); return { rows: [] }; } } as any, queries };
}
function failPool() {
  return { query: async () => { const e = new Error("connection terminated") as Error & { code?: string }; e.code = "57P01"; throw e; } } as any;
}

test("AUDIT-DURABILITY-001: a successful action writes an audit row", async () => {
  const { pool, queries } = okPool();
  const repo = new AuditRepository(pool);
  await repo.log({ userId: "u1", action: "host_create", success: true, resourceType: "host", resourceId: "h1" });
  assert.equal(queries.length, 1);
  assert.equal(queries[0]![1], "host_create"); // real action preserved (not "config_change")
});

test("AUDIT-DURABILITY-bonus: unknown actions are preserved, not rewritten", async () => {
  const { pool, queries } = okPool();
  const repo = new AuditRepository(pool);
  await repo.log({ userId: "u1", action: "connection_start", success: true });
  assert.equal(queries[0]![1], "connection_start");
});

test("AUDIT-DURABILITY-002/006: a DB failure emits an app error and never throws (fail-open)", async () => {
  const { logger, calls } = spyLogger();
  const repo = new AuditRepository(failPool(), logger);
  await assert.doesNotReject(() => repo.log({ userId: "u1", action: "password_change", success: true }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.obj.event, "audit_write_failed");
  assert.equal(calls[0]!.obj.action, "password_change");
});

test("AUDIT-DURABILITY-003: the failure metric increments", async () => {
  const { logger } = spyLogger();
  const repo = new AuditRepository(failPool(), logger);
  const before = getAuditWriteFailuresTotal();
  await repo.log({ userId: "u1", action: "user_delete", success: true });
  assert.equal(getAuditWriteFailuresTotal(), before + 1);
});

test("AUDIT-DURABILITY-004: secret payload is NOT logged on failure", async () => {
  const { logger, calls } = spyLogger();
  const repo = new AuditRepository(failPool(), logger);
  await repo.log({
    userId: "u1", action: "credential_read", success: true,
    details: { secret: "TOP-SECRET-VALUE", password: "hunter2" },
  });
  const logged = JSON.stringify(calls[0]!.obj);
  assert.ok(!logged.includes("TOP-SECRET-VALUE"), "secret detail must not be logged");
  assert.ok(!logged.includes("hunter2"), "password detail must not be logged");
  assert.ok(!("details" in calls[0]!.obj), "details object must not be attached to the failure log");
});

test("AUDIT-DURABILITY-005: request id is preserved in the failure log", async () => {
  const { logger, calls } = spyLogger();
  const repo = new AuditRepository(failPool(), logger);
  await repo.log({ userId: "u1", action: "role_change", success: true, requestId: "req-abc-123" });
  assert.equal(calls[0]!.obj.requestId, "req-abc-123");
});
