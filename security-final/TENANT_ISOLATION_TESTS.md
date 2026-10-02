# Multi-Tenant Isolation and IDOR/BOLA Tests

**Scope.** Every REST and WebSocket entry point that takes an object identifier was
reviewed against the current code. Cross-tenant cases were exercised with the existing and
new integration suites against real PostgreSQL 16.

**Conceptual identities.** Company A has Admin-A, User-A, Readonly-A and Auditor-A. Company B
has the same four roles.

## 1. Isolation model (verified in code)

- **Owned objects.** Hosts, credentials, folders, tags, VPN profiles, VPN servers and
  clients, notes, command history, session history and AI personal providers are owned
  objects. Every query carries `user_id = $owner` (`repos/sessionRepos.ts`, `vaultRepos.ts`,
  `vpnRepo.ts`, `vpnServerRepo.ts`, `notesRepo.ts`, `commandHistoryRepo.ts`).
- **Shared visibility.** Visibility of shared hosts and notes also requires
  `company_id = viewer.company_id`. It fails closed when the company is NULL
  (`tenantNullScope` itests).
- **Credential resolution for connections.** Credentials are always loaded **as the host
  owner** (`ssh/resolveAuth.ts`). Pointing your own host at someone else's credential UUID
  does not work.
- **Company-scoped objects.** Users, org units, custom roles, audit and org AI providers are
  scoped by `sameCompany`, `mayTouch`, `tenantScopeForActor` or
  `sameTenantRole`. Super-admin is intentionally global.
- **The `WHERE id = $1` pattern.** It appears only after an ownership or tenant check by the
  caller (admin/org routes load and check before mutating), or together with
  `AND user_id = $2`. No unscoped `UPDATE/DELETE … WHERE id = $1` reachable with a foreign
  ID was found.

## 2. Cross-tenant test outcomes

| Attempt | Control | Evidence | Result |
|---|---|---|---|
| Admin-A → User-B (read/patch/delete/reset-password/disable-MFA) | `sameCompany` → 404 (`routes/admin.ts`) | CODE + itests (rbacRoles, moveRbac) | **DENIED** |
| Admin-A pulls User-B into A, or moves A-user to B | `mayTouch` on target + destination (`routes/organization.ts`) | AUTOMATED moveRbac.itest | **DENIED** |
| User-A → User-B | no user-admin rights | CODE | **DENIED** |
| User-A → Resource-B (get/connect SSH/SFTP/Telnet/VNC/tunnel) | `hosts.getById` owner/same-company share | AUTOMATED tenantIsolation / tenantShares itests | **DENIED** |
| Admin-A → Resource-B | no admin bypass in host/credential repos | CODE | **DENIED** |
| Auditor-A → Audit-B | `u.company_id = scope` (`repos/otherRepos.ts`) | AUTOMATED tenantNullScope itests | **DENIED** |
| Company A → Company B credentials (read/reveal/TOTP/attachments) | `user_id` in SQL + `assertOwned` | CODE + AUTOMATED tenantShares | **DENIED** |
| Company A → Company B connections / session history | `user_id` scoped; ownership checked before `end` | CODE | **DENIED** |
| Company A → Company B VPN profiles / servers / client secrets | `user_id` / `getServer(user,id)` + `server_id` match | CODE + vpnRepo/vpnServerRepo itests | **DENIED** |
| Company A → Company B custom roles (edit/delete/assign/list) | `sameTenantRole` 404; `mayAssignRoleTenant` | AUTOMATED TEST-RBAC-004 | **DENIED** |
| Company A → Company B org units | `mayTouch(existing.companyId)` | CODE | **DENIED** |
| Company A → Company B active session info | no REST endpoint lists or kills sessions; manager is internal | CODE | **N/A (no surface)** |
| Company A → Company B backups (export B / restore into B) | export `user_id = sub`; import writes only `sub` rows; refs remapped | CODE | **DENIED** |
| Company A → Company B AI providers | `prov.companyId === s.companyId` / `available()` | CODE | **DENIED** |
| **Company A admin → every tenant via instance SMTP / branding / session policy** | **`settings:manage` (new)** | AUTOMATED FINAL-INST-001 (baseline: **ALLOWED**, 200) | **DENIED** |
| **Company A admin → super_admin (global) co-located in A** | **target ceiling (new)** | AUTOMATED FINAL-CEIL-001 (baseline: **ALLOWED**) | **DENIED** |
| **Company A user → platform infrastructure** (PostgreSQL/Redis on the Docker network, cloud metadata) through a Telnet/VNC relay | **destination policy (new)** | AUTOMATED REMOTE-DEST-001..006 | **DENIED** (metadata/loopback always; Docker network with `REMOTE_SESSION_DENY_LOCAL_SUBNETS=true`, the compose default) |
| **Company A admin → host-wide compromise** (VPN `cipher` RCE, `.ovpn` root file read) affecting all tenants | allowlist + denylist (new) | AUTOMATED VPN-CFG-*, OVPN-FILE-* | **DENIED** |
| Super-admin cross-tenant (users, audit, roles, companies) | intentional | CODE | **ALLOWED (by design)** |

## 3. IDOR / BOLA inventory (object-identifier endpoints)

| Endpoint | AuthN | Permission | Tenant check | Ownership | Sensitive filtering |
|---|---|---|---|---|---|
| `GET/PATCH/DELETE /admin/users/:id`, `POST …/reset-password`, `…/disable-mfa` | JWT + live state | admin role | `sameCompany` | **target ceiling (new)** | `userView` (no hash/secret) |
| `PUT /org/users/:id/assignment` | yes | `users:manage` | target + destination company | **target ceiling (new)** + grant ceiling | — |
| `PUT/DELETE /org/companies/:id` | yes | `companies:manage` | global (super) | — | — |
| `GET /org/companies/:cid/units`, `PUT/DELETE /org/units/:id` | yes | auth / `org:manage` | `mayTouch` | — | — |
| `PATCH/DELETE /roles/:id` | yes | `users:manage` | `sameTenantRole` | built-ins locked | — |
| `GET /audit?user_id=` | yes | `audit:read` | company scope | — | IP/UA visible to auditors (intended) |
| `/hosts/:id` (+touch/favorite/shares) | yes | `resources:write` on mutations | shared → same company | `user_id` | owner credential never returned |
| `/credentials/:id` (`?reveal`, totp, attachments) | yes | `credentials:reveal` to reveal | — | `user_id` / `assertOwned` | secret only on reveal, audited |
| `/folders/:id`, `/tags/:id` | yes | `resources:write` | — | `user_id` | — |
| `/history/*`, `/notes/:id` | yes | authenticated | notes shares: company | `user_id` | — |
| `/command-history` | yes | `command_history:read` | — | `user_id` | — |
| `/vpn/profiles/:id` (`/config`, `/resolve`, connections) | yes | `vpn:manage` / `vpn:reveal` | — | `user_id` | config only via reveal, audited |
| `/vpn-server/servers/:id[/clients/:cid…]` | yes | `vpn_server:manage` | — | owner + `server_id` | client secrets only on reveal, audited |
| `/ai/providers/:id`, `POST /ai/chat {provider_id}` | yes | `ai:manage` / `ai:use_personal` / `ai:use` | company | `userId` | API key never returned |
| `/backup/export`, `/backup/import` | yes | `backup:manage` (+`credentials:reveal`) | company from user | `user_id` | passphrase-encrypted |
| `/tunnels` (`host_id`, `DELETE /:id`) | yes | `tunnels:manage` | via host resolver | `t.userId` | — |
| WS `/ssh/connect?host_id`, `/telnet`, `/tunnel` | first-frame JWT + live state | `sessions:connect` / `tunnels:manage` | host resolver | owner/share | — |
| `POST /vnc/ticket` → WS `/vnc/connect?ticket` | JWT, then single-use 30 s ticket bound to user+host | `sessions:connect` | re-checked at redeem | — | — |
| `/sftp/connect` + ops by `session_id` | JWT | `sessions:connect` (**now re-checked per op**) | host resolver | `s.userId === sub` | — |

UUID unpredictability is **not** relied on anywhere above: every lookup is scoped by owner,
company, or an explicit check.

## 4. Residual tenant-related observations (Low)

Tracked in `REMAINING_RISKS.md`.

- **R-07: foreign references.** Host/folder/credential create/update accepts a foreign
  `credential_id`/`folder_id`/`vpn_profile_id`/`parent_id` without an ownership check. Secrets
  are **not** reachable, because resolvers re-scope by owner. The effect is an integrity nit
  plus an FK-error existence oracle for UUIDs the attacker already knows.
- **R-08: audit scoping uses the actor's current company.** After a cross-company move,
  historical rows follow the user. The fix is to stamp `company_id` on the audit row at write time.
- **R-10: global namespaces.** Role keys and SSH host-key pins are global, which allows small
  cross-tenant existence oracles or DoS when tenants have overlapping private IPs.
