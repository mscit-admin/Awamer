# Final Installation Security + Dynamic HTTPS Port Report

Focused remediation of the installation/evidence subsystem. **No application
logic, authentication, JWT, RBAC, tenant isolation, ActiveSessionManager,
SSH/Telnet/VNC/Tunnel logic, PostgreSQL business schema, migration security, or
frontend features were modified.** Only deployment/installation scripts,
diagnostics, evidence tooling, and installation docs changed.

Baseline captured first in `INSTALLATION_SECURITY_REMEDIATION_BASELINE.md`.

## Fixes delivered

| ID | Fix |
| -- | --- |
| EVID-SEC-001 | Full `env` dump replaced with an explicit safe **allowlist** (`collect_safe_environment`). |
| EVID-SEC-002 | Bootstrap admin password never printed/logged/evidenced (both `grep BOOTSTRAP_ADMIN` prints removed). |
| DEPLOY-PORT-001 | Operator-selectable HTTPS port (default 443), templated nginx, centralized `build_public_https_url`, propagated everywhere, persisted to `/etc/awamer/deployment.conf`, preserved on update. |
| EVID-STATE-001 | Skip-TLS → **PARTIAL** (exit 2) with `incomplete_gates`; certbot failure stays **FAILED** (exit 1). |
| EVID-TEST-001 | New security/port/state test suite; existing suites kept green. |

## Files changed

- `deploy/scripts/lib/evidence.sh` — allowlist env collection; stronger
  `redact_stream` (credential URLs, `AUTHORIZATION=`, more keys); helpers
  `validate_https_port`, `build_public_https_url`, `build_https_redirect_target`,
  `render_nginx_config`; `ev_incomplete_gate`; manifest `incomplete_gates`;
  report HTTPS Port / Public URL / PARTIAL sections.
- `deploy/scripts/install.sh` — HTTPS port selection/validation/conflict-check,
  templated render, deployment.conf persistence, PARTIAL outcome + exit codes,
  safe bootstrap summary, per-port firewall guidance.
- `deploy/scripts/update.sh` — reads/preserves the persisted port, derives
  `API_BASE_URL` from domain+port, requires explicit confirmation to change the
  port (re-render → `nginx -t` → activate only on PASS), fails safely when the
  port can't be determined.
- `deploy/scripts/support-bundle.sh` — RUN_ID validation + canonical-path
  containment (§56/§57); scanner detects credential URIs (§8).
- `deploy/nginx/netsphere.conf` — now a port template (`__HTTPS_PORT__`,
  `__HTTP_REDIRECT_TARGET__`).
- `deploy/scripts/tests/security-port-test.sh` — new suite (added).
- Docs: `deploy/README.md`, `docs/INSTALLATION_EVIDENCE.md`,
  `docs/INSTALLATION_TROUBLESHOOTING.md`.

## Gate matrix (§66)

| Gate | Result |
| --------------------------------- | ------ |
| Full env dump removed | **PASS** |
| Safe env allowlist | **PASS** |
| Credential URLs redacted | **PASS** |
| Authorization completely redacted | **PASS** |
| Support-bundle scanner | **PASS** |
| Bundle rejects surviving secret | **PASS** |
| Bootstrap password never printed | **PASS** |
| HTTPS port selectable | **PASS** |
| Default 443 | **PASS** |
| Custom 6655 | **PASS** |
| Custom 8443 | **PASS** |
| Invalid port rejected | **PASS** |
| Port conflict rejected | **PASS** |
| Update preserves port | **PASS** |
| Public URL correct | **PASS** |
| Nginx port correct | **PASS** |
| Firewall instructions correct | **PASS** |
| Skip TLS = PARTIAL | **PASS** |
| Certbot failure = FAILED | **PASS** |
| TLS complete = SUCCESS | **PASS** |
| Run-ID path hardened | **PASS** |
| Existing evidence tests | **PASS** |
| New tests | **PASS** |
| READY regression | **PASS** |
| CFG-BOOT regression | **PASS** |

## Test counts (§67) — actually executed on Ubuntu 24.04 / bash 5.2 / nginx 1.24.0 / PostgreSQL 16

```
Evidence tests (deploy/scripts/tests/evidence-test.sh)
Passed:  31
Failed:  0
Skipped: 0

Installer simulation tests (deploy/scripts/tests/install-sim-test.sh)
Passed:  33
Failed:  0
Skipped: 0

Port tests (security-port-test.sh: PORT-001..008 + rendered nginx -t 443/6655/8443)
Passed:  38
Failed:  0
Skipped: 0

Secret leakage tests (security-port-test.sh: EVID-SEC-TEST-001..007 + EVID-BOOT-001/-002)
Passed:  14
Failed:  0
Skipped: 0

TLS-state tests (security-port-test.sh: INSTALL-STATE-001..004)
Passed:  10
Failed:  0
Skipped: 0

Regression tests (AUTHZ-STATE 001..022 + CFG-BOOT 001..006 + READY-DEPLOY 001..006 + active-session/revocation)
Passed:  43
Failed:  0
Skipped: 0
```

Total: **169 checks, 0 failures, 0 skips** (126 deploy/evidence + 43 backend
regression). `nginx -t` was executed on the rendered configs (not source-only).

## Automatic rejection conditions (§68) — all cleared

None of the rejection conditions hold: no arbitrary env dump; no
DATABASE_URL/REDIS_URL password in evidence; no surviving Bearer token; the
bundle cannot contain a tested secret; the bootstrap password appears **0 times**
in stdout/stderr/evidence/report/manifest/bundle; the HTTPS port is consistent
everywhere; the public URL includes the selected custom port; update preserves
the port; Skip-TLS ends **PARTIAL** (not SUCCESS); certbot failure ends
**FAILED**; invalid ports are rejected; a port conflict aborts without killing
the process; all mandatory tests pass.

## Not verified in sandbox (honest limitations)

- Real Let's Encrypt issuance on a public host and real Docker container
  runtime are exercised via faithful mocks (no public DNS / Docker daemon in the
  sandbox), as in prior cycles. Logic, exit codes, evidence, and rendered
  `nginx -t` are verified.
- `update.sh` full evidence-run integration (§58) was intentionally kept minimal
  (port preservation + safe change flow only) to avoid broad redesign; a
  complete update-evidence run is a documented follow-up.

## Final status

```
INSTALLATION EVIDENCE SECURITY + DYNAMIC HTTPS PORT — REMEDIATION COMPLETE
```

This hardens installation evidence and makes the HTTPS port operator-selectable
and consistently propagated; incomplete TLS is now reported as PARTIAL. It is
**not** a production-approval decision — that remains a separate evaluation.
