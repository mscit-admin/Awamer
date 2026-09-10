import { test } from "node:test";
import assert from "node:assert/strict";
import { VncTicketStore } from "./ticketStore.js";

// SEC-018 — VNC one-time connection tickets (replaces JWT-in-URL).

test("a freshly issued ticket consumes exactly once", () => {
  const s = new VncTicketStore();
  const t = s.issue({ userId: "u1", hostId: "h1" });
  assert.deepEqual(s.consume(t), { userId: "u1", hostId: "h1" });
  assert.equal(s.consume(t), null, "single use — second consume fails");
});

test("an unknown ticket is rejected", () => {
  const s = new VncTicketStore();
  assert.equal(s.consume("deadbeef"), null);
});

test("an expired ticket is rejected", async () => {
  const s = new VncTicketStore(10); // 10ms TTL
  const t = s.issue({ userId: "u1", hostId: "h1" });
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(s.consume(t), null, "expired ticket denied");
});

test("tickets are unguessably random and distinct", () => {
  const s = new VncTicketStore();
  const a = s.issue({ userId: "u", hostId: "h" });
  const b = s.issue({ userId: "u", hostId: "h" });
  assert.notEqual(a, b);
  assert.match(a, /^[0-9a-f]{64}$/, "256-bit hex");
});
