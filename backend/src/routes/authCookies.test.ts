import { test } from "node:test";
import assert from "node:assert/strict";
import { isWebClient, setRefreshCookie, clearRefreshCookie, readRefreshCookie, REFRESH_COOKIE } from "./authCookies.js";

// SEC-019 — browser refresh-token cookie attributes + parsing.

function fakeReply() {
  const headers: Record<string, string> = {};
  return { headers, header(k: string, v: string) { headers[k.toLowerCase()] = v; return this; } } as any;
}

test("isWebClient detects the X-Awamer-Client: web header", () => {
  assert.equal(isWebClient({ headers: { "x-awamer-client": "web" } } as any), true);
  assert.equal(isWebClient({ headers: {} } as any), false);
  assert.equal(isWebClient({ headers: { "x-awamer-client": "tauri" } } as any), false);
});

test("setRefreshCookie is HttpOnly + Secure + SameSite=Strict + path-scoped (TEST-BROWSER-AUTH-001/005)", () => {
  const reply = fakeReply();
  setRefreshCookie(reply, "the-refresh-token", 3600);
  const sc: string = reply.headers["set-cookie"];
  assert.match(sc, new RegExp(`^${REFRESH_COOKIE}=the-refresh-token`));
  assert.match(sc, /HttpOnly/, "not readable by JS");
  assert.match(sc, /Secure/);
  assert.match(sc, /SameSite=Strict/, "not sent cross-site — CSRF control");
  assert.match(sc, /Path=\/api\/v1\/auth/);
  assert.match(sc, /Max-Age=3600/);
});

test("clearRefreshCookie expires the cookie", () => {
  const reply = fakeReply();
  clearRefreshCookie(reply);
  assert.match(reply.headers["set-cookie"], /Max-Age=0/);
});

test("readRefreshCookie extracts the value from a Cookie header", () => {
  assert.equal(readRefreshCookie({ headers: { cookie: `x=1; ${REFRESH_COOKIE}=abc.def; y=2` } } as any), "abc.def");
  assert.equal(readRefreshCookie({ headers: {} } as any), null);
});
