# Enterprise Readiness — Audit & Remediation

A security, code-quality, and standards audit was run across the backend
(Fastify/Node/Postgres), the desktop app (Tauri/React/TS), and the Rust core.
This document records the findings, what has been remediated, and the
prioritized backlog for the receiving team.

Legend: ✅ fixed · 🟡 partially addressed · ⬜ backlog

---

## Scorecard

| Dimension | Status | Notes |
|---|---|---|
| SQL injection | ✅ | All queries parameterized (verified). |
| Ownership scoping | ✅ | Every repo query is `user_id`-scoped. |
| Secrets at rest | ✅ | AES-256-GCM; key mandatory in prod. |
| **VPN config RCE** | ✅ | Sanitizer + `--script-security 1` + admin-gate (was Critical). |
| Backend container least-privilege | ⬜ | Runs as root for OpenVPN — see H1/H2 below. |
| Global error handling | ✅ | `setErrorHandler` + not-found handler added. |
| Log secret redaction | ✅ | pino `redact` list added. |
| CI pipeline | ✅ | `.github/workflows/ci.yml` added. |
| ESLint / Prettier | ✅ | Configs added; `npm run lint` clean (0 errors). |
| Rust warnings | ✅ | Crate is warning-clean. |
| Dependency advisories | 🟡 | Backend **0 vulns** (fastify 5 + uuid done, validated live); desktop react-router/kdbxweb majors remain. |
| Test coverage | 🟡 | Unit (sanitizer, RBAC, lockout) + **DB integration tests** (vpnRepo encryption/resolve, RoleService) running in CI against Postgres; still expanding. |
| Per-permission VPN reveal | ✅ | `vpn:reveal` splits secret reveal from `vpn:manage`. |
| Login rate limit / lockout | ✅ | Per-IP auth throttle wired; lockout is now temporary. |
| OpenAPI docs | ✅ | `@fastify/swagger` at `/docs` (81 endpoints), flag-gated (`ENABLE_API_DOCS`). |
| Version consistency | ⬜ | backend 1.8.0 vs desktop/Cargo 1.7.0. |

---

## Fixed in this pass

- **Critical — RCE via OpenVPN config.** A backend-runtime profile stored an
  arbitrary `.ovpn`; OpenVPN directives (`up`, `plugin`, `script-security 2`, …)
  execute programs, and the backend runs openvpn as root, so any `vpn:manage`
  holder could run commands on the server. Fixed by rejecting command-executing
  directives (`assertSafeOvpnConfig`, validated on the fully-assembled config so
  manual-profile inline-cert breakouts are caught), forcing `--script-security 1`
  on both backend and desktop, charset-validating `remote_host`, and requiring an
  admin role to open a backend-runtime tunnel. Unit-tested.
- **Global error handler + not-found handler** so uncaught throws return a
  generic 500 instead of leaking internals.
- **pino log redaction** for authorization headers, passwords, secrets, tokens,
  private keys, passphrases, and VPN config text.
- **Dead code / duplication:** removed the redundant double `set_metadata` in
  `sftp_chmod`, dropped write-only `SshSession` fields (warnings), annotated the
  unused `store` accessor; crate is now warning-clean.
- **Tooling:** ESLint (both packages) + Prettier + `.editorconfig` + `rustfmt.toml`,
  a CI workflow (typecheck · lint · test · build · audit · fmt/clippy), and the
  previously-undefined `make test` / `make lint` targets.

---

## Backlog (prioritized)

### 1. Backend container least-privilege (High) — `H1/H2`
The `auth-service` container runs as **root** (`user: "0:0"`) with
`CAP_NET_ADMIN` + `/dev/net/tun` so backend-runtime OpenVPN can configure `ip`.
The RCE vector is now closed, but root + a host kernel device raises
container-escape impact. Recommended: isolate backend OpenVPN in a dedicated
minimal sidecar running openvpn as an unprivileged user with only
`CAP_NET_ADMIN`; add `cap_drop: [ALL]`, `security_opt: [no-new-privileges:true]`,
resource limits. Best: prefer **desktop-runtime** VPN so the backend never spawns
tunnels. (Requires infra testing — see the earlier deployment notes about the
`ip`/tun interaction.)

### 2. Dependency advisories (High)
**Done:** `uuid` bumped to 11.1.1 (only `v4` was used, which the advisory didn't
even affect — audit is now clean of it).

**Done:**
- ✅ **Backend `fastify` 4 → 5** — cleared all 3 High advisories (backend
  `npm audit` is now clean). Coordinated bumps of every `@fastify/*` plugin
  (cors 11, helmet 13, multipart 9, rate-limit 10, sensible 6, websocket 11) +
  API-change fixes (`loggerInstance`, `@fastify/websocket` v11 passes the socket
  directly, removed the deprecated `disableRequestLogging`). **Validated against
  a real Postgres**: boots clean, and login / VPN CRUD / the config sanitizer /
  `vpn:reveal` gate / 404 / CORS / login rate-limit all verified.

**Remaining — breaking majors left for a deliberate migration + test cycle:**
- **Desktop `react-router` 6 → 7** (Moderate): a data-router API migration.
- **Desktop `kdbxweb` / `@xmldom/xmldom`** (High, KeePass import only): kdbxweb
  pins `@xmldom/xmldom ^0.7.4` but every patched version is ≥0.8.13, so it needs
  either an upstream kdbxweb release or an `overrides` pin **validated against a
  real KeePass import** (the API differs across the 0.7→0.8/0.9 lines).

Also add `cargo audit`, enforce lockfiles (`npm ci`), and enable
Dependabot/Renovate so these surface continuously.

### 3. Test coverage (High) — 🟡 IN PROGRESS
Added **unit** tests: VPN sanitizer/assembly (`domain/vpn.test.ts`), lockout logic
(`domain/account.test.ts`), RBAC resolver via in-memory repo
(`domain/roleService.test.ts`). Added **DB integration** tests (`*.itest.ts`, run
via `npm run test:integration` against a real Postgres, wired into CI with a
`postgres:16` service): `vpnRepo` (secrets encrypted-at-rest round-trip +
`resolveForHost` folder-ancestry inheritance) and `RoleService` (built-in
reconciliation + live permission resolution). Integration tests **skip** when no
`DATABASE_URL` is set, so the unit suite stays DB-free. Still to do: the auth
use-cases, `vpnManager` process spawning, and the connection gateways; add a
coverage tool + threshold (`c8` / `@vitest/coverage-v8`) and ratchet it up.

### 4. RBAC granularity — `vpn:reveal` (Medium) — ✅ DONE
`GET /vpn/profiles/:id/config` (plaintext config + credentials) is now gated by a
separate `vpn:reveal` permission, split from `vpn:manage` and mirrored in both
permission matrices. Granted to super_admin / admin / user by default.

### 5. Auth throttling (Medium) — ✅ DONE
`RATE_LIMIT_LOGIN_PER_MIN` now enforces a stricter per-IP limit on
login/MFA/refresh, and the failed-attempt lockout is temporary (`locked_until`,
migration 018) with a configurable `ACCOUNT_LOCKOUT_MINUTES` — no more
permanent anonymous lockout. Admin/manual `is_locked` is unchanged.

### 6. Duplication refactors (Medium)
- ✅ **Done** — `desktop/src/shared/lib/api.ts`: unified the two error parsers and
  the three 401-refresh-retry copies behind one `withRefresh()` wrapper +
  single `parseError()`.
- ⬜ Extract the `__nochange__`/`__null__` SQL patch pattern (repeated ~21× across
  repos) into a `patchArg()` + column-builder helper; standardize on the `CASE`
  form (drop the `NULLIF` variants). *(DRY only — current code is correct; left
  for a pass with DB integration tests, since it touches critical CRUD SQL.)*
- ⬜ Promote `routes/vpn.ts`'s `domainStatus`/`fail` into a shared route-error
  module — inline `404`-only handlers elsewhere return the wrong status for
  `*_taken` conflicts. (The new global `setErrorHandler` is a safety net but
  doesn't override handlers that catch first.)

### 7. Docs & consistency (Medium/Low)
- ✅ **Done** — `@fastify/swagger` + Swagger UI at `/docs` (opt-in via
  `ENABLE_API_DOCS`; off in prod by default). Lists all 81 endpoints; request/
  response bodies are sparse because routes validate with zod manually rather
  than Fastify JSON schemas — attaching those would enrich the spec later.
- ⬜ A short architecture doc + ADR log; reconcile the 1.7.0/1.8.0 version drift.
