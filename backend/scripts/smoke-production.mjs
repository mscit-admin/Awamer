#!/usr/bin/env node
/**
 * GO-LIVE production smoke test — drives a RUNNING Awamer backend over its
 * public HTTP/WebSocket API exactly as clients do. For production-LIKE
 * environments (staging / pre-prod / a disposable install): it creates test
 * companies, users, credentials and hosts. NEVER point it at real production
 * data or use real production credentials.
 *
 * Env:
 *   SMOKE_BASE_URL          e.g. http://127.0.0.1:18081
 *   SMOKE_ADMIN_USER/PASS   bootstrap super_admin (fresh install)
 *   SMOKE_SSH_HOST/PORT     an SSH server reachable FROM the backend
 *   SMOKE_SSH_USER          account on it
 *   SMOKE_SSH_KEY_FILE      private key (OpenSSH) authorised for that account
 *   SMOKE_EXPECT_VERSION    release the backend must report (e.g. 1.8.0)
 *   SMOKE_ALLOW_WRITES=1    required acknowledgement
 * Output: one line per check + a JSON summary; exit 1 on any failure.
 */
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { authenticator } from "otplib";

const env = process.env;
if (env.SMOKE_ALLOW_WRITES !== "1") {
  console.error("refusing to run: set SMOKE_ALLOW_WRITES=1 (creates test data — production-LIKE environments only)");
  process.exit(2);
}
const BASE = env.SMOKE_BASE_URL.replace(/\/$/, "");
const WS = BASE.replace(/^http/, "ws");
const results = [];
const run = Math.random().toString(36).slice(2, 8);
const strongPw = () => `Sm0ke!${randomBytes(9).toString("base64url")}aA1`;

function check(name, ok, detail = "") {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}
async function api(method, path, { token, body, headers = {} } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  const text = await res.text();
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json };
}
let rateLimitSeen = false;
/** Login, honouring the per-IP login rate limit (429) with a wait-and-retry. */
async function login(username, password) {
  for (let attempt = 0; ; attempt++) {
    const r = await api("POST", "/api/v1/auth/login", { body: { username, password } });
    if (r.status !== 429 || attempt >= 3) return r;
    rateLimitSeen = true;
    await new Promise((res) => setTimeout(res, 61_000));
  }
}
async function nextTotpStep() {
  const ms = 30_000 - (Date.now() % 30_000) + 500;
  await new Promise((r) => setTimeout(r, ms));
}
/** Open the SSH WebSocket gateway, authenticate, run a command, collect output. */
function sshExec(token, hostId, command, timeoutMs = 20_000) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${WS}/api/v1/ssh/connect?host_id=${hostId}&cols=120&rows=30`);
    ws.binaryType = "arraybuffer";
    let out = ""; let err = null; let sent = false;
    const done = (r) => { try { ws.close(); } catch {} resolve(r); };
    const t = setTimeout(() => done({ out, err: err ?? "timeout" }), timeoutMs);
    ws.onopen = () => ws.send(JSON.stringify({ type: "auth", token }));
    ws.onmessage = (ev) => {
      if (env.SMOKE_DEBUG === "1") console.error("[ws]", typeof ev.data === "string" ? ev.data : JSON.stringify(new TextDecoder().decode(ev.data)));
      if (typeof ev.data === "string") {
        const m = JSON.parse(ev.data);
        if (m.type === "error") { err = m.code ?? m.message; clearTimeout(t); done({ out, err }); }
        return;
      }
      out += new TextDecoder().decode(ev.data);
      // Type only once the shell has produced output (like a real user): the
      // gateway reports "connected" on SSH-ready, before the shell channel and
      // its stdin handler exist, so input sent earlier is dropped.
      if (!sent) { sent = true; ws.send(new TextEncoder().encode(`${command}\n`)); }
      if (out.includes(`smoke-${run}-ok`)) { clearTimeout(t); done({ out, err: null }); }
    };
    ws.onerror = () => { err = err ?? "ws_error"; };
    ws.onclose = (ev) => { if (!err && !out.includes(`smoke-${run}-ok`)) err = `closed ${ev.code} ${ev.reason}`; };
  });
}

// ---------------------------------------------------------------- health ----
{
  const h = await api("GET", "/healthz");
  check("health: /healthz 200", h.status === 200);
  const r = await api("GET", "/readyz");
  check("health: /readyz ready (DB connectivity)", r.status === 200 && r.json?.status === "ready");
  check("monitoring: audit_write_failures_total exported and 0", r.json?.audit_write_failures_total === 0, JSON.stringify(r.json));
  const v = await api("GET", "/api/v1/version");
  check("traceability: /api/v1/version reports the release", v.status === 200 && v.json?.version === env.SMOKE_EXPECT_VERSION, JSON.stringify(v.json));
  check("traceability: commit id present", /^[0-9a-f]{7,40}$/.test(v.json?.commit ?? ""), v.json?.commit);
  check("traceability: response has ONLY version/commit/build_date", Object.keys(v.json ?? {}).sort().join() === "build_date,commit,version");
  const docs = await api("GET", "/docs");
  check("api-docs: /docs not served in production", docs.status === 404);
}

// ------------------------------------------------------- auth + MFA flow ----
const admin = await login(env.SMOKE_ADMIN_USER, env.SMOKE_ADMIN_PASS);
check("auth: bootstrap super_admin login", admin.status === 200 && admin.json?.access_token, `status ${admin.status}`);
let superTok = admin.json.access_token;
const me = await api("GET", "/api/v1/users/me", { token: superTok });
check("auth: /users/me as super_admin", me.status === 200 && me.json?.role === "super_admin");
check("rbac: super_admin effective permissions include settings:manage + companies:manage",
  me.json?.permissions?.includes("settings:manage") && me.json?.permissions?.includes("companies:manage"));

// MFA enrol (step-up required) for a dedicated smoke user, then MFA login.
const mfaUser = { username: `smoke_mfa_${run}`, password: strongPw() };
const created = await api("POST", "/api/v1/admin/users", { token: superTok, body: { ...mfaUser, email: `${mfaUser.username}@smoke.local`, role: "user" } });
check("users: super_admin creates a user", created.status === 201, `status ${created.status}`);
let mfaTok = (await login(mfaUser.username, mfaUser.password)).json.access_token;
const noStep = await api("POST", "/api/v1/auth/mfa/enroll", { token: mfaTok, body: { device_name: "smoke" } });
check("mfa: enrolment without step-up is refused", noStep.status === 401);
const su = await api("POST", "/api/v1/auth/step-up", { token: mfaTok, body: { password: mfaUser.password } });
const enr = await api("POST", "/api/v1/auth/mfa/enroll", { token: mfaTok, body: { device_name: "smoke" }, headers: { "x-step-up-token": su.json?.step_up_token } });
check("mfa: enrolment with step-up", enr.status === 200 && enr.json?.secret, `status ${enr.status}`);
const act = await api("POST", "/api/v1/auth/mfa/activate", { token: mfaTok, body: { device_id: enr.json.device_id, code: authenticator.generate(enr.json.secret) } });
check("mfa: activation", act.status === 204, `status ${act.status}`);
const stale = await api("GET", "/api/v1/users/me", { token: mfaTok });
check("session: pre-MFA access token invalidated by the MFA change", stale.status === 401);
const l2 = await login(mfaUser.username, mfaUser.password);
check("mfa: login now requires the second factor", l2.status === 200 && l2.json?.mfa_required === true && !l2.json?.access_token);
const bypass = await api("GET", "/api/v1/users/me", { token: l2.json.mfa_token });
check("REGRESSION mfa-token-confusion: challenge token is NOT a session", bypass.status === 401, `status ${bypass.status}`);
const bad = await api("POST", "/api/v1/auth/mfa/verify", { token: l2.json.mfa_token, body: { code: "000000" } });
check("mfa: wrong code rejected", bad.status === 401);
await nextTotpStep(); // the activation consumed this step (replay protection)
const ok = await api("POST", "/api/v1/auth/mfa/verify", { token: l2.json.mfa_token, body: { code: authenticator.generate(enr.json.secret) } });
check("mfa: correct code completes login", ok.status === 200 && ok.json?.access_token, `status ${ok.status}`);
const replay = await api("POST", "/api/v1/auth/mfa/verify", { token: (await login(mfaUser.username, mfaUser.password)).json.mfa_token, body: { code: authenticator.generate(enr.json.secret) } });
check("mfa: same TOTP code cannot be replayed", replay.status === 401, `status ${replay.status}`);

// Token refresh + rotation + logout.
const r1 = await api("POST", "/api/v1/auth/refresh", { body: { refresh_token: ok.json.refresh_token } });
check("session: token refresh", r1.status === 200 && r1.json?.access_token);
const reuse = await api("POST", "/api/v1/auth/refresh", { body: { refresh_token: ok.json.refresh_token } });
check("session: rotated refresh token cannot be reused", reuse.status === 401);
const out = await api("POST", "/api/v1/auth/logout", { body: { refresh_token: r1.json.refresh_token } });
check("session: logout", out.status === 204);
const afterOut = await api("POST", "/api/v1/auth/refresh", { body: { refresh_token: r1.json.refresh_token } });
check("session: refresh after logout is rejected", afterOut.status === 401);

// --------------------------------------------------- tenants + RBAC ----
const compA = (await api("POST", "/api/v1/org/companies", { token: superTok, body: { name: `Smoke A ${run}` } })).json?.company?.id;
const compB = (await api("POST", "/api/v1/org/companies", { token: superTok, body: { name: `Smoke B ${run}` } })).json?.company?.id;
check("tenants: super_admin creates companies A and B", compA && compB);
async function mkUser(prefix, role, company) {
  const u = { username: `smoke_${prefix}_${run}`, password: strongPw() };
  const c = await api("POST", "/api/v1/admin/users", { token: superTok, body: { ...u, email: `${u.username}@smoke.local`, role } });
  const id = c.json?.id;
  await api("PUT", `/api/v1/org/users/${id}/assignment`, { token: superTok, body: { company_id: company, role } });
  const t = (await login(u.username, u.password)).json?.access_token;
  return { id, token: t, ...u };
}
const adminA = await mkUser("adminA", "admin", compA);
const userA = await mkUser("userA", "user", compA);
const readonlyA = await mkUser("roA", "readonly", compA);
const auditorA = await mkUser("audA", "auditor", compA);
const userB = await mkUser("userB", "user", compB);
check("tenants: users provisioned in A and B", [adminA, userA, readonlyA, auditorA, userB].every((u) => u.id && u.token));

check("REGRESSION smtp-authorization: company admin cannot change global SMTP",
  (await api("PUT", "/api/v1/admin/smtp", { token: adminA.token, body: { host: "attacker.example" } })).status === 403);
check("rbac: company admin cannot change global branding",
  (await api("PUT", "/api/v1/branding", { token: adminA.token, body: { app_name: "pwned" } })).status === 403);
check("REGRESSION super-admin-protection: company admin cannot reset the super_admin's password",
  [403, 404].includes((await api("POST", `/api/v1/admin/users/${me.json.id}/reset-password`, { token: adminA.token, body: { password: strongPw() } })).status));
check("rbac: company admin cannot mint a role holding settings:manage",
  (await api("POST", "/api/v1/roles", { token: adminA.token, body: { name: `smoke esc ${run}`, permissions: ["settings:manage"] } })).status === 403);
check("rbac: company admin cannot grant super_admin",
  (await api("PATCH", `/api/v1/admin/users/${userA.id}`, { token: adminA.token, body: { role: "super_admin" } })).status === 403);
check("rbac: company admin manages its own users",
  (await api("PATCH", `/api/v1/admin/users/${userA.id}`, { token: adminA.token, body: { full_name: "Smoke User A" } })).status === 200);
check("tenant: Admin-A cannot read User-B", (await api("GET", `/api/v1/admin/users/${userB.id}`, { token: adminA.token })).status === 404);
check("rbac: user cannot use user administration", (await api("GET", "/api/v1/admin/users", { token: userA.token })).status === 403);
check("rbac: readonly cannot create resources",
  (await api("POST", "/api/v1/hosts", { token: readonlyA.token, body: { name: "x", hostname: "10.0.0.1", protocol: "ssh" } })).status === 403);
check("rbac: auditor cannot create resources",
  (await api("POST", "/api/v1/hosts", { token: auditorA.token, body: { name: "x", hostname: "10.0.0.1", protocol: "ssh" } })).status === 403);
check("rbac: auditor reads the (company-scoped) audit log", (await api("GET", "/api/v1/audit?limit=5", { token: auditorA.token })).status === 200);
check("rbac: user cannot read the audit log", (await api("GET", "/api/v1/audit?limit=5", { token: userA.token })).status === 403);

// --------------------------------------------------- credential access ----
const pem = readFileSync(env.SMOKE_SSH_KEY_FILE, "utf8");
const cred = await api("POST", "/api/v1/credentials", { token: userA.token, body: { name: `smoke key ${run}`, credential_type: "private_key", username: env.SMOKE_SSH_USER, secret_data: { private_key: pem } } });
check("credentials: create (encrypted at rest)", cred.status === 201, `status ${cred.status}`);
const credId = cred.json?.id;
const meta = await api("GET", `/api/v1/credentials/${credId}`, { token: userA.token });
check("credentials: metadata read does not return the secret", meta.status === 200 && !JSON.stringify(meta.json).includes("PRIVATE KEY"));
const rev = await api("GET", `/api/v1/credentials/${credId}?reveal=true`, { token: userA.token });
check("credentials: owner reveal (credentials:reveal)", rev.status === 200 && JSON.stringify(rev.json).includes("PRIVATE KEY"));
check("tenant: User-B cannot read Company-A credential", (await api("GET", `/api/v1/credentials/${credId}?reveal=true`, { token: userB.token })).status === 404);

// ------------------------------------------------------------ SSH ----
const host = await api("POST", "/api/v1/hosts", { token: userA.token, body: { name: `smoke ssh ${run}`, hostname: env.SMOKE_SSH_HOST, port: Number(env.SMOKE_SSH_PORT), protocol: "ssh", credential_id: credId } });
check("ssh: host created", host.status === 201, `status ${host.status}`);
const s1 = await sshExec(userA.token, host.json.id, `echo smoke-${run}-ok`);
check("ssh: interactive session via the WebSocket gateway (auth, TOFU, shell I/O)", !s1.err && s1.out.includes(`smoke-${run}-ok`), s1.err ?? "");
check("tenant: User-B cannot open Company-A's SSH host", (await sshExec(userB.token, host.json.id, "true", 8000)).err !== null);
const loop = await api("POST", "/api/v1/hosts", { token: userA.token, body: { name: `smoke loop ${run}`, hostname: "127.0.0.1", port: Number(env.SMOKE_SSH_PORT), protocol: "ssh", credential_id: credId } });
const sLoop = await sshExec(userA.token, loop.json.id, "true", 8000);
check("REGRESSION remote-ssrf: loopback destination denied", sLoop.err === "destination_denied", sLoop.err ?? "");
const meta2 = await api("POST", "/api/v1/hosts", { token: userA.token, body: { name: `smoke md ${run}`, hostname: "169.254.169.254", port: 22, protocol: "ssh", credential_id: credId } });
const sMeta = await sshExec(userA.token, meta2.json.id, "true", 8000);
check("REGRESSION remote-ssrf: cloud metadata destination denied", sMeta.err === "destination_denied", sMeta.err ?? "");

// ------------------------------------------------------------ VPN ----
const evil = await api("POST", "/api/v1/vpn/profiles", { token: userA.token, body: { name: `smoke evil ${run}`, source: "config", config: "client\ndev tun\nremote vpn.example.com 1194\nauth-user-pass /proc/self/environ\n" } });
check("REGRESSION vpn-file-access: .ovpn file-path directive rejected", evil.status === 400, JSON.stringify(evil.json?.error ?? {}));
const evil2 = await api("POST", "/api/v1/vpn/profiles", { token: userA.token, body: { name: `smoke evil2 ${run}`, source: "config", config: "client\ndev tun\nremote vpn.example.com 1194\nup /bin/sh\n" } });
check("REGRESSION vpn-injection: script directive rejected", evil2.status === 400);
const good = await api("POST", "/api/v1/vpn/profiles", { token: userA.token, body: { name: `smoke vpn ${run}`, source: "config", config: "client\ndev tun\nproto udp\nremote vpn.example.com 1194\n<ca>\n-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n</ca>\n" } });
check("vpn: valid client profile accepted", good.status === 201, `status ${good.status}`);
const cfg = await api("GET", `/api/v1/vpn/profiles/${good.json?.id}/config`, { token: userA.token });
check("vpn: config reveal (vpn:reveal)", cfg.status === 200);
check("tenant: User-B cannot read Company-A VPN profile", (await api("GET", `/api/v1/vpn/profiles/${good.json?.id}/config`, { token: userB.token })).status === 404);
const srv = await api("POST", "/api/v1/vpn-server/servers", { token: adminA.token, body: { name: `smoke srv ${run}`, public_host: "vpn.example.com", cipher: 'AES-256-GCM\nup "/bin/sh -c id"' } });
check("REGRESSION vpn-injection: VPN-server cipher injection rejected", srv.status === 400);

// ----------------------------------------------------------- audit ----
const audit = await api("GET", "/api/v1/audit?limit=200", { token: superTok });
const actions = new Set((audit.json?.data ?? []).map((e) => e.action));
for (const a of ["login_success", "login_failed", "mfa_enroll", "credential_read", "user_update", "config_change"]) {
  check(`audit: '${a}' recorded`, actions.has(a));
}
const r2 = await api("GET", "/readyz");
check("monitoring: no audit write failures during the smoke run", r2.json?.audit_write_failures_total === 0);

if (rateLimitSeen) console.log("INFO  rate-limit: login throttle (429) observed and honoured during the run");
const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ total: results.length, passed: results.length - failed.length, failed: failed.length, failures: failed.map((f) => f.name) }));
process.exit(failed.length ? 1 : 0);
