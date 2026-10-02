/**
 * GO-LIVE logging review — production logger redaction (real pino + Fastify).
 * No password, token, JWT, MFA/step-up/reset token, VNC ticket, cookie,
 * secret envelope or DB connection string may reach the log output.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import pino from "pino";
import Fastify from "fastify";
import { loggerOptions } from "./index.js";
import type { Config } from "../config/index.js";

const cfg = { isProd: true, env: { LOG_LEVEL: "info", APP_ENV: "production" } } as unknown as Config;
function capture() {
  let out = "";
  const sink = new Writable({ write(c, _e, cb) { out += c.toString(); cb(); } });
  return { log: pino(loggerOptions(cfg), sink), read: () => out };
}
const SECRETS = [
  "JWT-SECRET", "COOKIE-SECRET", "STEPUP-SECRET", "PW-SECRET", "MFA-SECRET", "RT-SECRET", "VNC-TICKET-SECRET",
  "RESET-SECRET", "DBURL-SECRET", "PK-SECRET", "OVPN-SECRET", "CODE-SECRET", "APIKEY-SECRET",
];

test("LOG-REDACT-001: request logs carry method + path only (no query, headers or body)", async () => {
  const { log, read } = capture();
  const app = Fastify({ loggerInstance: log });
  app.post("/vnc", async () => ({ ok: true }));
  await app.ready();
  await app.inject({
    method: "POST", url: "/vnc?ticket=VNC-TICKET-SECRET&reset_token=RESET-SECRET",
    headers: { authorization: "Bearer JWT-SECRET", cookie: "awamer_rt=COOKIE-SECRET", "x-step-up-token": "STEPUP-SECRET" },
    payload: { password: "PW-SECRET" },
  });
  await app.close();
  const out = read();
  assert.match(out, /"url":"\/vnc"/);
  for (const s of SECRETS) assert.ok(!out.includes(s), `${s} leaked: ${out}`);
});

test("LOG-REDACT-002: sensitive fields are censored wherever an object is logged", () => {
  const { log, read } = capture();
  log.info({
    password: "PW-SECRET", mfa_token: "MFA-SECRET", refresh_token: "RT-SECRET", mfa_code: "CODE-SECRET",
    step_up_token: "STEPUP-SECRET", reset_token: "RESET-SECRET", ticket: "VNC-TICKET-SECRET",
    DATABASE_URL: "postgres://u:DBURL-SECRET@h/db",
    headers: { authorization: "Bearer JWT-SECRET", cookie: "COOKIE-SECRET" },
    credential: { private_key: "PK-SECRET" }, profile: { config: "OVPN-SECRET" }, provider: { apiKey: "APIKEY-SECRET" },
  }, "probe");
  const out = read();
  for (const s of SECRETS) assert.ok(!out.includes(s), `${s} leaked: ${out}`);
  assert.match(out, /\[redacted\]/);
});
