#!/usr/bin/env bash
# =====================================================================
# NetSphere Terminal — Production install on Ubuntu (22.04+ / 24.04)
# =====================================================================
#
# This is an INTERACTIVE installer. Run as a user with sudo rights:
#
#   chmod +x deploy/scripts/install.sh
#   ./deploy/scripts/install.sh
#
# It will:
#   1. Install Docker + Docker Compose plugin (if not present)
#   2. Install nginx + certbot (if not present)
#   3. Generate secrets if .env.production doesn't exist
#   4. Build and start the backend stack
#   5. Configure nginx with your domain
#   6. Issue a Let's Encrypt certificate
#   7. Verify everything works
#
# Idempotent: safe to re-run. Skips steps that are already done.
# =====================================================================

set -euo pipefail

# ----- Pretty output -------------------------------------------------
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BOLD='\033[1m'; NC='\033[0m'
say() { echo -e "${BOLD}==>${NC} $*"; }
ok()  { echo -e "${GREEN}✓${NC} $*"; }
warn(){ echo -e "${YELLOW}!${NC} $*"; }
err() { echo -e "${RED}✗${NC} $*" >&2; exit 1; }

# ----- Detect repo root ---------------------------------------------
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

if [[ ! -f deploy/docker-compose.production.yml ]]; then
    err "Could not find deploy/docker-compose.production.yml — are you in the project root?"
fi

# ----- Step 1: prerequisites ----------------------------------------
say "Step 1/7: Installing prerequisites"

if ! command -v docker >/dev/null 2>&1; then
    say "  Installing Docker"
    curl -fsSL https://get.docker.com | sudo sh
    sudo usermod -aG docker "$USER"
    warn "Added you to the docker group. You may need to log out and back in for this to take effect."
fi

if ! sudo docker compose version >/dev/null 2>&1; then
    err "Docker Compose plugin not available. Re-run after Docker is installed."
fi

if ! command -v nginx >/dev/null 2>&1; then
    say "  Installing nginx"
    sudo apt-get update -qq
    sudo apt-get install -y nginx
fi

if ! command -v certbot >/dev/null 2>&1; then
    say "  Installing certbot (for Let's Encrypt)"
    sudo apt-get install -y certbot python3-certbot-nginx
fi

ok "Prerequisites ready"

# ----- Step 2: secrets ----------------------------------------------
say "Step 2/7: Configuring secrets"

if [[ ! -f .env.production ]]; then
    say "  Generating .env.production"
    bash deploy/scripts/generate-secrets.sh > .env.production
    chmod 600 .env.production
    ok "Generated .env.production (mode 600)"
    warn "BACK THIS FILE UP TO A SAFE PLACE — losing it means losing all sessions and MFA secrets!"

    # Auto-fill BOOTSTRAP_ADMIN credentials in a confirmation prompt
    echo
    grep "BOOTSTRAP_ADMIN" .env.production
    echo
    echo "Press Enter to continue with the generated admin credentials, or"
    echo "Ctrl-C to abort and edit them in .env.production first."
    read -r
else
    warn "Existing .env.production found, NOT regenerating"
fi

# Validate required vars
MISSING=()
for v in POSTGRES_PASSWORD REDIS_PASSWORD JWT_ACCESS_SECRET JWT_REFRESH_SECRET CREDENTIAL_ENCRYPTION_KEY BOOTSTRAP_ADMIN_PASSWORD; do
    if ! grep -q "^${v}=." .env.production || grep -q "^${v}=CHANGE_ME" .env.production; then
        MISSING+=("$v")
    fi
done
if [[ ${#MISSING[@]} -gt 0 ]]; then
    err "Missing or placeholder values for: ${MISSING[*]}"
fi

ok "Secrets validated"

# ----- Step 3: build + start ----------------------------------------
say "Step 3/7: Building and starting backend stack"

sudo docker compose -f deploy/docker-compose.production.yml --env-file .env.production build
sudo docker compose -f deploy/docker-compose.production.yml --env-file .env.production up -d

ok "Backend stack started"

# ----- Step 4: readiness check --------------------------------------
# AWM-STAB-002: gate rollout on READINESS (process + PostgreSQL), not just
# liveness. /readyz is 200 only when the DB is reachable.
say "Step 4/7: Waiting for backend to become ready (/readyz)"

for i in {1..30}; do
    if curl -sf http://127.0.0.1:8081/readyz >/dev/null 2>&1; then
        ok "Backend is ready after ${i}s"
        break
    fi
    sleep 1
    [[ $i -eq 30 ]] && err "Backend did not become READY within 30 seconds (/readyz not 200 — check DB connectivity). Check logs: docker compose -f deploy/docker-compose.production.yml logs auth-service"
done

# ----- Step 5: domain prompt ----------------------------------------
say "Step 5/7: Configuring nginx + TLS"

if [[ -z "${NETSPHERE_DOMAIN:-}" ]]; then
    echo
    read -rp "Enter your domain name (e.g. netsphere.example.com), or 'skip' to skip nginx setup: " NETSPHERE_DOMAIN
fi

if [[ "$NETSPHERE_DOMAIN" == "skip" ]]; then
    warn "Skipping nginx setup. Backend listens on 127.0.0.1:8081"
else
    NGINX_CONF=/etc/nginx/sites-available/netsphere
    sudo cp deploy/nginx/netsphere.conf "$NGINX_CONF"
    sudo sed -i "s/netsphere\\.example\\.com/${NETSPHERE_DOMAIN}/g" "$NGINX_CONF"
    sudo ln -sf "$NGINX_CONF" /etc/nginx/sites-enabled/netsphere
    # Remove default site if it's interfering
    sudo rm -f /etc/nginx/sites-enabled/default

    if sudo nginx -t 2>&1 | grep -q "successful"; then
        sudo systemctl reload nginx
        ok "nginx reloaded with config for $NETSPHERE_DOMAIN"
    else
        err "nginx config test failed. Check: sudo nginx -t"
    fi

    # ----- Step 6: TLS via Let's Encrypt -----------------------------
    say "Step 6/7: Issuing TLS certificate via Let's Encrypt"
    echo
    echo "certbot will now ask you a few questions and issue a certificate."
    echo "Make sure your DNS A record for $NETSPHERE_DOMAIN points to this server!"
    read -rp "Continue with certbot? [Y/n]: " ANS
    if [[ "$ANS" != "n" && "$ANS" != "N" ]]; then
        sudo certbot --nginx -d "$NETSPHERE_DOMAIN" --redirect --agree-tos --no-eff-email \
            -m "admin@${NETSPHERE_DOMAIN#*.}"
        ok "TLS certificate installed; nginx reloaded"
    else
        warn "Skipped certbot. Run later: sudo certbot --nginx -d $NETSPHERE_DOMAIN"
    fi
fi

# ----- Step 7: summary ----------------------------------------------
say "Step 7/7: Summary"

cat <<EOF

${GREEN}═══════════════════════════════════════════════════════════════${NC}
${GREEN}  NetSphere Terminal installation complete.${NC}
${GREEN}═══════════════════════════════════════════════════════════════${NC}

  Backend container:  netsphere-auth (port 8081, bound to 127.0.0.1)
  Postgres container: netsphere-postgres (volume: netsphere-postgres-data)
  Redis container:    netsphere-redis (volume: netsphere-redis-data)
EOF

if [[ "${NETSPHERE_DOMAIN:-}" != "skip" && -n "${NETSPHERE_DOMAIN:-}" ]]; then
    cat <<EOF
  Public URL:         https://${NETSPHERE_DOMAIN}
  Health check:       https://${NETSPHERE_DOMAIN}/healthz

  Desktop clients should be configured with:
    VITE_API_BASE_URL=https://${NETSPHERE_DOMAIN}
EOF
fi

cat <<EOF

  Bootstrap admin credentials (in .env.production):
$(grep BOOTSTRAP_ADMIN .env.production | sed 's/^/    /')

  ${YELLOW}IMPORTANT:${NC}
    1. Sign in via a desktop client and CHANGE the bootstrap password.
    2. Back up .env.production to a secure password manager.
    3. Set up automated database backups (see deploy/scripts/backup.sh).
    4. Configure firewall: allow only 22 (SSH), 80, 443.

  Useful commands:
    Tail logs:          sudo docker compose -f deploy/docker-compose.production.yml logs -f auth-service
    Restart backend:    sudo docker compose -f deploy/docker-compose.production.yml --env-file .env.production restart auth-service
    Stop everything:    sudo docker compose -f deploy/docker-compose.production.yml down
    Database backup:    ./deploy/scripts/backup.sh
    Database shell:     sudo docker compose -f deploy/docker-compose.production.yml exec postgres psql -U netsphere
EOF
