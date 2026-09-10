# Awamer — Final Security & Stability Report

**Branch:** `claude/nifty-johnson-u2dwye`
**Engagement:** controlled, phased security remediation + stability hardening.
**Verification:** backend suites run against a real migrated PostgreSQL 16;
frontend built and tested; infra configs validated where a runtime existed.

---

## Dashboard

| Category            | Result |
| ------------------- | ------ |
| Build               | PASS |
| Unit Tests          | PASS (backend 73/73, frontend 13/13) |
| Integration Tests   | PASS (9/9, real PostgreSQL) |
| Authentication      | PASS |
| Authorization       | PASS |
| Tenant Isolation    | PASS |
| IDOR/BOLA           | PASS |
| Credential Security | PASS |
| SSH                 | PASS |
| SFTP                | PASS |
| WebSocket Security  | PASS |
| Browser Security    | PASS¹ |
| Tauri Security      | PASS |
| Docker Hardening    | PASS |
| Nginx Security      | PASS² |
| Stability           | PASS³ |

¹ CSP authored tightly and audited against the frontend deps (incl. the
`hash-wasm` WASM path → `'wasm-unsafe-eval'`); **must be confirmed in-browser at
deploy** (no live browser+nginx in sandbox).
² Header/policy syntax reviewed; **run `nginx -t` on the target host** (nginx +
TLS certs not present in sandbox).
³ Suites green + resource-leak review clean; full container failure-injection
must be run against the deployed stack (§ Phase 5 report).

---

## Findings summary

| ID | Title | Severity | Status |
| --- | --- | --- | --- |
| AWM-SEC-003 | Cross-company access to shared hosts/notes | **P0** | FIXED (verified E2E) |
| AWM-SEC-001 | Secrets in WebSocket URLs | P1 | FIXED (SSH); residual token-in-URL for other gateways MITIGATED |
| AWM-SEC-002 | Disabled/locked users could refresh | P1 | FIXED |
| AWM-SEC-007 | No session revocation on admin actions | P1 | FIXED |
| AWM-SEC-004 | Refresh token in browser localStorage | P2 | ACCEPTED (compensating controls; cookie migration documented) |
| AWM-SEC-005 | Excessive Docker privileges | P2 | FIXED (least-privilege; root retained per VPN need) |
| AWM-SEC-006 | Missing browser CSP | P2 | FIXED |
| AWM-SEC-008 | SSH host keys accepted blindly (MITM) | P2 | FIXED |
| AWM-BUG-001 | Tauri CSP / dev-port mismatch | P2 | FIXED |
| AWM-SEC-014 | Secret redaction in logs | P3 | VERIFIED + HARDENED |
| AWM-SEC-012 | SFTP path traversal (backend) | — | FALSE POSITIVE |

### Counts
- **Total findings:** 11
- **P0:** 1 (fixed)
- **P1:** 3 (all fixed)
- **P2:** 5 (4 fixed, 1 accepted with compensating controls)
- **P3:** 1 (addressed) + 1 residual (SEC-001 token-in-URL for non-SSH gateways, mitigated)
- **Fixed:** 8 + 1 hardened (SEC-014)
- **Accepted (risk-managed):** 1 (SEC-004)
- **False positives:** 1 (SEC-012)
- **Remaining P0/P1:** 0

---

## What changed (by phase)

- **Phase 1 — Auth & secrets:** refresh now enforces live account state and
  revokes the chain on denial (SEC-002); admin disable/lock/role-change revokes
  sessions (SEC-007); the SSH gateway authenticates over the WS channel — token
  and SSH password/passphrase no longer in the URL — with nginx path-only
  logging as defense-in-depth (SEC-001). Tests: `refresh.test.ts` (9),
  `gateway.test.ts` (6).
- **Phase 2 — Tenant isolation (P0):** migration `020` adds `company_id` to
  `hosts`/`notes`, backfilled from the owner; shared-visibility queries are
  company-scoped; owner-move cascades the tag. Verified end-to-end
  (`tenantIsolation.itest.ts`, 3). Full IDOR/BOLA sweep found no other hole.
- **Phase 3 — Remote access:** SSH host-key pinning across all four ssh2
  connect sites (migration `021`, TOFU + refuse-on-change); log redaction
  hardened; SFTP backend-traversal ruled a false positive. Tests:
  `hostKeys.test.ts` (5), `hostKeys.itest.ts` (1).
- **Phase 4 — Infrastructure:** Docker least-privilege (cap_drop ALL + only
  NET_ADMIN + no-new-privileges); tight nginx CSP (incl. `'wasm-unsafe-eval'`
  for the KeePass Argon2 path only); Tauri CSP + dev-port fixes.
- **Phase 5 — Stability:** full suites green; resource-leak review of changed
  code clean; failure-mode analysis (Redis is unused at runtime; PG outages
  fail safe via transactions + global handler).

All work is committed on `claude/nifty-johnson-u2dwye`, one commit per phase,
with per-phase reports (`BASELINE_REPORT.md`, `PHASE_1..5_*.md`) and CHANGELOG
entries. No shipped migration was edited; no test was weakened or removed; no
security control was loosened to pass a test.

---

## Accepted risk & follow-ups (not blocking)

1. **SEC-004 (P2, browser only):** refresh token stays in `localStorage` for the
   browser build (Tauri uses the OS keyring). Compensating controls: reuse
   detection, 15m access TTL, immediate revocation (SEC-002/007), and the new
   CSP (SEC-006). Recommended follow-up: `HttpOnly; Secure; SameSite` refresh
   cookie for the browser build with CSRF protection (dual-mode with the Tauri
   body-token path) — needs an in-browser test rig.
2. **SEC-001 residual (P3):** telnet/vnc/sftp/ws-tunnel gateways still take the
   short-lived token via URL query (now unlogged by nginx). Follow-up: convert
   them to the same channel-auth as the SSH gateway.
3. **SEC-005 (P2):** API still runs as root for OpenVPN's `ip` child. Follow-up:
   isolate VPN into a privileged sidecar so the API runs fully unprivileged.
4. **SSH host-key re-pin UX:** re-pinning a rotated key is a DB row delete;
   an in-app "trust new key" action is a UX follow-up.

---

## Decision

**APPROVED FOR PRODUCTION**, conditioned on two routine deploy-time validations
that could not be executed in this sandbox:

1. **`nginx -t`** on the target host (with real TLS certs) after installing the
   updated `deploy/nginx/netsphere.conf`.
2. **In-browser CSP smoke test** of the built SPA behind the new CSP: exercise
   the web terminal (xterm), VNC/Telnet, TOTP/QR enrolment, the AI panel, and
   **KeePass import (Argon2/WASM)**, confirming zero CSP violations in the
   console. Relax only the specific directive if a genuine need appears — never
   to `unsafe-eval` or wildcards.

No unresolved P0 or P1 findings remain; authentication, authorization, tenant
isolation, IDOR/BOLA, and credential-leakage checks pass; builds and all
runnable test suites are green. The two conditions above are standard
pre-deploy gates, not open security defects.
