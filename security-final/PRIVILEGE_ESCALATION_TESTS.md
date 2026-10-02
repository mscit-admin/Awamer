# Privilege Escalation Tests

Each case gives:
- the **server-side** control that decides it (file);
- the **evidence**: an automated test executed in this assessment, or code review;
- the result.

UI restrictions are not counted as controls.

Legend:
- **AUTOMATED** = an executed test asserts it. Test IDs refer to `SECURITY_TEST_RESULTS.md`.
- **CODE** = verified by reading the current code; no dedicated test.

| # | Attempt | Server control | Evidence | Result (fixed code) | Result (baseline `8a8fb5b`) |
|---|---|---|---|---|---|
| 1 | admin → super_admin (assign `super_admin` to self/other) | `mayGrantRole` subset ceiling (`routes/admin.ts`) | AUTOMATED TEST-RBAC-005/006 | **DENIED** 403 | DENIED |
| 2 | admin → super_admin by **taking over a co-located super_admin** (reset password, disable MFA, change email, lock, delete, demote) | **target ceiling** `mayActOnTarget` (`routes/admin.ts`), assignment target check (`routes/organization.ts`) | AUTOMATED FINAL-CEIL-001 | **DENIED** 403, audited `permission_denied` | **ALLOWED** — test fails on baseline |
| 3 | admin → super_admin via **instance SMTP**: repoint the relay, then use forgot-password to capture a super_admin's reset link | `requirePermission("settings:manage")` (`routes/smtp.ts`) | AUTOMATED FINAL-INST-001 (baseline PUT returned **200**, isolated run) | **DENIED** 403 | **ALLOWED** |
| 4 | user → admin (self role change through `/users/me`) | `/users/me` schema accepts only `full_name`/`email`; zod strips other keys (`routes/users.ts`) | CODE | **DENIED** | DENIED |
| 5 | user → auditor | user lacks `users:manage`; `/admin/*` requires the admin role | CODE + AUTOMATED (admin routes gate, rbacRoles itest) | **DENIED** | DENIED |
| 6 | readonly → write (hosts/credentials/tunnels/VPN/sessions) | `requireWrite()` → `resources:write`; `can(...,"sessions:connect")` on every WS | CODE + AUTOMATED (authState/sessionRevocation itests) | **DENIED** | DENIED |
| 7 | auditor → modification | holds only `audit:read`; audit reads are company-scoped | CODE + AUTOMATED (tenantNullScope itests) | **DENIED** | DENIED |
| 8 | custom role → unauthorized permission (edit own role upward) | catalog validation + subset ceiling (`routes/roles.ts`) | AUTOMATED TEST-RBAC-001/002/003/007 | **DENIED** | DENIED |
| 9 | admin → `companies:manage` (custom role holding it) | `GLOBAL_ONLY_PERMISSIONS` + ceiling | AUTOMATED TEST-RBAC-001 | **DENIED** | DENIED |
| 10 | admin creates a role **stronger than itself** / with `settings:manage` | ceiling + global-only (now includes `settings:manage`) | AUTOMATED FINAL-INST-003, TEST-RBAC-002 | **DENIED** 403 | n/a (permission did not exist) |
| 11 | admin assigns a permission it does not hold | ceiling on `POST/PATCH /admin/users`, `PUT /org/users/:id/assignment`, `/roles` | AUTOMATED TEST-RBAC-002/006 | **DENIED** | DENIED |
| 12 | admin modifies super_admin | target ceiling | AUTOMATED FINAL-CEIL-001 | **DENIED** | **ALLOWED** |
| 13 | `users:manage` helpdesk role demotes or moves **its own company admin** | target ceiling on assignment | AUTOMATED FINAL-CEIL-003 | **DENIED** 403 | **ALLOWED** — test fails on baseline |
| 14 | user modifies own role | `/users/me` field allow-list; role only via admin/org routes | CODE | **DENIED** | DENIED |
| 15 | user modifies own company | company only via `PUT /org/users/:id/assignment` (`users:manage`) | CODE | **DENIED** | DENIED |
| 16 | user modifies another user's security attributes | only admin routes can (admin role + same company + target ceiling) | CODE + AUTOMATED | **DENIED** | DENIED |
| 17 | edit or delete a locked built-in role | `isBuiltin` → 403 (`routes/roles.ts`) | CODE | **DENIED** | DENIED |
| 18 | custom role key collides with a built-in (`Super-Admin` → `super_admin`) | slug + `isBuiltinRole` → 409 | CODE | **DENIED** | DENIED |
| 19 | stale JWT keeps old privilege after a downgrade | live DB role replaces the token role on every request; `auth_version` check | AUTOMATED AUTHZ-STATE-001..005 | **DENIED** | DENIED |
| 20 | MFA-pending token used as a session (2FA bypass) | `typ:"mfa_pending"` rejected by `verifyAccess` (`jwt/index.ts`) | AUTOMATED FINAL-MFA-001, MFA-TYP-* | **DENIED** 401 | **ALLOWED** for MFA accounts with `auth_version=1` — test fails on baseline |
| 21 | **tenant admin → root on the platform host** via VPN-server `cipher` injection (`script-security 2` in the root, host-network helper) | `z.enum(VPN_SERVER_CIPHERS)` + helper IPC check + assembler validation | AUTOMATED VPN-CFG-001/002 | **DENIED** | **ALLOWED** — test fails on baseline |
| 22 | tenant admin → read helper secrets (`DATABASE_URL`, `VPN_HELPER_SECRET`) via `auth-user-pass /proc/self/environ` in a client `.ovpn` | file-argument denial + extended directive denylist (`domain/vpn.ts`, re-checked in helper) | AUTOMATED OVPN-FILE-001/002 | **DENIED** | **ALLOWED** (assessed by code; not executed against a live OpenVPN) |
| 23 | a demoted, moved or disabled user keeps a live SSH/Telnet/VNC/WS-tunnel session | `ActiveSessionManager.revalidateUser/revokeUser` | AUTOMATED sessionRevocation itests | **DENIED** (closed) | DENIED |
| 24 | same, for **server-managed `ssh -L` tunnels and SFTP** | now registered with `ActiveSessionManager`; SFTP re-checks the live role per operation | CODE | **DENIED** (closed) | **ALLOWED** until idle reaper or manual stop |

## Summary

- Escalation paths open on the baseline and now closed: #2, #3, #12, #13, #20, #21, #22, #24.
- Paths that were already closed and were re-verified: #1, #4–#11, #14–#19, #23.
- No privilege escalation path remains open in the current code, as far as this assessment
  could determine. #22 and #24 are verified by code plus unit tests; they were not exercised
  end-to-end with live OpenVPN or SFTP servers. See `SECURITY_TEST_RESULTS.md`.
