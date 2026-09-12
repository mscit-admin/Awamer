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
# DEPLOY-001: report the nginx version. The shipped config uses the
# `listen … ssl http2` syntax, which is compatible with the distro nginx on
# Ubuntu 22.04/24.04 (no third-party nginx repo required).
say "  nginx version: $(nginx -v 2>&1 | sed 's/^nginx version: //')"

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
    # DEPLOY-009: sanity-check the domain before involving Let's Encrypt.
    if [[ ! "$NETSPHERE_DOMAIN" =~ ^([A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}$ ]]; then
        err "'$NETSPHERE_DOMAIN' does not look like a valid fully-qualified domain name."
    fi

    NGINX_CONF=/etc/nginx/sites-available/netsphere      # final HTTPS config
    BOOTSTRAP_CONF=/etc/nginx/sites-available/netsphere-bootstrap
    WEBROOT=/var/www/certbot
    LE_LIVE="/etc/letsencrypt/live/${NETSPHERE_DOMAIN}"
    LE_EMAIL="${LE_EMAIL:-admin@${NETSPHERE_DOMAIN#*.}}"
    sudo mkdir -p "$WEBROOT"

    # Prepare the FINAL HTTPS config (domain substituted) but do NOT enable it
    # yet — it references cert files that may not exist on a fresh host.
    sudo cp deploy/nginx/netsphere.conf "$NGINX_CONF"
    sudo sed -i "s/netsphere\\.example\\.com/${NETSPHERE_DOMAIN}/g" "$NGINX_CONF"
    sudo rm -f /etc/nginx/sites-enabled/default

    # enable_final(): point sites-enabled at the HTTPS config, validate, reload.
    # NEVER reloads on a failed `nginx -t` (keeps the running config intact).
    enable_final() {
        sudo ln -sf "$NGINX_CONF" /etc/nginx/sites-enabled/netsphere
        sudo rm -f /etc/nginx/sites-enabled/netsphere-bootstrap
        if sudo nginx -t; then
            sudo systemctl reload nginx
            ok "HTTPS nginx config active for $NETSPHERE_DOMAIN"
        else
            # Roll back to whatever was serving before (bootstrap, if present).
            sudo rm -f /etc/nginx/sites-enabled/netsphere
            [[ -f "$BOOTSTRAP_CONF" ]] && sudo ln -sf "$BOOTSTRAP_CONF" /etc/nginx/sites-enabled/netsphere-bootstrap
            sudo nginx -t >/dev/null 2>&1 && sudo systemctl reload nginx || true
            err "Final nginx config failed 'nginx -t' — HTTPS NOT activated. Check: sudo nginx -t"
        fi
    }

    # ----- Step 6: TLS via Let's Encrypt -----------------------------
    say "Step 6/7: TLS certificate (Let's Encrypt)"

    if sudo test -f "${LE_LIVE}/fullchain.pem" && sudo test -f "${LE_LIVE}/privkey.pem"; then
        # DEPLOY-005/§15: a certificate already exists — do NOT reissue it.
        ok "Existing certificate found for $NETSPHERE_DOMAIN — skipping issuance"
        enable_final
    else
        # DEPLOY-002/§4: fresh host with no certificate. Serve an HTTP-only
        # bootstrap vhost first (ACME webroot on :80), obtain the cert, then
        # enable the final HTTPS config. The HTTPS config is NEVER activated
        # before its certificate exists.
        say "  No certificate yet — installing a temporary HTTP-only bootstrap vhost"
        sudo tee "$BOOTSTRAP_CONF" >/dev/null <<BOOT
server {
    listen 80;
    listen [::]:80;
    server_name ${NETSPHERE_DOMAIN};
    # ACME HTTP-01 challenge (Let's Encrypt writes tokens here).
    location /.well-known/acme-challenge/ { root ${WEBROOT}; }
    # Nothing else is exposed during bootstrap.
    location / { return 404; }
}
BOOT
        sudo ln -sf "$BOOTSTRAP_CONF" /etc/nginx/sites-enabled/netsphere-bootstrap
        sudo rm -f /etc/nginx/sites-enabled/netsphere
        if ! sudo nginx -t; then
            err "Bootstrap nginx config failed 'nginx -t'. Check: sudo nginx -t"
        fi
        sudo systemctl reload nginx
        ok "Bootstrap HTTP vhost live on port 80 (ACME webroot: $WEBROOT)"

        echo
        echo "Let's Encrypt needs TCP 80 reachable and DNS for '$NETSPHERE_DOMAIN'"
        echo "to resolve to THIS server before issuing a certificate."
        read -rp "Continue with certbot certificate issuance? [Y/n]: " ANS
        if [[ "$ANS" == "n" || "$ANS" == "N" ]]; then
            warn "Skipped certbot. HTTP bootstrap vhost left in place."
            warn "Issue later, then enable HTTPS:"
            warn "  sudo certbot certonly --webroot -w $WEBROOT -d $NETSPHERE_DOMAIN --agree-tos --no-eff-email -m $LE_EMAIL"
            warn "  sudo ln -sf $NGINX_CONF /etc/nginx/sites-enabled/netsphere && sudo rm -f /etc/nginx/sites-enabled/netsphere-bootstrap && sudo nginx -t && sudo systemctl reload nginx"
        else
            # DEPLOY-008/§8/§16: on certbot failure, exit non-zero and DO NOT
            # activate the (cert-less) HTTPS config — the bootstrap vhost stays.
            if ! sudo certbot certonly --webroot -w "$WEBROOT" -d "$NETSPHERE_DOMAIN" \
                    --agree-tos --no-eff-email --non-interactive -m "$LE_EMAIL"; then
                err "Certificate issuance FAILED. HTTPS config NOT activated (bootstrap vhost still serving). Verify DNS + inbound TCP 80, then re-run."
            fi
            ok "Certificate issued for $NETSPHERE_DOMAIN"
            enable_final
        fi
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
