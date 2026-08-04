# Security Policy

## Reporting a vulnerability

Report suspected vulnerabilities privately to the maintainers (do **not** open a
public issue). Include reproduction steps, affected version/commit, and impact.
You will get an acknowledgement and a remediation timeline.

## Security posture (summary)

- **Secrets at rest** — credential, SMTP, AI-provider, and VPN secrets are
  encrypted with AES-256-GCM (`backend/src/crypto/secretBox.ts`).
  `CREDENTIAL_ENCRYPTION_KEY` is mandatory in production.
- **Auth** — Argon2 password hashing, JWT access/refresh with distinct secrets
  and enforced issuer/type/expiry, MFA (TOTP), account lockout, rate limiting.
- **RBAC** — DB-backed dynamic roles; the server is the source of truth
  (`requirePermission` / `can()`); the client only gates presentation.
- **Transport** — backend bound to `127.0.0.1` behind nginx (TLS); Postgres/Redis
  on an internal-only Docker network.
- **VPN configs** — attacker-controlled OpenVPN configs are sanitized
  (`assertSafeOvpnConfig`) and openvpn runs with `--script-security 1`;
  backend-runtime tunnels are admin-only.

## Known hardening backlog

See [`docs/ENTERPRISE_READINESS.md`](docs/ENTERPRISE_READINESS.md) for the
tracked security/quality backlog (dependency advisories, backend container
least-privilege, expanded test coverage, per-permission VPN secret reveal).
