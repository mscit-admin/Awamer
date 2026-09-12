# Awamer — Installation Troubleshooting Knowledge Base

A living knowledge base of **confirmed** installation problems. Every entry is a
real, reproduced failure with a verified resolution — never a speculative root
cause (§26). When a new installation failure occurs, follow the workflow in
[§ Future failure workflow](#future-failure-workflow), assign the next
`INSTALL-XXX` id, and add an entry here once the cause is confirmed.

## Identifier scheme (§28)

- `DEPLOY-XXX` — pre-existing deployment issues already established in this repo
  (kept as-is).
- `INSTALL-XXX` — new installation-specific issues discovered via the evidence
  system.
- `AW-INSTALL-<PHASE>-NNN` — stable machine **error codes** emitted into
  `10-errors.log`, the manifest, and the failure summary, so a failure can be
  grepped and cross-referenced to an entry below.

| Error code | Phase | Typical entry |
| ---------- | ----- | ------------- |
| `AW-INSTALL-PREFLIGHT-001` | preflight | resource/port/DNS preflight failure |
| `AW-INSTALL-PREFLIGHT-002` | secrets | missing/placeholder env values |
| `AW-INSTALL-NGINX-001` | nginx | final HTTPS `nginx -t` failed |
| `AW-INSTALL-NGINX-002` | nginx | bootstrap vhost `nginx -t` failed |
| `AW-INSTALL-TLS-001` | tls | certbot issuance failed |
| `AW-INSTALL-DB-001` | database | PostgreSQL unavailable |
| `AW-INSTALL-MIGRATION-001` | migrations | a migration failed |
| `AW-INSTALL-DOCKER-001` | docker | compose config invalid / daemon down |
| `AW-INSTALL-READY-001` | readiness | `/readyz` never reached 200 |
| `AW-INSTALL-PORT-001` | nginx | invalid HTTPS port (not 1..65535) |
| `AW-INSTALL-PORT-002` | nginx | selected HTTPS port in use by a non-nginx process |
| `AW-INSTALL-<PHASE>-000` | any | unexpected/unclassified command failure |

---

## Confirmed problems

### DEPLOY-001 — Nginx rejects `http2 on;`

- **Problem ID:** DEPLOY-001
- **Symptoms:** `nginx -t` fails with `unknown directive "http2"`; the installer
  aborts at the nginx phase. Machine code: `AW-INSTALL-NGINX-001`.
- **Affected versions/environment:** Ubuntu 22.04 (nginx 1.18) and Ubuntu 24.04
  (nginx 1.24) — any distro nginx older than 1.25.1.
- **Root cause:** The standalone `http2 on;` directive was introduced in nginx
  1.25.1 and does not exist on the distro nginx shipped with the supported
  Ubuntu releases.
- **How detected:** `05-nginx.log` shows the `unknown directive` error; the
  nginx version is in `00-system-info.txt` / the Components table.
- **Resolution:** Enable HTTP/2 via the `listen … ssl http2` parameter form,
  which works on distro nginx and newer nginx alike. (Shipped in
  `deploy/nginx/netsphere.conf`.)
- **Verification:** `nginx -t` passes; the report's Nginx section shows
  `nginx -t: PASS`.
- **Prevention:** The installer prints the nginx version as a preflight
  (Components table). Do not reintroduce the standalone `http2 on;` directive.

### DEPLOY-002 — Fresh TLS install fails before Certbot

- **Problem ID:** DEPLOY-002
- **Symptoms:** On a brand-new host, the installer fails enabling the HTTPS
  vhost / running `nginx -t` **before** any certificate exists (the SSL block
  references missing `fullchain.pem`/`privkey.pem`).
- **Affected versions/environment:** Any fresh install with no pre-existing
  Let's Encrypt certificate for the domain.
- **Root cause:** The final HTTPS config was enabled and validated before the
  certificate had been issued (chicken-and-egg ordering).
- **How detected:** `05-nginx.log` / `06-certbot.log` ordering; the run fails
  before `tls_issuance` is recorded.
- **Resolution:** Bootstrap ordering — install an HTTP-only ACME vhost serving
  `/var/www/certbot` first, obtain the certificate via `certbot certonly
  --webroot`, then enable the final HTTPS config and validate. Certbot failure
  is fail-closed: the installer exits non-zero and leaves the bootstrap vhost
  serving (the cert-less HTTPS config is never activated).
- **Verification:** Fresh install reaches `tls_issuance: SUCCESS` and
  `nginx -t: PASS`; on certbot failure the run finalizes `FAILED` with
  `AW-INSTALL-TLS-001` and HTTPS is not activated.
- **Prevention:** `update.sh` never (re)issues certificates and never reloads a
  config that fails `nginx -t`.

---

### EVID-STATE-001 — Skipped TLS reported as SUCCESS

- **Problem ID:** EVID-STATE-001
- **Symptoms:** Operator declines certbot issuance (or skips nginx), yet the
  installer finalized `SUCCESS` and exited 0 — automation then treats a site
  with no active HTTPS as production-ready.
- **Root cause:** The finalize path was unconditionally `SUCCESS`.
- **Resolution:** Skipping TLS now yields **PARTIAL** (exit `2`) with
  `incomplete_gates` (`TLS_CERTIFICATE`, `HTTPS_ACTIVATION`); a certbot
  **failure** remains **FAILED** (exit 1). The installer never prints
  "production ready/approved" for PARTIAL.
- **Verification:** `INSTALL-STATE-001..004` in
  `deploy/scripts/tests/security-port-test.sh`.

### DEPLOY-PORT-001 — Fixed / inconsistent HTTPS port

- **Problem ID:** DEPLOY-PORT-001
- **Symptoms:** nginx hardcoded `6655` while the installer printed
  `https://domain` (no port) and firewall guidance said `443` — a mismatch; no
  way to choose the port.
- **Root cause:** Hardcoded port in the nginx config; no operator input; URL
  strings duplicated across scripts.
- **Resolution:** Operator-selected port (default 443, `AWAMER_HTTPS_PORT` for
  automation), a templated nginx config rendered by `render_nginx_config`, a
  centralized `build_public_https_url`, propagation everywhere, persistence in
  `/etc/awamer/deployment.conf`, and preservation on update.
- **Verification:** `PORT-001..008` + rendered `nginx -t` for 443/6655/8443 in
  `security-port-test.sh`.

### EVID-SEC-001 / -002 — Evidence secret leakage / bootstrap password shown

- **Problem IDs:** EVID-SEC-001 (full `env` dump), EVID-SEC-002 (bootstrap
  password printed).
- **Resolution:** `collect_system_info` now uses an env **allowlist**
  (`collect_safe_environment`), redaction covers credential URLs / `AUTHORIZATION=`
  / more key names, and the installer never prints/greps the bootstrap password.
- **Verification:** `EVID-SEC-TEST-001..007`, `EVID-BOOT-001/-002`.

<a name="future-failure-workflow"></a>
## Future failure workflow (§27)

```
Installation fails
        ↓
Evidence preserved automatically (never deleted, §23)
        ↓
Error assigned an INSTALL-XXX id (+ AW-INSTALL-<PHASE>-NNN code)
        ↓
Root cause investigated from the evidence run
        ↓
Resolution documented as a new entry above
        ↓
Installer improved if appropriate
        ↓
Fresh-install test repeated (deploy/scripts/tests/install-sim-test.sh)
```

When you hit a failure:

1. Find the run: `ls -1dt /var/log/awamer/installation/*/ | head` (or the in-repo
   `installation-evidence/` fallback).
2. Read `INSTALLATION_REPORT.md`, then `10-errors.log` for the phase + error
   code, and the matching phase log (`03-…`/`05-…`/`06-…`/`07-…`).
3. Reproduce with the simulated harness where possible
   (`deploy/scripts/tests/install-sim-test.sh` has a scenario per phase).
4. Only once the cause is **confirmed**, add an `INSTALL-XXX` entry here.

_Do not add speculative root causes — only confirmed findings belong here (§26)._
