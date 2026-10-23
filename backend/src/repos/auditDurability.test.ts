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

// ---------------------------------------------------------------------------
// SEC-AUDIT-EXPORT-001 — every audit event is mirrored to the structured log
// (shipped off-host by the container log driver). AUDIT-EXPORT-001..004.
// ---------------------------------------------------------------------------
function infoSpy() {
  const lines: Record<string, unknown>[] = [];
  return { logger: { info: (obj: Record<string, unknown>) => lines.push(obj), error() {} } as any, lines };
}

test("AUDIT-EXPORT-001: with export on, each event is also logged as event=audit", async () => {
  const { logger, lines } = infoSpy();
  const repo = new AuditRepository(okPool().pool, logger, true);
  await repo.log({ userId: "u1", action: "login", success: false, ipAddress: "203.0.113.9", details: { reason: "bad_password" } });
  assert.equal(lines.length, 1);
  assert.deepEqual(
    { event: lines[0]!.event, action: lines[0]!.action, userId: lines[0]!.userId, ip: lines[0]!.ip, details: lines[0]!.details },
    { event: "audit", action: "login_failed", userId: "u1", ip: "203.0.113.9", details: { reason: "bad_password" } },
  );
});

test("AUDIT-EXPORT-002: the off-host copy survives a failed DB write", async () => {
  const { logger, lines } = infoSpy();
  const repo = new AuditRepository(failPool(), logger, true);
  await repo.log({ userId: "u1", action: "credential_read", success: true });
  assert.equal(lines.filter((l) => l.event === "audit").length, 1);
});

test("AUDIT-EXPORT-003: with export off, nothing extra is logged", async () => {
  const { logger, lines } = infoSpy();
  await new AuditRepository(okPool().pool, logger, false).log({ userId: "u1", action: "host_create", success: true });
  assert.equal(lines.length, 0);
});

test("AUDIT-EXPORT-004: secret-named detail fields are redacted by the production logger", async () => {
  const { Writable } = await import("node:stream");
  const pino = (await import("pino")).default;
  const { loggerOptions } = await import("../logger/index.js");
  let out = "";
  const sink = new Writable({ write(c, _e, cb) { out += c.toString(); cb(); } });
  const log = pino(loggerOptions({ isProd: true, env: { LOG_LEVEL: "info", APP_ENV: "production" } } as any), sink);
  await new AuditRepository(okPool().pool, log, true).log({
    userId: "u1", action: "config_change", success: true, details: { op: "smtp_update", password: "SMTP-PW-SECRET" },
  });
  assert.match(out, /"event":"audit"/);
  assert.match(out, /"op":"smtp_update"/);
  assert.ok(!out.includes("SMTP-PW-SECRET"), out);
});
