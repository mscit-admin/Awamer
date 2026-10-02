# Production Configuration

## Startup validation (fail closed)

The backend runs with `APP_ENV=production`, which the production compose sets explicitly.

| Item | Production behaviour | Evidence |
|---|---|---|
| JWT secrets | Required, ≥32 chars, must differ; values containing "dev" refused | `config/index.ts`; CFG-BOOT tests |
| `CREDENTIAL_ENCRYPTION_KEY` | Required; must decode to exactly 32 bytes | `secretBox.ts`; unit test "throws in production when unset" |
| Database credentials | Compose `${…:?}` for the admin and all three role passwords; provisioning refuses short, identical or `CHANGE_ME` values | compose; DBLP-001 |
| Runtime DB role | **Refuses** superuser, CREATEROLE/DB, BYPASSRLS, REPLICATION, the schema owner, or schema CREATE | `db/runtimeRole.ts`; DBLP-005; startup NEG-1/NEG-2 |
| CORS allowed origins | **New:** refuses `*`, `null`, wildcards, `http://` (except `http://tauri.localhost`, the Windows Tauri origin) and non-https/tauri schemes. Requires ≥1 origin. The development default `http://localhost:1420` is therefore refused in production. | `assertProductionHardening`; PROD-CFG-003; startup NEG-4 |
| API documentation | **New:** `ENABLE_API_DOCS=true` refuses to start; Swagger modules are imported only when enabled; nginx proxies only `/api/`, `/healthz`, `/readyz` | PROD-CFG-002; startup NEG-3; smoke `GET /docs` → 404 |
| VPN helper authentication | **New:** `VPN_HELPER_SECRET` required, ≥32 chars (the helper also refuses <32); HMAC IPC | PROD-CFG-004 |
| Bootstrap admin password | Dev default and placeholders refused; ≥16 chars | CFG-BOOT-001…006 |
| `APP_PUBLIC_BASE_URL` | https only; startup fails if email is enabled without it | `config/index.ts` |
| `TRUST_PROXY` | `true`, `*` and broad ranges refused; the installer computes the gateway `/32` | `trustProxy.test.ts` |
| `APP_VERSION` | Mandatory; the image build refuses a mismatch with `package.json` | compose; Dockerfiles; container emulation |

## Search for insecure defaults (`changeme` / `password` / `admin` / `secret` / `development` / localhost fallback)

| Occurrence | Verdict |
|---|---|
| `DEV_BOOTSTRAP_PASSWORD = "ChangeMe!2026"` (`config/index.ts`) | Legitimate: development only, **rejected in production** |
| `BOOTSTRAP_ADMIN_USERNAME` default `admin`, email `admin@netsphere.local` | Legitimate: an identifier, not a credential; the password is mandatory and strong |
| `APP_ENV` default `development` | Accepted risk OR-08: the dev compose relies on it; the production compose sets `production` explicitly |
| `CORS_ALLOWED_ORIGINS` default incl. `http://localhost:1420` | Legitimate for development; **now refused in production** |
| `.env.example` dev JWT secrets / `ChangeMe!2026` | Development template; rejected in production |
| `deploy/.env.production.example` `CHANGE_ME_…` | Template; the installer refuses `CHANGE_ME` values; the config rejects weak secrets; provisioning rejects placeholders |
| `deployments/docker-compose.yml` Redis `changeme` default, `0.0.0.0` publishes | **Development compose only**; not used by the installer or production |
| Login page `v1.0.0 · phase 1 foundation` | **Fixed**: now `v{__APP_VERSION__}` |
| SMTP page placeholder with a real host/IP (`161.97.78.116.nip.io:6655`); same IP in a test fixture | **Fixed**: neutral `https://awamer.example.com`; RFC 5737 address in the test |
| `localhost` checks in `ai.ts`, `networkPolicy.ts` | Deny-list logic, not fallbacks |

## Logging

- Request logs contain **method + path only**. The query string is dropped, so the VNC ticket and reset tokens never reach the log. Headers and body are not logged.
- Redaction (pino) covers:
  - passwords and credential fields;
  - private keys and passphrases;
  - API keys;
  - TOTP / OTP values and MFA codes;
  - access, refresh, MFA-challenge, step-up and reset tokens;
  - VNC tickets;
  - `authorization`, `cookie`, `set-cookie` and `x-step-up-token` headers;
  - VPN `config`;
  - `secret_enc` envelopes;
  - DB connection strings.
- Evidence:
  - LOG-REDACT-001/002 (real pino + Fastify);
  - **live scans of the production-mode server logs** (native run and hardened container) for the actual secret values in use. The scan covered the admin password, DB passwords, JWT secrets, encryption key, helper secret, JWTs (`eyJ…`), private keys, `otpauth://` URIs and `ticket=`, and found **0 occurrences**.

## Audit-failure monitoring

| Item | Value |
|---|---|
| Metric | `audit_write_failures_total` (integer since process start), field of `GET /readyz` |
| Trigger | Any failed `INSERT INTO audit_logs`. The operation itself continues (fail-open for availability); an `audit_write_failed` error log carries **identifiers only, never the event payload** |
| Expected normal value | `0`. Verified `0` live before and after the 60-check smoke run |
| Alert | **`audit_write_failures_total > 0` in a monitoring interval** (or any `audit_write_failed` log line). Page the on-call; severity high |
| Response | Check DB health, disk and `audit_logs` permissions (`awamer_app` needs INSERT). Treat the gap as an audit blind spot; correlate with the access logs for that window; keep the instance in service unless the DB is failing |
| Sensitive content | None: an integer only; readiness is unaffected |

## Environment separation (DEV / QA-UAT / PROD)

| Asset | Separation mechanism | Status |
|---|---|---|
| Databases | One PostgreSQL per deployment (compose `postgres` + `netsphere-postgres-data` volume). The dev compose and production compose are separate files | ✅ by design. Note: the integration test suite re-provisions the cluster-wide `awamer_*` roles, so **never run tests against a cluster that hosts a real Awamer database** |
| JWT secrets, `CREDENTIAL_ENCRYPTION_KEY`, `VPN_HELPER_SECRET`, DB role passwords | Generated **per install** by `generate-secrets.sh` (`openssl rand`); never committed; `.env.production` is mode 600 and git-ignored. Production refuses dev values | ✅. Each environment must run its own installer: never copy `.env.production` between environments (operational rule) |
| Admin credentials | Bootstrap password generated per install, never displayed | ✅ |
| VPN credentials | PKI (CA / server / client keys) generated per VPN server and sealed with that installation's encryption key; a copied DB is useless without the key | ✅ |
| CI | Dummy, clearly-labelled test-only secrets; ephemeral PostgreSQL service | ✅ |

## Backup / recovery

| Topic | Definition |
|---|---|
| Database backup | `deploy/scripts/backup.sh`: `pg_dump --no-owner --no-acl` via the admin role, gzip, daily cron example in `deploy/README.md` |
| Backup encryption | **New:** `BACKUP_GPG_RECIPIENT` makes it `*.sql.gz.gpg` (public key only on the host). Without it a warning is printed. Files are mode 600 in a mode-700 directory (**new**, `umask 077`). Credential secrets inside are additionally AES-GCM-sealed with `CREDENTIAL_ENCRYPTION_KEY`, which is **not** in the dump: back up `.env.production` separately and securely |
| Retention | 14 days (`find -mtime +14 -delete`, both formats) |
| Restore | `deploy/scripts/restore.sh <file>`: typed confirmation; decrypts `.gpg`; recreates the DB; restores with `ON_ERROR_STOP`; **re-runs `db-provision` + `migrate`** (new: required by least privilege) |
| Recovery verification | **New:** `restore.sh` waits for `/readyz` = 200 and fails loudly otherwise. DBLP-007 proves the dump → restore → re-provision cycle on PostgreSQL 16 |
| Not done | No destructive restore was run against real data, as instructed |
