import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { awaitAuthFrame } from "./gateway.js";

// SEC-001 regression: the gateway must take its token + SSH secrets from the
// first WS *frame*, never the URL. awaitAuthFrame is the channel-auth primitive.

function fakeWs() {
  const ee = new EventEmitter();
  return ee as unknown as import("ws").WebSocket & EventEmitter;
}
const msg = (ws: EventEmitter, obj: unknown) => ws.emit("message", Buffer.from(JSON.stringify(obj)), false);

test("resolves with token + password + passphrase from the auth frame", async () => {
  const ws = fakeWs();
  const p = awaitAuthFrame(ws, 1000);
  msg(ws as unknown as EventEmitter, { type: "auth", token: "jwt", password: "s3cret", passphrase: "pp" });
  const frame = await p;
  assert.deepEqual(frame, { token: "jwt", password: "s3cret", passphrase: "pp" });
});

test("password/passphrase default to null when omitted", async () => {
  const ws = fakeWs();
  const p = awaitAuthFrame(ws, 1000);
  msg(ws as unknown as EventEmitter, { type: "auth", token: "jwt" });
  assert.deepEqual(await p, { token: "jwt", password: null, passphrase: null });
});

test("ignores non-auth frames, then accepts the auth frame", async () => {
  const ws = fakeWs();
  const p = awaitAuthFrame(ws, 1000);
  const ee = ws as unknown as EventEmitter;
  msg(ee, { type: "resize", cols: 100, rows: 40 });
  ee.emit("message", Buffer.from("not json"), false);
  ee.emit("message", Buffer.from(JSON.stringify({ type: "auth", token: "late" })), true); // binary → ignored
  msg(ee, { type: "auth", token: "good" });
  assert.equal((await p)?.token, "good");
});

test("rejects (null) an auth frame without a token", async () => {
  const ws = fakeWs();
  const p = awaitAuthFrame(ws, 120);
  msg(ws as unknown as EventEmitter, { type: "auth" }); // no token → ignored
  assert.equal(await p, null, "times out to null when no valid auth arrives");
});

test("resolves null when the socket closes before auth", async () => {
  const ws = fakeWs();
  const p = awaitAuthFrame(ws, 1000);
  (ws as unknown as EventEmitter).emit("close");
  assert.equal(await p, null);
});

test("resolves null on timeout", async () => {
  const ws = fakeWs();
  assert.equal(await awaitAuthFrame(ws, 60), null);
});
