# Installation Evidence, Diagnostics & Future-Evaluation System — Implementation Report

**Scope:** installation/deployment scripts, diagnostics, installation logging,
validation evidence, and installation documentation only. **No application
source, business logic, security architecture, or PostgreSQL business schema
was modified.** Authentication, JWT, RBAC, tenant isolation,
ActiveSessionManager, and the SSH/Telnet/VNC/Tunnel gateways are untouched.

**Objective delivered:** every installation on a new server now automatically
produces enough sanitized evidence to reconstruct what happened, identify
failures, capture manual interventions, and support a later production-readiness
evaluation — while guaranteeing no secrets are written to evidence.

---

## Files created

| File | Purpose |
| ---- | ------- |
| `deploy/scripts/lib/evidence.sh` | Core sourceable library: run-id lifecycle, structured logging, **automatic secret redaction**, command timing, system-info/network/preflight collection, health probes, manual notes, pure-Bash JSON manifest + Markdown report generation. Zero runtime deps beyond coreutils. |
| `deploy/scripts/deployment-note.sh` | Records an operator's manual troubleshooting action into a run's `12-actions.log` (§22). Text is **stored, never executed**. |
| `deploy/scripts/support-bundle.sh` | Builds `awamer-installation-<RUN_ID>.tar.gz`: denylist exclusion (§38), **re-redaction** on stage (§37), and a **blocking** secret scan that rejects the bundle if any secret survives (§39). |
| `deploy/scripts/validate-after-reboot.sh` | Post-reboot validation (§43): PostgreSQL/Docker/containers/Nginx/`/healthz`/`/readyz`, written as a new linked evidence run. |
| `deploy/scripts/tests/evidence-test.sh` | 31 unit tests for the evidence library (§45). |
| `deploy/scripts/tests/install-sim-test.sh` | 33 end-to-end simulated-install + controlled-failure assertions against the **real** installer with mocked externals (§46). |
| `docs/INSTALLATION_TROUBLESHOOTING.md` | Failure knowledge base (§26/§27/§28/§30): DEPLOY-001, DEPLOY-002, the `INSTALL-XXX` workflow, and the `AW-INSTALL-<PHASE>-NNN` error-code table. |
| `docs/INSTALLATION_EVIDENCE.md` | How to find, read, note, bundle, and safely send evidence — including what must never be sent (§47). |
| `INSTALLATION_EVIDENCE_IMPLEMENTATION_REPORT.md` | This report (§48). |

## Files modified

| File | Change |
| ---- | ------ |
| `deploy/scripts/install.sh` | Sources the evidence library; `evidence_init` at start; evidence-aware `say/ok/warn/err`; a `Step 0` system-info + preflight phase; per-phase markers and evidence capture (packages, docker, readiness/migrations, nginx, TLS); an `ERR` trap that preserves evidence on unexpected failure (never auto-fixes, §44); `SUCCESS`/`FAILED` finalization with the §35/§36 summaries. **The DEPLOY-001/DEPLOY-002 install logic is unchanged** (verified fail-closed). |
| `.gitignore` | Ignore `installation-evidence/` and `awamer-installation-*.tar.gz`. |
| `CHANGELOG.md` | New entry for the evidence system. |

---

## Logging architecture

- **One directory per run, never overwritten** (§1/§2). Run id is a UTC
  timestamp (`YYYY-MM-DD_HHMMSS`); a collision appends a numeric suffix. Both
  UTC and local time + timezone are recorded. Production location
  `/var/log/awamer/installation/<RUN_ID>/`, with an in-repo
  `installation-evidence/<RUN_ID>/` fallback when that is not writable.
- **Stable structured files** `00-…`–`13-…` plus `INSTALLATION_REPORT.md` and
  `installation-manifest.json` (§3). Errors, warnings, and action history are
  kept in separate files (§19/§20/§21) so successes and warnings never mix.
- **Command logging** captures timestamp, phase, description, exit code, and
  **duration** for each important operation (§7/§31), with a PASS/FAIL result.
- **Before/after state** for components (§32) and a **post-install snapshot**
  in `13-final-state.txt` (§42).
- **Machine-readable manifest** (`installation-manifest.json`) is emitted by a
  small pure-Bash JSON escaper — no `jq`/`python` dependency at install time —
  and validated as JSON by the test suite (§29).
- **Application revision** is recorded from git (commit/branch/describe) or, for
  archive installs, a content SHA-256 fingerprint (§40). Non-secret config files
  (compose, nginx, install/update scripts) get SHA-256 fingerprints (§41).
- **Error codes** `AW-INSTALL-<PHASE>-NNN` are attached to every recorded
  failure and surfaced in the report and failure summary (§30/§35).

## Redaction architecture

- A single `redact_stream` filter is applied to **everything** the library
  writes — logs, blocks, kv values, manifest, and report inputs — so redaction
  does not depend on developer discipline (§9).
- It masks `KEY=value` / `KEY: value` / `"key":"value"` where the **key** name
  contains any of `PASSWORD|PASS|SECRET|TOKEN|PRIVATE_KEY|AUTHORIZATION|COOKIE|
  API_KEY|JWT|CREDENTIAL|ENCRYPTION_KEY|PSK|BEARER` (case-insensitive), plus
  HTTP `Authorization`/`Cookie` headers and PEM private-key blocks. It keys off
  the field **name**, so table cells like `Result: PASS` are never mangled.
- `_ev_kv_set` reconstructs `KEY=value` before redacting, so a sensitive key
  masks its value even when key and value arrive as separate arguments
  (defence-in-depth).
- Secrets' **lengths are not printed** (§8).

## Support-bundle mechanism

Three independent safety layers (§37/§38/§39):

1. **Denylist** — `.env*`, `*.key`, `*.pem`, `*.sql`/`*.dump`, `id_rsa*`,
   `*.kdbx`, `.pgpass`, the internal `.manifest/`, and binaries are excluded;
   anything uncertain is excluded.
2. **Re-redaction** — every staged text file is passed through `redact_stream`
   again, even though it was already redacted on write.
3. **Blocking scan** — the staged tree is scanned for un-redacted sensitive
   `KEY=value`, raw private-key blocks, and bearer tokens (checking the captured
   value is not a `[REDACTED]` marker, to avoid false positives on redacted env
   lines). If a real secret is found, **bundle creation is rejected** (exit 3),
   not merely warned.

## Failure handling

- Installer exit codes: `0` only on successful mandatory installation, non-zero
  on any mandatory-phase failure (§33), verified across six scenarios.
- On failure, evidence is **preserved** (never deleted), the run finalizes
  `FAILED` with the failing phase/command/exit code/error code, and the §35
  summary prints the evidence path (§23/§35).
- Unexpected command failures are captured by an `ERR` trap and recorded — the
  installer never silently applies random fixes to unknown errors (§44).
- Success finalizes `SUCCESS` but the installer explicitly does **not** claim
  production approval (§24/§49).

---

## Tests executed

Run locally on Ubuntu 24.04, bash 5.2, nginx 1.24.0, with mocked externals for
the simulated installs (no real service touched).

| Suite | Command | Result |
| ----- | ------- | ------ |
| Evidence library unit tests (§45) | `bash deploy/scripts/tests/evidence-test.sh` | **31 PASS / 0 FAIL** |
| Simulated install + failure tests (§46) | `bash deploy/scripts/tests/install-sim-test.sh` | **33 PASS / 0 FAIL** |
| Bash syntax (`bash -n`) — all deploy scripts | — | all OK |
| DEPLOY-002 fail-closed re-verification (integrated installer) | manual harness | rc=1, bootstrap retained, HTTPS not activated, `FAILED`, no leak |

**Unit coverage (§45):** run-directory creation; previous-run preservation;
error recording; warning recording (separate from successes); exit-code
recording; secret redaction; kv value redaction; command timing; manifest
generation (valid JSON); report generation; support-bundle generation;
support-bundle secret scanning (real leak + private key detected, redacted
content clean); failed-install evidence preservation; successful-install
finalization.

**Simulated-failure coverage (§46):** success; certbot failure
(`AW-INSTALL-TLS-001`); `nginx -t` failure; readiness timeout
(`AW-INSTALL-READY-001`); invalid `docker compose config`
(`AW-INSTALL-DOCKER-001`); docker unavailable. Every scenario asserts exit
code, finalized status, evidence preservation, valid manifest, and **no secret
leak**.

---

## Known limitations

- **Real Let's Encrypt issuance and Docker container runtime** cannot be
  exercised in the sandbox (no public DNS/inbound TCP 80; Docker daemon down),
  so those paths are validated via faithful mocks, not a live host. A one-time
  live fresh-install smoke test is still recommended.
- **Migration evidence** is scraped from the backend container's startup logs
  (the app runs migrations on boot); it records start/end versions and result
  but not per-migration millisecond timings when the app does not emit them.
- **`update.sh`** already has fail-safe nginx reload behavior but does not yet
  emit a full evidence run; it can adopt `lib/evidence.sh` in a follow-up
  without changing application logic.
- Redaction is pattern-based; it targets the documented secret key names and
  formats. New secret-bearing key names should be added to
  `_EV_SENSITIVE_WORDS` (and the denylist) as they are introduced.

---

## Final status

```
INSTALLATION EVIDENCE SYSTEM IMPLEMENTED
```

This work improves installation observability and makes future installation
failures reproducible, documented knowledge. It does **not** by itself constitute
production approval (§49) — that remains a separate evaluation decision.
