# Architecture Overview

Awamer (NetSphere Terminal) is an enterprise remote-administration platform:
manage SSH/SFTP/VNC/Telnet sessions, credentials, and OpenVPN tunnels from a
single client, with dynamic RBAC and encrypted secrets.

## Components

| Component | Stack | Role |
|-----------|-------|------|
| **Backend** (`backend/`) | Fastify 5 + Node 20 + PostgreSQL (raw SQL via `pg`) | REST API, auth/RBAC, secret storage, server-side session gateways, backend-runtime VPN |
| **Desktop** (`desktop/`) | Tauri 2 + React + TypeScript + Vite + Tailwind | The client; also runs native connectors (russh SSH/SFTP, openvpn) in Rust |
| **Data** | PostgreSQL (+ Redis) | Persistent state; migrations in `backend/migrations/NNN_*.{up,down}.sql` |
| **Edge** | nginx | TLS termination, reverse proxy, serves the built SPA |

## Two connection paths

Assets are reached **two ways**, which is central to the VPN design:

1. **Desktop-native** — the Tauri app connects directly from the user's machine
   (Rust `russh` for SSH/SFTP, native `openvpn`). Used by the desktop terminal.
2. **Backend gateways** — the browser/web client connects through server-side
   WebSocket/REST gateways (`ssh/gateway`, `sftpGateway`, `vnc/gateway`,
   `telnet/gateway`, `wsTunnelGateway`); the *backend* holds the connection.

A **desktop-runtime** VPN profile brings the tunnel up on the user's machine
(path 1); a **backend-runtime** profile brings it up on the server (path 2).

## Security model

- **AuthN** — Argon2 password hashing; JWT access/refresh with distinct secrets,
  enforced issuer/type/expiry; MFA (TOTP); per-IP login rate limit; temporary
  account lockout.
- **AuthZ (RBAC)** — dynamic roles in the `roles` table; the code catalog
  (`domain/permissions.ts`) is the source of truth and is reconciled into the
  locked built-ins on startup (`RoleService.syncBuiltins`). The server enforces
  via `requirePermission`/`can()`; the client only gates presentation off the
  user's effective permissions.
- **Secrets at rest** — credential, SMTP, AI-provider, and VPN secrets are
  encrypted with AES-256-GCM (`crypto/secretBox.ts`); `CREDENTIAL_ENCRYPTION_KEY`
  is mandatory in production.
- **VPN configs** — attacker-controlled OpenVPN configs are sanitized
  (`assertSafeOvpnConfig`) and openvpn runs with `--script-security 1`;
  backend-runtime tunnels are admin-only.
- **Transport** — backend bound to localhost behind nginx (TLS); Postgres/Redis
  on an internal-only network.

## Request lifecycle (REST)

```
client ──HTTPS──▶ nginx ──▶ Fastify
                              │ preHandler: JWT auth ─▶ requirePermission
                              │ route handler ─▶ repository (parameterized SQL)
                              │                    └─ SecretBox encrypt/decrypt
                              └─ global setErrorHandler (safe status + no leak)
```

## Data model highlights

- `users` (company/org unit, lockout), dynamic `roles`.
- `folders` (per-user tree), `hosts` (assets), `credentials` (+ TOTP, attachments,
  custom fields) — all encrypted where secret.
- `vpn_profiles` (encrypted config/creds; runtime desktop|backend) with
  `vpn_profile_id` on `folders`/`hosts` for inheritance.

## Testing & CI

- **Unit** (`*.test.ts`, DB-free) and **integration** (`*.itest.ts`, against a
  real Postgres) suites. CI (`.github/workflows/ci.yml`) runs typecheck, lint,
  unit + integration (with a `postgres:16` service), build, audit, and Rust
  fmt/clippy.

## Deployment

Backend via `deploy/docker-compose.production.yml` (migrations run on startup);
the frontend is built (`VITE_API_BASE_URL=<https origin>`) and published to
`/var/www/awamer`, served by nginx. See `deploy/README.md` and
`docs/ENTERPRISE_READINESS.md` for the operational backlog.
