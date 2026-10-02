# Security Regression Results

The previously fixed major vulnerabilities were retested in three layers:
- **(T)** automated tests in the full suite;
- **(S1)** the smoke test against the production-mode native build;
- **(S2)** the smoke test against the commit-`4e5d4bd` build running under the compose container restrictions (`evidence/smoke-commitA-container.txt`).

## Regression gate (§18)

| Vulnerability | Attempt | Expected | Result | Evidence |
|---|---|---|---|---|
| **VPN injection** | VPN-server `cipher` = `AES-256-GCM\nup "/bin/sh -c id"`; client `.ovpn` with `up /bin/sh` | DENIED | **DENIED** (400) | T: VPN-CFG-001/002, helperCore INFRA-VPN-011…020 · S1/S2: "REGRESSION vpn-injection" ×2 |
| **MFA token confusion** | Use the MFA challenge token on `/users/me` | DENIED | **DENIED** (401) | T: FINAL-MFA-001, MFA-TYP-001…004 · S1/S2 |
| **SMTP authorization** | Company admin `PUT /admin/smtp` | DENIED | **DENIED** (403) | T: FINAL-INST-001 · S1/S2 |
| **Super-admin protection** | Company admin resets the super_admin's password; grants super_admin; mints a `settings:manage` role | DENIED | **DENIED** (403/404) | T: FINAL-CEIL-001/003, FINAL-INST-003, TEST-RBAC-005/006 · S1/S2 |
| **Remote-session SSRF** | SSH to `127.0.0.1` and `169.254.169.254` with production policy | DENIED | **DENIED** (`destination_denied`) | T: REMOTE-DEST-001…006 · S1/S2 |
| **VPN file access** | `.ovpn` with `auth-user-pass /proc/self/environ` | DENIED | **DENIED** (400) | T: OVPN-FILE-001 · S1/S2 |

**No regression.** Every gate item is DENIED in all three layers.

## Additional regressions retested

| Control | Result | Evidence |
|---|---|---|
| TOTP code replay | DENIED | T: TOTP-REPLAY-001 · S1/S2 "mfa: same TOTP code cannot be replayed" |
| MFA brute force across re-logins | Account locks | T: FINAL-MFA-003 |
| MFA enrolment without step-up | DENIED | T: MFA-STEPUP-001 · S1/S2 |
| Refresh token reuse / after logout | DENIED | T: FINAL-REFRESH-001, refresh tests · S1/S2 |
| Logout-all kills access tokens and live sessions | PASS | T: FINAL-LOGOUTALL-001 |
| Access token after a credential change | DENIED | T: authInvalidate(Ws) · S1/S2 "pre-MFA access token invalidated" |
| Live WS sessions revoked on disable/role/company change | PASS | T: sessionRevocation.itest (11) |
| Backup KDF parameter DoS / truncated GCM tags | DENIED | T: BACKUP-KDF-002/003, SECRETBOX-TAG-001 |
| API docs in production | Refused at startup; `/docs` 404 | T: PROD-CFG-002 · startup NEG-3 · S1/S2 |
| Over-privileged DB role in production | Refused at startup | T: DBLP-005 · startup NEG-1/NEG-2 |
| Secrets in logs | 0 occurrences | T: LOG-REDACT-001/002 · live log scans (S1, S2) |
| Desktop SSH: changed host key | REFUSED (SSH and SFTP) | Rust live test SSH-LIVE-006 |

## RBAC regression (§19)

| Requirement | Result | Evidence |
|---|---|---|
| Super Admin retains global authority | PASS: holds `settings:manage` + `companies:manage`; creates companies; manages users in any company | S1/S2; FINAL-CEIL-002 |
| Admin remains company-scoped | PASS: Admin-A → User-B 404 | S1/S2; rbacRoles, moveRbac |
| Admin cannot grant permissions it lacks | PASS | TEST-RBAC-001…003, FINAL-INST-003 · S1/S2 |
| Admin cannot modify Super Admin | PASS | FINAL-CEIL-001 · S1/S2 |
| User cannot escalate | PASS: user → `/admin/users` 403 | S1/S2; rbacRoles |
| Readonly cannot mutate | PASS: `POST /hosts` 403 | S1/S2; authState |
| Auditor cannot mutate; reads its company's audit only | PASS | S1/S2; tenantNullScope |
| Custom roles cannot cross tenants | PASS | TEST-RBAC-004; moveRbac |
| `settings:manage` restricted to super_admin | PASS | FINAL-INST-001…003 · S1/S2 |

## Tenant isolation regression (§20)

| Attempt | Result | Evidence |
|---|---|---|
| Company A → Company B user | DENIED (404) | S1/S2; rbacRoles/moveRbac |
| Company A → Company B resource (SSH host) | DENIED (cannot open the session) | S1/S2; tenantShares |
| Company A → Company B credential | DENIED (404) | S1/S2; tenantShares |
| Company A → Company B VPN profile/config | DENIED (404) | S1/S2; vpnRepo |
| Company A → Company B session | DENIED (no listing surface; revocation is per user) | sessionRevocation |
| Company A → Company B role | DENIED (404) | TEST-RBAC-004 |
| Company A → Company B audit | DENIED (company-scoped) | tenantNullScope; S1/S2 auditor checks |
