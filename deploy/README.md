# Awamer Terminal — Production Deployment Guide

This directory contains everything needed to deploy Awamer's
**backend server** on a production Ubuntu host.

## What gets deployed

Awamer has two parts:

| Component | Where it runs | What this guide covers |
|---|---|---|
| **Backend** (Node.js/Fastify + Postgres + Redis) | Your server | ✅ Yes |
| **Desktop client** (Tauri + React) | Each user's laptop | ❌ No — see [Desktop distribution](#desktop-distribution) |

The backend is a stateful HTTPS API. Each user installs the desktop
client on their own machine and points it at your server's URL.

## Prerequisites

- **Ubuntu 22.04 or 24.04** LTS server (works on Debian 12 too)
- **A domain name** pointing to your server's IP (A record)
- **Open ports**: 22 (SSH), 80, 443 (HTTPS)
- **≥ 1 GB RAM**, **≥ 10 GB disk** (Postgres grows with audit logs)
- **A user with sudo rights** (do not run as root)
- **Working DNS resolution** to your domain before running certbot

## One-command install

```bash
# Clone or copy the project to /opt/netsphere (or wherever you prefer)
sudo mkdir -p /opt/netsphere
sudo chown $USER /opt/netsphere
cd /opt/netsphere

# Extract the source tarball into this directory
tar xzf ~/netsphere-1.6.0.1.tar.gz --strip-components=1

# Run the installer
chmod +x deploy/scripts/install.sh
./deploy/scripts/install.sh
```

The installer is interactive and handles everything: Docker setup,
secret generation, container build, nginx config, Let's Encrypt
certificate. It's also idempotent — safe to re-run if you need to
fix something.

## Manual install (if you prefer step-by-step)

If you want to understand each step or customize them:

### 1. Install Docker + Compose

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
# Log out and back in for the group change to take effect
```

### 2. Generate secrets

```bash
cd /opt/netsphere
./deploy/scripts/generate-secrets.sh > .env.production
chmod 600 .env.production
```

**Critical: back up `.env.production` to a secure password manager
or encrypted backup before proceeding.** Losing
`CREDENTIAL_ENCRYPTION_KEY` means every stored credential secret
becomes undecryptable — your users would have to re-enter all their
saved passwords and keys.

### 3. Edit `.env.production`

Review the generated file. Things you may want to change:

- `CORS_ALLOWED_ORIGINS` — set to your real domain (and
  `tauri://localhost` for desktop clients in dev mode)
- `LOG_LEVEL` — `info` is default; `debug` for troubleshooting
- `BOOTSTRAP_ADMIN_PASSWORD` — change it; you'll use this for first
  login then create real accounts

### 4. Build and start

```bash
sudo docker compose -f deploy/docker-compose.production.yml --env-file .env.production build
sudo docker compose -f deploy/docker-compose.production.yml --env-file .env.production up -d
```

Wait ~30 seconds for the migrations to run. Verify:

```bash
curl http://127.0.0.1:8081/healthz
# Expected: {"status":"ok"}
```

### 5. Configure nginx

```bash
sudo apt install nginx certbot python3-certbot-nginx
sudo cp deploy/nginx/netsphere.conf /etc/nginx/sites-available/netsphere
sudo sed -i "s/netsphere\\.example\\.com/YOUR-DOMAIN.com/g" /etc/nginx/sites-available/netsphere
sudo ln -sf /etc/nginx/sites-available/netsphere /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

### 6. Issue TLS certificate

```bash
sudo certbot --nginx -d YOUR-DOMAIN.com --redirect --agree-tos -m you@YOUR-DOMAIN.com
```

certbot edits the nginx file in place to point to the issued cert,
then reloads nginx. Verify from the public internet:

```bash
curl https://YOUR-DOMAIN.com/healthz
# Expected: {"status":"ok"}
```

### 7. Enable auto-start on boot (optional but recommended)

```bash
sudo cp deploy/systemd/netsphere.service /etc/systemd/system/
sudo sed -i "s|/opt/netsphere|$(pwd)|" /etc/systemd/system/netsphere.service
sudo systemctl daemon-reload
sudo systemctl enable --now netsphere.service
```

## Day-2 operations

### View logs

```bash
sudo docker compose -f deploy/docker-compose.production.yml --env-file .env.production logs -f auth-service
sudo tail -f /var/log/nginx/netsphere-access.log
```

### Database backup

```bash
./deploy/scripts/backup.sh
# Creates ./backups/netsphere-<timestamp>.sql.gz
```

Add to crontab for daily 3 AM backups:

```bash
sudo crontab -e
# Add this line:
0 3 * * * cd /opt/netsphere && ./deploy/scripts/backup.sh >> /var/log/netsphere-backup.log 2>&1
```

### Database restore

```bash
./deploy/scripts/restore.sh backups/netsphere-20260512-030000.sql.gz
# Destructive — asks for confirmation. Wipes and replaces the database.
```

### Update to a new version

```bash
cd /opt/netsphere

# Back up first!
./deploy/scripts/backup.sh

# Stop the stack
sudo docker compose -f deploy/docker-compose.production.yml --env-file .env.production down

# Replace the source (NOT .env.production!)
tar xzf ~/netsphere-1.7.0.tar.gz --strip-components=1 --no-overwrite-dir

# Rebuild and start — migrations run automatically
sudo docker compose -f deploy/docker-compose.production.yml --env-file .env.production build
sudo docker compose -f deploy/docker-compose.production.yml --env-file .env.production up -d

# Tail logs to confirm successful startup
sudo docker compose -f deploy/docker-compose.production.yml --env-file .env.production logs -f auth-service
```

### Rotate JWT secrets

If you suspect token leakage, rotate `JWT_ACCESS_SECRET` and
`JWT_REFRESH_SECRET` in `.env.production`. **This logs out all
users immediately.** They must sign in again.

```bash
# Edit .env.production with new openssl rand -hex 64 values, then:
sudo docker compose -f deploy/docker-compose.production.yml --env-file .env.production restart auth-service
```

Do **NOT** rotate `CREDENTIAL_ENCRYPTION_KEY` — doing so makes every
stored credential secret undecryptable, forcing users to re-enter all
their saved passwords/keys. Only rotate it if you suspect that specific
key was compromised, and re-save every credential afterward.

### HTTPS port (operator-selectable — DEPLOY-PORT-001)

The public HTTPS port is chosen at install time. **The default is `443`.** The
installer prompts:

```
Enter public HTTPS port [443]:
```

For unattended/automation runs, set it non-interactively:

```bash
AWAMER_HTTPS_PORT=6655 NETSPHERE_DOMAIN=your.domain ./deploy/scripts/install.sh
```

Resolution priority: **1)** `AWAMER_HTTPS_PORT` → **2)** interactive prompt →
**3)** the previously persisted port → **4)** `443`. The selected port is the
single source of truth: it drives the nginx `listen`/redirect directives, the
public URL, `VITE_API_BASE_URL`, firewall guidance, and the evidence report.
It is persisted (non-secret) to **`/etc/awamer/deployment.conf`**
(`AWAMER_DOMAIN`, `AWAMER_HTTPS_PORT`) and preserved by `update.sh`.

> **ACME uses port 80, always.** Let's Encrypt HTTP-01 validation happens on
> TCP 80 regardless of the HTTPS port — keep 80 open even when HTTPS is 6655/8443.

### Firewall

Open exactly the SSH port, **80** (ACME + HTTP→HTTPS redirect), and your
**selected HTTPS port**. Example for the default (443):

```bash
sudo apt install ufw
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp      # SSH
sudo ufw allow 80/tcp      # HTTP: ACME HTTP-01 + redirect to HTTPS
sudo ufw allow 443/tcp     # Awamer HTTPS (use YOUR selected port, e.g. 6655)
sudo ufw enable
sudo ufw status
```

If you chose a custom port, substitute it (e.g. `sudo ufw allow 6655/tcp`) —
do **not** open 443 unless Awamer actually listens there. The installer prints
the exact per-port firewall list for your chosen port at the end of the run.

Port 8081 should NOT be in the firewall rules — Docker binds it
to 127.0.0.1 only, and nginx reverse-proxies from the selected HTTPS port.

### Resource limits

Add to the auth-service definition in compose if you need them:

```yaml
    deploy:
      resources:
        limits:
          cpus: '1.0'
          memory: 512M
```

## Desktop distribution

The desktop client is a Tauri app that must be installed on each
user's machine. There are three ways to distribute it:

### Option A — Source build (developers)

Users clone the repo and run:

```bash
cd desktop
npm install
npm run tauri build
```

This produces installer files in `desktop/src-tauri/target/release/bundle/`:
- `.deb` for Debian/Ubuntu
- `.AppImage` for any Linux
- `.dmg` for macOS (only if building on macOS)
- `.msi` for Windows (only if building on Windows)

### Option B — Pre-built `.deb` (recommended for Linux users)

Build once on a CI machine or your laptop:

```bash
cd desktop
VITE_API_BASE_URL=https://YOUR-DOMAIN.com npm install
VITE_API_BASE_URL=https://YOUR-DOMAIN.com npm run tauri build
```

The resulting `.deb` is in
`desktop/src-tauri/target/release/bundle/deb/netsphere-terminal_1.6.0.1_amd64.deb`.

Distribute it via your file server / internal app store / email to
team members. Users install with:

```bash
sudo apt install ./netsphere-terminal_1.6.0.1_amd64.deb
```

### Option C — Self-hosted update server (future)

Tauri supports an updater API that auto-installs new versions.
This requires hosting an `updates.json` manifest with signed
releases. Out of scope for 1.6.0.1; consider for 2.0.

**Critical:** `VITE_API_BASE_URL` is baked into the build at
compile time. You must set it before running `npm run tauri build`,
or the client will try to connect to `http://localhost:8081` (the
dev default).

## Security checklist

Before going live:

- [ ] `.env.production` has unique secrets (not the example placeholders)
- [ ] `.env.production` permissions are `600` and owned by deploying user
- [ ] `.env.production` is backed up to a secure password manager
- [ ] TLS certificate active (`curl -I https://YOUR-DOMAIN.com/healthz` shows HSTS)
- [ ] Bootstrap admin password changed via the desktop UI (the installer never
      prints or logs it — it lives only in `.env.production`, mode 600)
- [ ] Firewall (`ufw`) allows only 22, 80, and your selected HTTPS port
      (default 443; e.g. 6655 if you chose it)
- [ ] Installer finished with **Status: SUCCESS** (a **PARTIAL** result means
      TLS was skipped and the production HTTPS endpoint is not active — not ready)
- [ ] SSH key-based auth on the server (no root login, no password login)
- [ ] Automated daily backups running (check `/var/log/netsphere-backup.log`)
- [ ] Log rotation configured (`/etc/logrotate.d/nginx` should already cover
      nginx; Docker logs rotate automatically)
- [ ] HTTPS-only — try `curl -v http://YOUR-DOMAIN.com/` → should redirect to https

## Troubleshooting

### Backend won't start

```bash
sudo docker compose -f deploy/docker-compose.production.yml --env-file .env.production logs auth-service | tail -50
```

Common causes:
- **`POSTGRES_PASSWORD missing`** — you didn't set the .env file
- **Migration error** — Postgres schema is in a bad state, possibly from
  a botched upgrade. Restore from backup then re-attempt the upgrade.
- **JWT_ACCESS_SECRET wrong length** — must be ≥ 32 chars
- **CREDENTIAL_ENCRYPTION_KEY wrong length** — must decode to exactly 32 bytes (base64 or hex)

### "502 Bad Gateway" from nginx

The backend isn't running or isn't responding on 127.0.0.1:8081.

```bash
curl http://127.0.0.1:8081/healthz
# If this fails, the backend is down. Check docker compose logs.

sudo docker compose -f deploy/docker-compose.production.yml --env-file .env.production ps
# Status should show "healthy" for all three.
```

### "CORS error" in the desktop client

The desktop client's origin (typically `tauri://localhost` for the
production app) must be in `CORS_ALLOWED_ORIGINS`. Edit `.env.production`
and restart:

```bash
sudo docker compose -f deploy/docker-compose.production.yml --env-file .env.production restart auth-service
```

### Lost access to the admin account

Use a SQL workaround (same as we used in early phases). From the
project root:

```bash
# Reset admin password to "NewPassword123!" (or whatever you choose)
sudo docker compose -f deploy/docker-compose.production.yml --env-file .env.production exec auth-service \
    node -e "const a = require('argon2'); a.hash('NewPassword123!').then(h => console.log(h))"
```

Take the printed hash, then:

```bash
sudo docker compose -f deploy/docker-compose.production.yml --env-file .env.production exec postgres \
    psql -U netsphere -d netsphere \
    -c "UPDATE users SET password_hash='<paste-hash-here>', failed_attempts=0, is_locked=FALSE WHERE username='admin';"
```

If MFA is blocking you too:

```bash
sudo docker compose -f deploy/docker-compose.production.yml --env-file .env.production exec postgres \
    psql -U netsphere -d netsphere \
    -c "UPDATE users SET mfa_enabled=FALSE WHERE username='admin'; DELETE FROM mfa_devices WHERE user_id=(SELECT id FROM users WHERE username='admin');"
```

### Where do logs live

| Source | Location |
|---|---|
| Backend application logs | `docker compose logs auth-service` |
| Postgres logs | `docker compose logs postgres` |
| nginx access logs | `/var/log/nginx/netsphere-access.log` |
| nginx error logs | `/var/log/nginx/netsphere-error.log` |
| Backup script | `/var/log/netsphere-backup.log` |

## File layout

```
/opt/netsphere/
├── .env.production              # secrets (mode 600, BACKED UP)
├── backend/                     # Node.js source + Dockerfile
├── desktop/                     # Tauri client source (built separately)
├── deploy/
│   ├── docker-compose.production.yml
│   ├── .env.production.example
│   ├── nginx/
│   │   └── netsphere.conf
│   ├── scripts/
│   │   ├── install.sh           # one-shot installer
│   │   ├── generate-secrets.sh
│   │   ├── backup.sh
│   │   └── restore.sh
│   ├── systemd/
│   │   └── netsphere.service
│   └── README.md                # this file
└── backups/                     # backup output (gitignored)
```
