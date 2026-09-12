# Awamer — Installation Evidence Guide

Every run of the official installer (`deploy/scripts/install.sh`) automatically
produces a **structured, sanitized evidence package** for that run. This guide
explains where it lives, how to read it, how to add notes, how to build a
support bundle, and — importantly — **what is safe to send and what must never
be sent**.

## Where evidence is stored

Each installation attempt creates its own directory, named by a UTC timestamp
run id (e.g. `2026-09-12_162500`):

```
/var/log/awamer/installation/<RUN_ID>/        # production default
```

If that location is not writable (non-root / dev), the installer falls back to:

```
<repo>/installation-evidence/<RUN_ID>/
```

Previous runs are **never overwritten** — including failed ones, which are the
most valuable evidence. A failed install keeps its full directory and finalizes
with `INSTALLATION STATUS: FAILED`.

## How to identify the RUN_ID

- The installer prints it in the final summary (`Evidence:` line).
- Otherwise, the most recent run is:
  ```bash
  ls -1dt /var/log/awamer/installation/*/ | head -n1
  ```

## Files in a run

| File | Contents |
| ---- | -------- |
| `00-system-info.txt` | host, OS, CPU/RAM/disk, component versions, app revision, sanitized env |
| `01-preflight.log` | resource / port / DNS / connectivity checks (PASS/WARN/FAIL) |
| `02-packages.log` | package before/after versions + result |
| `03-postgresql.log` | PostgreSQL connectivity / version |
| `04-migrations.log` | migration versions + results (from backend logs) |
| `05-nginx.log` | `nginx -v`, `nginx -t`, config activation |
| `06-certbot.log` | TLS / certificate issuance evidence (public metadata only) |
| `07-docker.log` | compose config, `docker compose ps`, container status |
| `08-application.log` | backend/app startup evidence |
| `09-health-readiness.log` | `/healthz` + `/readyz` probes (status + timing) |
| `10-errors.log` | every failed operation (phase, exit code, error code, message) |
| `11-warnings.log` | warnings, kept separate from successes |
| `12-actions.log` | ordered action history + **manual operator notes** |
| `13-final-state.txt` | post-install snapshot (services, ports, disk, memory) |
| `INSTALLATION_REPORT.md` | the human-readable summary report |
| `installation-manifest.json` | machine-readable summary for automated analysis |

## How to read INSTALLATION_REPORT.md

Start at the top: **Installation Identification** tells you the run id, server,
OS, and the exact **application revision** installed. Then scan:

1. **Final Installation Status** (bottom) — `SUCCESS`, `FAILED`, or `PARTIAL`.
2. **Errors** — if `FAILED`, the failing phase + `AW-INSTALL-…` code point you
   straight to an entry in `docs/INSTALLATION_TROUBLESHOOTING.md`.
3. **Preflight / Components / Phases** — what ran, versions, and durations.
4. **Nginx / TLS / Docker / Health** — the state of each subsystem.

> The report validates the **installation** only. It never claims production
> approval — that is a separate evaluation decision.

## How to add a manual note

When you perform a manual troubleshooting action (changed DNS, opened a
firewall port, retried certbot), record it so the timeline stays complete:

```bash
./deploy/scripts/deployment-note.sh "Changed DNS A record and retried certbot"
# or target a specific run:
./deploy/scripts/deployment-note.sh --run 2026-09-12_162500 "Opened TCP 80 in external firewall"
```

The note is timestamped into `12-actions.log`. **The text is stored only, never
executed.**

## After a reboot

Verify the stack recovered (writes a new, linked evidence run):

```bash
./deploy/scripts/validate-after-reboot.sh --link 2026-09-12_162500
```

## How to generate a support bundle

To share evidence for review, create a sanitized archive:

```bash
./deploy/scripts/support-bundle.sh 2026-09-12_162500
# → awamer-installation-2026-09-12_162500.tar.gz
```

Before archiving, the tool **re-runs redaction** over every file and then
**scans** the staged bundle for secret patterns. If any secret survives, it
**refuses** to create the archive (it does not merely warn).

## What is SAFE to send

- The support bundle produced by `support-bundle.sh` (recommended).
- Individual files from a run **after** confirming they are redacted:
  `INSTALLATION_REPORT.md`, `installation-manifest.json`, and the numbered
  `NN-*.log` / `.txt` files.

## What must NEVER be sent

Never send these — the bundle tool already excludes them (denylist), but do not
attach them by hand either:

- `.env`, `.env.production`, or any `*.env` file
- private keys / certificates' private material (`*.key`, `*.pem`, `*.p12`,
  `id_rsa*`, `id_ed25519*`)
- database dumps (`*.sql`, `*.dump`)
- password managers / KeePass files (`*.kdbx`), `.pgpass`, `.htpasswd`
- raw cookies, tokens, JWT secrets, or Authorization headers
- the internal `.manifest/` working directory of a run

**If you are unsure whether a file contains secrets, do not send it** — let
`support-bundle.sh` decide (it excludes anything uncertain).
