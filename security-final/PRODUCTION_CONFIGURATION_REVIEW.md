# Production Configuration Review

Sources reviewed:
- `backend/src/config/index.ts`
- `backend/src/server.ts`
- `backend/src/crypto/secretBox.ts`
- `deploy/docker-compose.production.yml`
- `deploy/.env.production.example`
- `deploy/nginx/netsphere.conf`
- `deploy/scripts/*.sh`
- `backend/Dockerfile*`

Secret values found in the repository are **not** reproduced here.

## 1. Mandatory secrets and fail-safe behaviour

| Item | Behaviour if missing or weak | Evidence | Status |
|---|---|---|---|
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | Startup fails: required, ≥32 chars, must differ; in production any value containing "dev" is rejected. **Verified live**: migrate/startup refused without them | `config/index.ts` (schema + `loadConfig`) | PASS |
| JWT algorithm | pinned HS256 for sign and verify; `iss` checked; typed tokens (`access` / `refresh` / `mfa_pending` / `step_up`) | `jwt/index.ts`, `jwt/algVerify.test.ts` | PASS |
| `CREDENTIAL_ENCRYPTION_KEY` | **Required in production**; must decode to exactly 32 bytes, otherwise startup fails. Dev only: derived via HKDF from the refresh secret | `crypto/secretBox.ts` (`resolveSecretKey`), unit test "throws in production when unset" | PASS |
| Database credentials | compose `${POSTGRES_PASSWORD:?…}`; `DATABASE_URL` required | compose | PASS |
| Bootstrap admin password | production rejects the dev default and weak/placeholder values (≥16 chars, deny-list) | `config/index.ts` `assertProductionBootstrapPassword` | PASS |
| `VPN_HELPER_SECRET` | compose `:?` (required); helper refuses <32 chars | compose, `vpn-helper/main.ts` | PASS |
| `APP_PUBLIC_BASE_URL` | must be https in production; startup fails if email is enabled without it | `config/index.ts`, `server.ts` | PASS |
| `APP_VERSION` | **now required** (`:?`); previously defaulted to stale `1.6.0.1` | compose | FIXED |
| CORS allowed origins | exact-origin list with `credentials: true`; no wildcard. Defaults are localhost/tauri origins; the production template sets the real domain | `server.ts`, compose | PASS (see R-12) |
| `TRUST_PROXY` | `true`/`*` and broad ranges are rejected; default `loopback`; the installer computes the exact Docker gateway `/32` | `config/index.ts`, `deploy/scripts/lib/trustproxy.sh` | PASS |
| Swagger UI | off unless `ENABLE_API_DOCS=true`; not proxied by nginx | `server.ts`, nginx | PASS (keep off: C-5) |

## 2. Production defaults search

- No `admin/admin`.
- No default JWT secret accepted in production.
- No development encryption key accepted in production.
- `.env.example` (dev) contains clearly dev-only values. Production rejects them: the
  short/"dev" JWT secret and the dev bootstrap password are refused.
- `deploy/.env.production.example` contains only `CHANGE_ME_…` placeholders, which fail
  the length and placeholder checks.
- `deploy/scripts/generate-secrets.sh` generates every secret with `openssl rand`.
- Git history contains only those two example env files; no real secret files were ever
  committed.
- Private-key matches are only placeholders, test fixtures and detector regexes (redacted).

## 3. Weaknesses (not blocking; tracked in `REMAINING_RISKS.md`)

| ID | Item | Detail |
|---|---|---|
| R-11 | `APP_ENV` defaults to `development` | All production guards key off `APP_ENV`, not `NODE_ENV`. The shipped compose sets `APP_ENV=production`; a custom `docker run` without it would silently accept dev defaults. Recommendation: treat `NODE_ENV=production` (set in the Dockerfile) as production, or refuse to start when they disagree |
| R-02 | Postgres superuser | Both the backend and the vpn-helper connect as `POSTGRES_USER`, which is a superuser in the official image. Recommendation: a dedicated non-superuser app role that owns the schema, plus a minimal read-only role for the helper's auth-verify |
| R-12 | CORS hygiene | No production validation rejecting `http:`/`null` origins |
| — | Secrets via environment variables | Visible through `docker inspect` to host root; acceptable on a dedicated host; Docker secrets preferred |
| — | `.env.production` / DB backup permissions | created under the default umask, then `chmod 600` (brief window); backups not `umask 077` |

## 4. Container security

| Control | Backend (`auth-service`) | vpn-helper | Evidence |
|---|---|---|---|
| Non-root | ✅ uid 10001 | ❌ root inside container (required for tun/iptables) | Dockerfile, compose, `composeContract.test.ts` (executed: pass) |
| `cap_drop: ALL` | ✅ | ✅ then `cap_add: NET_ADMIN` only | compose + contract test |
| `no-new-privileges` | ✅ | ✅ | compose + contract test |
| NET_ADMIN isolated to the helper | ✅ backend has none, no `/dev/net/tun` | ✅ | contract tests INFRA-VPN-002/003/006/007 |
| Network exposure | `127.0.0.1:8081` only | host networking; no control port; IPC over a `0660` Unix socket with HMAC auth | compose, `vpn/helperProtocol.ts` |
| Postgres exposure | `127.0.0.1:5432` (prod); dev compose binds `0.0.0.0` (dev only) | — | compose files |
| read-only rootfs / tmpfs / resource limits | ❌ not set | ❌ | compose (hardening opportunity) |
| Health checks | ✅ | ✅ | compose / Dockerfile |
| Image pinning | tags (`node:20-alpine`, `postgres`), **no digests** | same | Dockerfiles |
| Reproducible dependency install | **fixed**: `npm ci` from the lockfile (was `npm install`) | **fixed** | Dockerfiles |
| Remote-session destination policy | `REMOTE_SESSION_ALLOW_LOOPBACK=false`, `REMOTE_SESSION_DENY_LOCAL_SUBNETS=true` (new compose defaults) | — | compose |

**The vpn-helper's blast radius is architectural.** It runs as root with NET_ADMIN on the
**host** network namespace and holds full DB credentials. This assessment closed the two
concrete paths into it: VPN-server `cipher` injection and the client `.ovpn` file/control
directives. The design still means any future helper bug is host-impacting (R-03).

## 5. Security headers

| Header | Applied by | Value / note |
|---|---|---|
| Content-Security-Policy (incl. `frame-ancestors 'none'`) | **Proxy** (nginx) | strict: `script-src 'self' 'wasm-unsafe-eval'`, `object-src 'none'`. Helmet CSP is disabled in the app (API only). Tauri has its own CSP in `tauri.conf.json` |
| Strict-Transport-Security | **Both** (nginx 180 d + includeSubDomains; helmet 1 y) | duplicated on `/api` responses; harmless |
| X-Content-Type-Options `nosniff` | Both | — |
| X-Frame-Options | Both (nginx `DENY`, helmet `SAMEORIGIN`) | conflicting duplicate on `/api`; the browser uses the stricter. CSP `frame-ancestors` governs anyway |
| Referrer-Policy `no-referrer` | Both | — |
| Permissions-Policy | **Proxy** | geolocation/microphone/camera disabled |
| TLS | Proxy | TLS 1.2 / 1.3 only |

## 6. Rate limiting

| Endpoint | Limit | Evidence |
|---|---|---|
| Global API | 120 / min / client IP | `server.ts` (`@fastify/rate-limit`, key `req.ip`) |
| `/auth/login`, `/auth/mfa/verify`, `/auth/refresh` | `RATE_LIMIT_LOGIN_PER_MIN` (10) / min / IP | `routes/auth.ts` |
| `/auth/forgot-password`, `/auth/reset-password` | **10 / min / IP (new)** | `routes/passwordReset.ts` |
| `/auth/verify-password`, `/auth/step-up` | **10 / min / IP (new)** | `routes/users.ts` |
| Per-account lockout | 5 failures → 15 min. **MFA failures now count, and the counter is no longer reset between password and MFA** | `usecases/login.ts`, FINAL-MFA-003 |
| Credential / VPN reveal, AI chat | global limit only; reveals are permission-gated and audited | R-13 |
| `X-Forwarded-For` spoofing | only `loopback` + the configured gateway `/32` are trusted; fastify 5.12.5 fixes the hop-count spoofing advisory | `config/index.ts`, dependency update |
| IPv6 | each `/128` is its own bucket (no `/64` grouping) | R-13 |
