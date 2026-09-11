# Phase 5 Report — Stability

**Branch:** `claude/nifty-johnson-u2dwye`

## Build / test / lint (final state)

| Check | Result |
| --- | --- |
| Backend `tsc --noEmit` | ✅ PASS |
| Backend `npm run lint` | ✅ 0 errors (31 `no-explicit-any` warnings, all in `*.test.ts` fakes — matches the existing test style) |
| Backend `npm test` (unit) | ✅ 73/73 |
| Backend `npm run test:integration` (real PG 16) | ✅ 9/9 |
| Frontend `tsc --noEmit` | ✅ PASS |
| Frontend `npm run build` | ✅ PASS |
| Frontend `npm test` (vitest) | ✅ 13/13 |
| Frontend `npm run lint` | ⚠️ 2 errors + 13 warnings — **pre-existing**, in `VncPage.tsx` / `VpnServerPage.tsx` (unused `eslint-disable` directives), files untouched by this remediation (verified via `git diff --name-only`) |

Per §17, the two frontend lint errors are **pre-existing** and must not be
attributed to remediation. Left as-is to avoid scope creep and because the fix
depends on the CI's `react-hooks` plugin version (removing a directive that CI
still needs would flip the error).

## Resource-leak review (changed code)

- **`awaitAuthFrame` (SSH gateway):** registers exactly one `message` + one
  `close` listener and one timeout, all torn down in a single `cleanup()` on
  resolve / timeout / socket-close. No listener or timer survives the auth
  phase. Verified by unit tests (timeout + close paths).
- **SSH gateway (unchanged cleanup preserved):** idle timer, stats interval, WS
  ping interval and connection-history record are still cleared on every exit
  path (`ws.close`/`error`, `conn.close`/`error`, shell `close`/`error`). My
  edits touched only the auth prologue and the `hostVerifier`; the teardown
  paths are intact.
- **`makeHostVerifier`:** one short-lived Promise per handshake; no retained
  listeners/timers.
- **Migrations 020/021:** idempotent (`IF NOT EXISTS`, `ON CONFLICT`), applied
  cleanly to a real DB; `down` scripts drop cleanly.

## Failure-mode analysis

Full failure-injection (kill PostgreSQL/nginx, restart containers) needs the
complete Docker stack, which is not runnable in this sandbox. Analysis from the
code + verification of what *is* runnable:

- **PostgreSQL outage:** the backend uses a `pg` Pool; a query during an outage
  rejects → the route throws → the global error handler returns a safe 5xx
  (no stack trace to the client). No state corruption (no partial writes; the
  multi-step flows that matter — refresh rotation, note-share replace,
  backup-restore — run in explicit transactions with ROLLBACK on error). The
  pool reconnects when PG returns. Startup runs migrations then serves; a DB
  down at boot fails the migrate step and the container restarts
  (`restart: unless-stopped`).
- **Redis outage:** **not applicable** — the backend has **no** Redis
  dependency (none in `package.json`, no import in `src/`). Rate limiting is
  `@fastify/rate-limit` (in-memory). Redis is provisioned in compose but unused
  by the auth-service at runtime, so its unavailability cannot degrade the API.
  (Noted as a cleanup opportunity, not a fault.)
- **Existing resilience preserved:** WS heartbeat/ping to survive idle proxies,
  non-overlapping server-stats poller (won't exhaust the target's MaxSessions),
  ssh2 stream `error` handlers on every channel (an unhandled one would crash
  the process and drop *every* user's session), SSH keepalive + read timeout.
  All were already present; remediation preserved them.

## To run the full failure/restart matrix at deploy

```
docker compose -f deploy/docker-compose.production.yml --env-file ../.env.production up -d
# then, one at a time, and confirm the API returns controlled 5xx + recovers:
docker compose ... stop postgres   # DB outage
docker compose ... restart auth-service redis nginx
```
