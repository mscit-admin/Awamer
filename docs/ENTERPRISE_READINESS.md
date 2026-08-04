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
| Dependency advisories | 🟡 | `uuid` fixed; remaining need breaking majors — see below. |
| Test coverage | 🟡 | VPN sanitizer covered; broad coverage still thin. |
| Per-permission VPN reveal | ✅ | `vpn:reveal` splits secret reveal from `vpn:manage`. |
| Login rate limit / lockout | ⬜ | Dead login-throttle config; permanent lockout. |
| OpenAPI docs | ⬜ | None; routes already carry zod schemas. |
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

**Remaining — all require a breaking major upgrade + a test cycle, so they are
left for a deliberate migration rather than a blind `--force`:**
- **Backend `fastify` 4 → 5** (3 High: X-Forwarded host/proto spoofing, DoS,
  body-validation bypass; incl. `find-my-way`/`fast-uri`). Requires coordinated
  bumps of every `@fastify/*` plugin (cors, helmet, rate-limit, websocket,
  multipart) and a route/hook audit for Fastify-5 API changes. **Largely
  mitigated in this deployment** — the backend sits behind nginx which sets
  `X-Forwarded-*`, and only speaks HTTP/1.1 (the find-my-way HTTP/2 DDoS isn't
  exposed). Do the migration, then smoke-test server boot + all route groups.
- **Desktop `react-router` 6 → 7** (Moderate): a data-router API migration.
- **Desktop `kdbxweb` / `@xmldom/xmldom`** (High, KeePass import only): kdbxweb
  pins `@xmldom/xmldom ^0.7.4` but every patched version is ≥0.8.13, so it needs
  either an upstream kdbxweb release or an `overrides` pin **validated against a
  real KeePass import** (the API differs across the 0.7→0.8/0.9 lines).

Also add `cargo audit`, enforce lockfiles (`npm ci`), and enable
Dependabot/Renovate so these surface continuously.

### 3. Test coverage (High)
Thin outside the sanitizer just added. Prioritize: `RoleService` (`can()` /
`syncBuiltins()`), `vpnRepo`/`vpnManager`/`routes/vpn`, and the auth use-cases.
Add coverage tooling (`c8` backend, `@vitest/coverage-v8` desktop) with a
starting threshold, ratcheted up.

### 4. RBAC granularity — `vpn:reveal` (Medium) — ✅ DONE
`GET /vpn/profiles/:id/config` (plaintext config + credentials) is now gated by a
separate `vpn:reveal` permission, split from `vpn:manage` and mirrored in both
permission matrices. Granted to super_admin / admin / user by default.

### 5. Auth throttling (Medium)
`RATE_LIMIT_LOGIN_PER_MIN` is defined but unused — register a stricter per-route
limit on login/MFA/refresh. Replace the permanent account lockout with temporary
lockout + backoff to avoid an anonymous user-lockout DoS.

### 6. Duplication refactors (Medium)
- Extract the `__nochange__`/`__null__` SQL patch pattern (repeated ~21× across
  repos) into a `patchArg()` + column-builder helper; standardize on the `CASE`
  form (drop the `NULLIF` variants).
- Promote `routes/vpn.ts`'s `domainStatus`/`fail` into a shared route-error module
  (or rely on the new global `setErrorHandler`) — inline `404`-only handlers
  elsewhere return wrong status codes for `*_taken` conflicts.
- `desktop/src/shared/lib/api.ts`: unify the two error parsers and the three
  401-refresh-retry copies behind one `withRefresh()` wrapper.

### 7. Docs & consistency (Medium/Low)
Add `@fastify/swagger` + Swagger UI (routes already carry zod schemas), a short
architecture doc + ADR log, and reconcile the 1.7.0/1.8.0 version drift.
