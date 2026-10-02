# Production Acceptance

## Decision

# PRODUCTION SECURITY ACCEPTED WITH CONDITIONS

**Applies to:** the remediated code on branch `claude/determined-fermat-zf9h5p` (the commit
that adds this `security-final/` directory, on top of `8a8fb5b`).

**Does NOT apply to the baseline.** Commit `8a8fb5b6949ebcc7143e636f81a1e9c6fe64c233` (the
code before this closure) would be **PRODUCTION SECURITY REJECTED**. It contains:
- a Critical vulnerability: a tenant admin could get root in the host-network vpn-helper;
- an authentication bypass: the MFA challenge token worked as a session;
- cross-tenant account takeover through the instance-wide SMTP settings;
- privilege escalation: a company admin could take over a co-located super_admin;
- unauthorized secret disclosure: `.ovpn` `auth-user-pass /proc/self/environ` in the helper;
- runtime-reachable High dependency advisories, including a fastify authentication-bypass advisory.

Earlier reports in this repository marked builds of that code "APPROVED FOR PRODUCTION".
This assessment does not rely on them.

## Gate check (§35) against the remediated code

| Rejection criterion | Status | Evidence |
|---|---|---|
| Critical vulnerability | **None open.** VPN-server config RCE fixed | VPN-CFG-001/002 (fail on baseline, pass now) |
| High-severity exploitable vulnerability | **None open.** MFA bypass, SMTP takeover, target-ceiling, remote-session SSRF, `.ovpn` root file read all fixed | FINAL-*, REMOTE-DEST-*, OVPN-FILE-* |
| Cross-tenant data access | **None found** | `TENANT_ISOLATION_TESTS.md`; tenant itests 220/220 |
| Privilege escalation | **None open** | `PRIVILEGE_ESCALATION_TESTS.md` |
| Authentication bypass | **None open** | FINAL-MFA-001, AUTHZ-STATE-*, JWT-ALG-* |
| Unauthorized secret disclosure | **None open** | OVPN-FILE-001; reveal endpoints gated and audited; secrets never in responses or logs |
| Known production default credential | **None.** Production rejects the dev bootstrap password and placeholders | CFG-BOOT tests, `PRODUCTION_CONFIGURATION_REVIEW.md` |
| Hard-coded production secret | **None** (repository and history scan; values redacted) | `PRODUCTION_CONFIGURATION_REVIEW.md` §2 |
| Critical runtime-reachable dependency vulnerability | **None.** The only Critical (vitest) is dev tooling | `DEPENDENCY_SECURITY_REPORT.md` |
| Security test failure affecting access control | **None.** 525 passed / 0 failed / 0 skipped | `SECURITY_TEST_RESULTS.md` |
| Unverified encryption key handling | **Verified.** 32-byte key mandatory in production, fail-closed; GCM tags enforced | secretBox tests, BACKUP-KDF/SECRETBOX-TAG tests |

## Why "with conditions" and not "accepted"

Acceptance requires evidence. Three things could not be evidenced here, or are open at
Medium severity:
- the Docker images were not built (environment);
- the release is not single-versioned;
- Medium residual risks remain (desktop `russh` DoS, Postgres superuser, helper host-network
  design).

## Conditions

### Mandatory before go-live

| # | Condition | Owner check |
|---|---|---|
| **C-1** | Deploy **exactly** the remediated commit: backend, vpn-helper **and** frontend, from the same commit. Do not deploy `8a8fb5b` or anything built from it | commit SHA in the release record |
| **C-2** | Produce **one** traceable release version (procedure in `RELEASE_VERSION_MATRIX.md`). Set `APP_VERSION` explicitly; it is now mandatory in compose | versions agree; tag exists |
| **C-3** | Build both images in CI from that commit (`npm ci` path) and run `composeContract.test.ts` plus a smoke test: login, MFA login, SSH session, `/readyz` | CI logs |
| **C-4** | Keep the remote-session policy defaults: `REMOTE_SESSION_ALLOW_LOOPBACK=false`, `REMOTE_SESSION_DENY_LOCAL_SUBNETS=true` (Docker). On a bare-metal install, set `REMOTE_SESSION_DENY_CIDRS` to cover the DB/Redis network | `.env.production` |
| **C-5** | `ENABLE_API_DOCS` unset or false in production (keeps `@fastify/static` unreachable) | `.env.production` |
| **C-6** | Alert on `audit_write_failed` log events and on any increase of `audit_write_failures_total` (`/readyz`) | monitoring rule |
| **C-7** | **Post-upgrade compromise review** (these flaws were present in deployed builds). As super_admin: (a) verify the SMTP host, `app_base_url` and reset template are the intended values; (b) check `vpn_servers.cipher` contains only `AES-256-GCM`/`AES-128-GCM`; (c) check stored VPN client profiles for now-denied directives (`management`, `log`, file-path `auth-user-pass`, …), since these profiles will now refuse to launch; (d) review audit logs for admin password/MFA resets against super_admin accounts; (e) if any doubt, rotate `VPN_HELPER_SECRET` and the Postgres password | review record |

### Scheduled (tracked in `REMAINING_RISKS.md`)

- **Within 30 days:** R-01 (desktop `russh` ≥ 0.60.3), R-02 (non-superuser DB roles).
- **Within 90 days:** R-03 (per-session network namespaces for OpenVPN), and Low items R-06…R-17.

When C-1…C-7 are done and recorded, the remediated release meets the acceptance gate.
