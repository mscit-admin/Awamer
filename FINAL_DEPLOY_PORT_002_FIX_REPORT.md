# Final Deployment Port Preflight Cleanup — DEPLOY-PORT-002

Minimal, focused remediation of a single obsolete hardcoded HTTPS port in the
early installer preflight. **No other code was modified** — authentication, JWT,
RBAC, ActiveSessionManager, SSH/Telnet/VNC/Tunnel logic, PostgreSQL schema,
migration logic, secret redaction, support-bundle logic, bootstrap-password
handling, TLS-state handling, the dynamic-HTTPS-port architecture, and the
app frontend/backend were left untouched.

## Problem

The Step-0 preflight still contained a hardcoded production HTTPS port:

```bash
for _p in 80 6655 8081; do
    ... preflight_check "Port $_p available" ...
done
```

This ran **before** `AWAMER_HTTPS_PORT` was resolved, so it emitted a
`Port 6655 available: WARN/PASS` line even when the operator later selected
`443`, `8443`, or `9443` — a misleading warning about a port not part of the
deployment.

## Fix (minimum change)

`deploy/scripts/install.sh` — the early preflight now checks only genuinely
**static** ports (ACME HTTP-01 on 80, host-bound backend 8081):

```bash
for _p in 80 8081; do ... done
```

The production HTTPS port is **not** checked here. It is already checked
dynamically in Step 5 against the resolved single source of truth
`AWAMER_HTTPS_PORT` (unchanged, pre-existing code):

```bash
preflight_check "HTTPS port valid" PASS "$HTTPS_PORT"
...
preflight_check "HTTPS port $HTTPS_PORT free" PASS|FAIL ...   # conflict → err AW-INSTALL-PORT-002
```

So the installer checks exactly the selected port, and never a historical one.
Conflict behavior (FAIL, no auto-kill) and update-mode port preservation are
unchanged.

### Search results (obsolete hardcoded runtime assumptions)

`grep -n '6655\|443'` across the runtime deploy scripts found exactly one
invalid runtime assumption — the preflight loop above (fixed). The remaining
occurrences are intentionally kept:

| Location | Occurrence | Verdict |
| -------- | ---------- | ------- |
| `install.sh:142` (was) | `for _p in 80 6655 8081` | **REMOVED** (invalid runtime assumption) |
| `update.sh:14` | `API_BASE_URL=https://my.domain:6655` in a usage **comment** | kept (documentation example) |
| `evidence.sh` `build_public_https_url` | `443 → https://domain` in a **comment** | kept (explains the default-443 rule) |
| `nginx/netsphere.conf` | `VITE_API_BASE_URL=https://<host>:6655` build **comment** | kept (example; `<host>` already a placeholder) |
| default `443` in `install.sh`/`evidence.sh`/`update.sh` | the documented DEFAULT port | kept (correct default) |
| `security-port-test.sh` | `443`/`6655`/`8443` | kept (test fixtures) |

No valid runtime assumption other than the preflight loop existed.

## Gate matrix

| Check | Result |
| ------------------------------------ | ---- |
| Obsolete 6655 preflight removed | **PASS** |
| Dynamic selected port used | **PASS** |
| Port 443 scenario | **PASS** |
| Port 6655 scenario | **PASS** |
| Port 8443 scenario | **PASS** |
| Non-interactive port scenario | **PASS** |
| Update preserves port | **PASS** |
| Existing installation security tests | **PASS** |

## Tests

New `DEPLOY-PORT-002-TEST-001..005` added to
`deploy/scripts/tests/security-port-test.sh`. Each runs the real installer
against mocked externals and inspects the run's `01-preflight.log`:

- **TEST-001 (443):** 80 + 8081 + `HTTPS port 443 free` checked; **no**
  `Port 6655 available`.
- **TEST-002 (6655):** `HTTPS port 6655 free` checked; 443 not checked as Awamer
  HTTPS; no obsolete static 6655 line.
- **TEST-003 (8443):** `HTTPS port 8443 free` checked; neither 6655 nor 443
  checked as Awamer HTTPS.
- **TEST-004 (non-interactive `AWAMER_HTTPS_PORT=9443`):** 9443 checked; no
  obsolete HTTPS-port checks.
- **TEST-005 (update, persisted 6655):** 6655 preserved and used (never reset to
  443).

### Actual test counts (executed on Ubuntu 24.04 / bash 5.2 / nginx 1.24.0 / PostgreSQL 16)

```
security-port-test.sh (incl. 19 new DEPLOY-PORT-002 checks)
Passed:  81   Failed: 0   Skipped: 0

evidence-test.sh
Passed:  31   Failed: 0   Skipped: 0

install-sim-test.sh
Passed:  33   Failed: 0   Skipped: 0

Backend regression (AUTHZ-STATE + CFG-BOOT + READY-DEPLOY + revocation)
Passed:  43   Failed: 0   Skipped: 0
```

Total: **188 checks, 0 failures, 0 skips.** All existing security tests (secret
redaction, bootstrap password, TLS PARTIAL state, certbot failure, dynamic port
propagation, support-bundle security) remain PASS with unchanged expectations.

## Final acceptance

> The installer checks exactly the HTTPS port selected for that installation and
> never reports a warning for an unrelated historical HTTPS port.

**Met.** The only diff to runtime code is `for _p in 80 6655 8081` →
`for _p in 80 8081` (plus its comment); everything else is new tests, this
report, and a CHANGELOG line.
