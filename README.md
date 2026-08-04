# NetSphere Terminal — v1.7.0

> Enterprise Remote Administration & Terminal Management Platform

## Two ways to use this repository

### 🚀 Production deployment (you have a server)

If you're deploying NetSphere on a real Ubuntu server with HTTPS, go
directly to **[`deploy/README.md`](deploy/README.md)**. The one-shot
installer handles everything:

```bash
cd /opt/netsphere
tar xzf ~/netsphere-1.6.0.1.tar.gz --strip-components=1
chmod +x deploy/scripts/install.sh
./deploy/scripts/install.sh
```

### 🛠️ Local development

Read the section below for working on NetSphere itself.

---

> Enterprise Remote Administration & Terminal Management Platform — **Phase 2: Session Management**

Building on the Phase 1 auth foundation, this release adds the data model
for managing remote hosts: hosts, folders, tags, credentials, and connection
history. Phase 3+ protocol handlers (SSH, RDP, SFTP) will consume this model.

---

## Table of contents

1. [System requirements](#system-requirements)
2. [Installation](#installation)
3. [Running the app](#running-the-app)
4. [What works in Phase 1](#what-works-in-phase-1)
5. [Troubleshooting](#troubleshooting)
6. [Architecture overview](#architecture-overview)
7. [Project layout](#project-layout)

---

## System requirements

### Required

| Component | Minimum version | Notes |
|---|---|---|
| **OS** | Ubuntu 22.04 / 24.04 (Debian/Fedora/Arch also work) | macOS and Windows untested in 1.0.0 |
| **Docker** | 24.x | with the Compose plugin (`docker compose`, not legacy `docker-compose`) |
| **Node.js** | 20.x or 22.x | required for the desktop and backend dev mode |
| **npm** | 10.x | bundled with Node |
| **Rust** | **1.85+** | required for `tauri dev`; older Rust fails on `edition2024` |
| **make** | any | for the convenience targets |

### System libraries (Linux only, for the Tauri desktop)

```bash
sudo apt update
sudo apt install -y \
  libwebkit2gtk-4.1-dev \
  build-essential curl wget file \
  libxdo-dev libssl-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev pkg-config
```

If `libwebkit2gtk-4.1-dev` isn't found on older Ubuntu, install `libwebkit2gtk-4.0-dev` instead.

### Recommended

- **8 GB RAM** (Argon2id uses 64 MiB per concurrent login)
- **2 GB free disk** for Docker images + Rust target cache
- **An ext4/xfs filesystem** (not NTFS/exFAT; file watchers and dotfiles behave poorly on those)
- **Path without spaces** — paths like `/media/user/Old Data/...` will trip up some tooling. Working from `~/netsphere/` or similar is safest.
- **Your user in the `docker` group** so you don't need `sudo` for every command:
  ```bash
  sudo usermod -aG docker $USER && newgrp docker
  ```

### What you do NOT need

- Go toolchain (the backend is Node.js as of 1.0.0)
- PostgreSQL on the host (it runs in Docker)
- Redis on the host (it runs in Docker)

---

## Installation

### 1. Get the source

```bash
mkdir -p ~/netsphere && cd ~/netsphere
tar xzf /path/to/netsphere-1.0.0.tar.gz --strip-components=1
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` if you need to change ports or the bootstrap admin password. The defaults work out of the box.

If you already have PostgreSQL running locally on host port 5432, change this line in `.env`:

```
POSTGRES_HOST_PORT=5433
```

The container's internal port is always 5432; this only changes what's exposed on the host.

### 3. Install Rust (one-time, for the desktop)

If you don't already have Rust 1.85 or newer:

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"
rustup update stable
rustc --version    # must be ≥ 1.85
```

### 4. Bring up the backend stack

```bash
make docker-up                # builds + starts postgres, redis, auth-service
make migrate-up-docker        # applies migrations 001-004
```

After migrations run, restart the auth-service so it sees the now-existing
`users` table and creates the bootstrap admin:

```bash
docker compose --env-file .env -f deployments/docker-compose.yml restart auth-service
sleep 5
docker compose --env-file .env -f deployments/docker-compose.yml logs --tail=20 auth-service
```

You **must** see this line in the logs:

```
bootstrap admin created — change this password immediately
```

If you don't see it, see [Troubleshooting](#troubleshooting).

### 5. Verify the backend with curl

```bash
curl -s -X POST http://localhost:8081/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"ChangeMe!2026"}'
```

You should get a JSON response with `access_token` and `refresh_token`. **If this works, the backend is fully verified.**

### 6. Install desktop dependencies

```bash
cd desktop
echo 'VITE_API_BASE_URL=http://localhost:8081' > .env
npm install
```

---

## Running the app

### Native desktop window (recommended)

```bash
cd desktop
npm run tauri dev
```

First run takes **5–15 minutes** — Rust downloads ~300 crates and compiles them. Subsequent runs take seconds. When it finishes, a native window opens automatically.

Log in:
- **Username:** `admin`
- **Password:** `ChangeMe!2026` (or whatever you set in `BOOTSTRAP_ADMIN_PASSWORD` in `.env`)

### Browser preview (faster, slightly limited)

If you just want to see the UI:

```bash
cd desktop
npm run dev
```

Open `http://localhost:1420`. Login works; the catch is that token persistence across reloads uses Tauri's OS keychain which isn't available in a browser.

---

## What works (Phases 1–4)

| Feature | Status |
|---|---|
| Login with password | ✅ Phase 1 |
| MFA (TOTP) enrollment + verification | ✅ Phase 1 |
| Refresh-token rotation with reuse detection | ✅ Phase 1 |
| User CRUD (admin) | ✅ Phase 1 |
| Edit own profile | ✅ Phase 1 |
| Settings: theme, language | ✅ Phase 1 |
| Account lockout, rate limiting, audit logs | ✅ Phase 1 |
| **Host management (CRUD)** | ✅ Phase 2 |
| **Folder tree organization** | ✅ Phase 2 |
| **Tag management** | ✅ Phase 2 |
| **Credentials store** | ✅ Phase 2 |
| **Connection history view** | ✅ Phase 2 |
| **Favorites, search, filters** | ✅ Phase 2 |
| **SSH terminal (password + key + agent, TOFU, multi-tab)** | ✅ Phase 3 |
| **SFTP browser (browse, download, upload, rename, delete, mkdir, edit)** | ✅ Phase 4 |
| **SFTP chmod, recursive folder download, filter & sort** | ✅ Phase 4 (1.7.0) |
| **Self-service password change** | ✅ Phase 2.x (1.10.0) |
| **SSH tunnels / port forwarding (local `ssh -L` + WebSocket TCP tunnel)** | ✅ Phase 5 (1.21.0) |
| **VPN — OpenVPN client profiles (desktop or backend runtime, folder/asset association, auto-connect)** | ✅ Phase 12 (1.51.0) |
| **VPN Server — Awamer as an OpenVPN hub (self-signed PKI, per-user cert + username/password, downloadable .ovpn, start/stop)** | ✅ Phase 12 (1.52.0) |
| **VNC remote desktop** | ✅ Phase 6 (1.18.0) |
| RDP | ❌ Phase 6 (needs a Guacamole/guacd gateway) |
| Serial | ❌ Phase 7 |
| **Telnet (browser terminal)** | ✅ (1.27.0) |
| **Encrypted credential secrets at rest (AES-256-GCM)** | ✅ Phase 10 |
| **Credential vault: folders, favorites, expiry, custom fields, password generator** | ✅ Phase 11 (1.49.0) |
| **Credential vault: per-credential TOTP + encrypted file attachments** | ✅ Phase 11 (1.50.0) |
| Credential vault: sealed (zero-knowledge) mode + vault unlock, team sharing | ❌ Phase 11.x |
| Vault unlock / KMS-backed master key | ❌ Phase 10.x |

The dashboard tiles are placeholders; the working flows are **Hosts**,
**Credentials**, **Folders**, **Tags** (Phase 2) plus **Settings →
Security** (MFA), **Settings → Profile**, **Settings → Appearance**, and
**Users** (admin sidebar) from Phase 1.

---

## Troubleshooting

These are every problem the 1.0.0 release-candidate process hit. If you see one of these, jump to the section.

### `couldn't find env file: .../.env`

Docker Compose can't find the `.env` file. Causes and fixes:

- You're running the command from the wrong directory. Always run `make` and `docker compose` commands from the **repo root** (the directory containing `.env`), not from `desktop/` or `backend/`.
- `.env` truly doesn't exist. Run `cp .env.example .env`.
- The repo path contains spaces and you passed `$(CURDIR)` unquoted. The `Makefile` in 1.0.0 uses relative paths to avoid this, but if you write your own scripts, quote any absolute path.

### `address already in use` on port 5432

Another PostgreSQL is running on the host. Either:

```bash
sudo systemctl stop postgresql
```

or, in `.env`, set:

```
POSTGRES_HOST_PORT=5433
```

The container internally stays on 5432, so the rest of the stack is unaffected.

### `address already in use` on port 1420 (Vite)

A leftover Vite instance. Kill it:

```bash
sudo fuser -k 1420/tcp
```

### Login returns `invalid_credentials` and the latency is ~13ms

The Argon2 password verify takes ~300–500 ms when it actually runs. If you see ~13 ms latency on a 401, the user lookup is failing, not the password compare. Two known causes:

1. **Migrations never ran.** Confirm tables exist:
   ```bash
   docker compose --env-file .env -f deployments/docker-compose.yml exec postgres \
     psql -U netsphere -d netsphere -c '\dt'
   ```
   If you see `Did not find any relations` → run `make migrate-up-docker`.

2. **The bootstrap admin wasn't created.** After migrations ran, the auth-service must be restarted so it sees the empty `users` table and creates the admin:
   ```bash
   docker compose --env-file .env -f deployments/docker-compose.yml restart auth-service
   ```
   Then check the logs for `bootstrap admin created`.

### Frontend shows `NetworkError when attempting to fetch resource`

This is CORS or a missing Vite env var. Fix both:

```bash
echo 'VITE_API_BASE_URL=http://localhost:8081' > desktop/.env
docker compose --env-file .env -f deployments/docker-compose.yml restart auth-service
sudo fuser -k 1420/tcp 2>/dev/null
cd desktop && npm run dev
```

Vite bakes env vars in at build time, so it must be restarted after editing `desktop/.env`.

To diagnose CORS specifically:

```bash
curl -i -X OPTIONS http://localhost:8081/api/v1/auth/login \
  -H 'Origin: http://localhost:1420' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: Content-Type' 2>&1 | head -20
```

Look for `Access-Control-Allow-Origin: http://localhost:1420` in the response.

### `cargo metadata` fails / `failed to run cargo`

Rust isn't installed. Install:

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"
```

### `feature 'edition2024' is required`

Your Rust toolchain is too old. Update:

```bash
rustup update stable
rustc --version    # must be ≥ 1.85
```

### `make migrate-up-docker` fails with `dial tcp: lookup postgres ... server misbehaving`

Postgres isn't healthy yet. Wait 30 seconds after `make docker-up` and check:

```bash
docker compose --env-file .env -f deployments/docker-compose.yml ps
```

`netsphere-postgres` should say `healthy`. If not, check its logs.

### Stale data from a previous installation

The cleanest reset is to nuke volumes and start over:

```bash
cd ~/netsphere
docker compose --env-file .env -f deployments/docker-compose.yml down -v
docker volume ls -q | grep -E "netsphere|deployments" | xargs -r docker volume rm
make docker-up
make migrate-up-docker
docker compose --env-file .env -f deployments/docker-compose.yml restart auth-service
```

The `-v` flag deletes named volumes. Important: this destroys all data including users.

### Change the admin password

The bootstrap admin's password is only used to create the row on first startup. After that, change it via direct SQL:

```bash
# Compute a hash for your new password (requires `argon2` CLI: apt install argon2)
NEW_HASH=$(echo -n "MyNewPassword!" | argon2 "$(head -c 16 /dev/urandom | base64 | head -c 16)" -id -t 3 -m 16 -p 4 -l 32 -e)

docker compose --env-file .env -f deployments/docker-compose.yml exec -T postgres \
  psql -U netsphere -d netsphere -c "UPDATE users SET password_hash = '$NEW_HASH' WHERE username='admin';"
```

Self-service password change via the UI arrives in Phase 2.

---

## Architecture overview

```
┌──────────────────────────┐         ┌──────────────────────────┐
│  Tauri Desktop App       │  HTTPS  │  auth-service (Node.js)  │
│  React + TS + Tailwind   │ ──────► │  Fastify + JWT + Argon2  │
└──────────────────────────┘         └──────────┬───────────────┘
                                                │
                                     ┌──────────▼──────────────┐
                                     │   PostgreSQL 16          │
                                     └──────────────────────────┘
                                                ▲
                                                │
                                     ┌──────────┴──────────────┐
                                     │   Redis 7 (rate limits)  │
                                     └──────────────────────────┘
```

### Backend stack

- **Fastify 4** — HTTP server
- **pg** (node-postgres) — direct SQL
- **argon2** — password hashing (native libargon2 binding)
- **jose** — JWT signing & verification
- **zod** — request validation
- **pino** — structured logging

### Why these choices

- **No ORM.** Plain SQL with parameterized queries — keeps the data model transparent and lets you reason about query plans.
- **Argon2id with PHC encoding.** Hashes are byte-compatible with the reference C implementation, Go's `golang.org/x/crypto/argon2`, and Python's `argon2-cffi`.
- **Refresh-token rotation** with chain revocation on reuse. Detects token theft and locks out the entire family.
- **Bootstrap admin via env vars** — eliminates SQL-escaping bugs around baked-in password hashes (the bug that killed early 1.0.0 iterations).

---

## Project layout

```
netsphere-1.0.0/
├── README.md                       this file
├── RELEASE_NOTES.md                full 1.0.0 fix history
├── CHANGELOG.md                    machine-friendly version log
├── Makefile                        make targets
├── .env.example                    env template
├── backend/                        Node.js / TypeScript auth service
│   ├── package.json
│   ├── tsconfig.json
│   ├── Dockerfile
│   ├── migrations/                 SQL migrations 001-004 + extensions
│   └── src/
│       ├── server.ts               Fastify entry; bootstraps admin
│       ├── migrate.ts              standalone migration runner
│       ├── config/                 zod-validated env loader
│       ├── logger/                 pino
│       ├── db/                     pg pool
│       ├── crypto/argon2.ts        password hashing wrapper
│       ├── jwt/                    JOSE-based JWT (access + refresh)
│       ├── domain/                 types + errors
│       ├── repos/                  user, mfa, refresh, audit
│       ├── usecases/               login, refresh, mfa, register
│       ├── routes/                 auth, users, admin
│       └── middleware/auth.ts      bearer-token guard
├── deployments/
│   └── docker-compose.yml          postgres + redis + auth-service
└── desktop/                        Tauri + React + TypeScript app
    ├── package.json
    ├── src-tauri/                  Rust core (keyring, IPC commands)
    └── src/
        ├── main.tsx
        ├── App.tsx
        ├── modules/auth/           login, MFA, register
        ├── modules/dashboard/      dashboard shell
        ├── modules/settings/       theme, profile, security
        ├── modules/users/          admin user mgmt
        └── shared/                 api client, stores, components
```
