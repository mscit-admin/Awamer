# Remaining Risks

Confirmed issues that were **not** fixed in this closure. Each one was left open because:
- the fix needs an architectural or major-version change;
- it needs a product decision; or
- the risk is low enough to schedule.

Severities are not inflated. None of these is Critical, and none is an exploitable High under
the shipped configuration.

| ID | Severity | Risk | Why not fixed now | Recommended action |
|---|---|---|---|---|
| R-01 | **Medium** | Desktop native SSH client `russh 0.45` (RUSTSEC-2026-0154/0153): a malicious or compromised SSH **server** can crash or exhaust the user's desktop client | Fix requires `russh ≥ 0.60.3` (major API migration of the Rust SSH layer) | Upgrade russh/russh-keys in a dedicated change with desktop SSH regression testing |
| R-02 | **Medium** | Backend and vpn-helper connect to PostgreSQL as the **superuser**. Any future SQLi or helper compromise means full cluster control (`COPY … PROGRAM`) | Requires a migration-owner/app-role split and a deployment change | Create a non-superuser app role owning the schema, plus a read-only role for helper auth-verify |
| R-03 | **Medium** | vpn-helper architecture: root, NET_ADMIN, **host** network namespace, holds DB credentials. Client VPN profiles (admin-only) can still add `route` entries and set tun addresses on the host namespace, so a tenant admin can influence host routing for non-default prefixes | Inherent to the host-network design. The concrete code-execution / file / control / default-route vectors **were closed** (SEC-VPN-CFG-001, SEC-OVPN-FILE-001) | Run each client/server OpenVPN in its own network namespace; restrict `route` to admin-approved prefixes; give the helper its own DB role |
| R-04 | **Medium** | The release is not single-versioned (backend 1.8.0, desktop/Tauri 1.7.0, UI shows 1.0.0) | Release intent is not determinable from the repository (assessment rule) | Follow the procedure in `RELEASE_VERSION_MATRIX.md` before tagging |
| R-05 | **Medium** | Docker images were **not built** in this assessment (sandbox proxy 403 / Docker Hub 429) | Environment | Build both images in CI from the tagged commit (`npm ci` path) and run the compose contract and smoke tests |
| R-06 | Low | `@fastify/static` (High advisory) is reachable only if `ENABLE_API_DOCS=true`; `node-forge` advisory affects `verify`, which is not used | Major upgrade (swagger-ui 6) / no upstream fix | Keep API docs disabled in production; upgrade swagger-ui; consider replacing node-forge |
| R-07 | Low | Host/folder/credential create/update accepts foreign `credential_id`/`folder_id`/`vpn_profile_id`/`parent_id` without an ownership check. No secret disclosure (resolvers re-scope by owner); FK-error existence oracle; a cross-owner folder cascade is possible | Many call sites; low impact | Add `AND user_id = $owner` existence checks; map PG 23503 to 404 |
| R-08 | Low | Audit tenant scoping joins on the actor's *current* company; rows have no `company_id`; most non-auth rows lack the source IP | Schema change | Add `company_id` (stamped at write) and IP to `audit_logs`; backfill |
| R-09 | Low | `readonly`/`auditor` can create, share and delete their own notes and session-history rows | Product decision (personal artefacts vs inventory) | Add `requireWrite()` to notes/history if readonly must be strictly read-only |
| R-10 | Low | Global namespaces: role keys (409 reveals another tenant's role name) and SSH host-key pins (`hostname:port`), which allows cross-tenant DoS with overlapping private IPs | Schema change | Unique `(company_id, key)`; key pins by `(company_id, host, port)`; add an admin re-pin endpoint |
| R-11 | Low | Production guards key off `APP_ENV` (default `development`), not `NODE_ENV` | Behaviour change for existing installs | Treat `NODE_ENV=production` as production or refuse a mismatch |
| R-12 | Low | No production validation that CORS origins are `https:` (no `null`/`http:`) | — | Add validation in `loadConfig` |
| R-13 | Low | Rate limiting: no IPv6 `/64` grouping; credential/VPN reveal and AI chat only under the global 120/min | — | `/64` key normalisation; per-user limits on reveal/AI |
| R-14 | Low | Audit writes are **fail-open** for every operation. On failure: counter + `audit_write_failed` error log; the counter is **now exported** as `audit_write_failures_total` on `/readyz` (it does not affect readiness) | See the policy analysis in `FINAL_SECURITY_ASSESSMENT.md` §9 | Alert when `audit_write_failures_total` increases or on `audit_write_failed` logs (C-6); consider fail-closed for reveal/admin user changes |
| R-15 | Low | No WebSocket back-pressure on relays; no per-user concurrent-session cap (frame size is now capped at 2 MiB) | Refactor of 4 relays | Pause/resume on `bufferedAmount` high-water marks; cap sessions per user |
| R-16 | Low | Login reveals account state: inactive or locked accounts get a distinct 403 without password verification; forgot-password response timing differs for known emails | UX trade-off | Generic 401 until the password verifies; send reset mail asynchronously |
| R-17 | Low | `vpn-helper` 5xx/502 and SMTP-test errors return the upstream error text to the (super-)admin caller | Admin-only diagnostics | Map to generic messages; log details |
| R-18 | Info | AI `safeFetch` re-sends auth headers on cross-origin redirects; NAT64/6to4 ranges not denied | Low exposure (https only, revalidated hops) | Strip auth headers on origin change |
| R-19 | Info | Desktop/npm dev-tool advisories (vitest critical, vite high) and react-router v6 moderate | Dev-only / not reachable / major upgrades | Upgrade the toolchain (vite 8, vitest 5, react-router 7) |
| R-20 | Info | Refresh "slides" with no absolute session cap (168 h per rotation); step-up single-use store is per-process memory | Design | Add an absolute session lifetime; move the step-up store to Redis if scaling out |
