#!/usr/bin/env bash
# =====================================================================
# NetSphere Terminal — Update / redeploy
# =====================================================================
#
# Pulls the latest code and redeploys. It rebuilds the FRONTEND every
# time and only rebuilds the BACKEND container when backend code actually
# changed in the pulled commits — so frontend-only updates are fast.
#
# Run from the project root on the server:
#   ./deploy/scripts/update.sh
#
# Override any default via env vars, e.g.:
#   API_BASE_URL=https://my.domain:6655 BRANCH=main ./deploy/scripts/update.sh
#
# Defaults below match this deployment. Adjust if your server differs.
# =====================================================================

set -euo pipefail

# --- Config (override via environment) -------------------------------
BRANCH="${BRANCH:-main}"
WEB_ROOT="${WEB_ROOT:-/var/www/awamer}"
COMPOSE_FILE="${COMPOSE_FILE:-deploy/docker-compose.production.yml}"
ENV_FILE="${ENV_FILE:-.env.production}"
# VPN-server listener port(s) to open on the host firewall (VPN Server feature).
# Set VPN_PORTS="" to skip, or e.g. "1194/udp 1195/udp" for extra servers.
VPN_PORTS="${VPN_PORTS:-1194/udp 1194/tcp}"
# Non-secret deployment config that install.sh persists (domain + HTTPS port).
DEPLOYMENT_CONF="${AWAMER_DEPLOYMENT_CONF:-/etc/awamer/deployment.conf}"
# ---------------------------------------------------------------------

# Resolve project root (this script lives in deploy/scripts/).
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

# shellcheck source=lib/evidence.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/evidence.sh"

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
err() { printf '\033[0;31m==> ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

# --- SEC-INFRA-DEPLOY-001: ensure VPN_HELPER_SECRET exists (legacy upgrade) ---
# Installations whose .env.production predates the VPN helper have no
# VPN_HELPER_SECRET, so compose would refuse to start. Generate one ONCE and
# append it (mode 600). NEVER rotate an existing value (that would break IPC
# auth on a running deployment), and NEVER print the value.
ensure_vpn_helper_secret() {
  [[ -f "$ENV_FILE" ]] || return 0
  if grep -q '^VPN_HELPER_SECRET=.' "$ENV_FILE"; then
    say "VPN_HELPER_SECRET already present — preserving it unchanged."
    return 0
  fi
  command -v openssl >/dev/null 2>&1 || err "VPN_HELPER_SECRET is missing from $ENV_FILE and openssl is unavailable to generate it."
  printf 'VPN_HELPER_SECRET=%s\n' "$(openssl rand -hex 32)" >> "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  say "Added a generated VPN_HELPER_SECRET to $ENV_FILE (value not shown)."
}
ensure_vpn_helper_secret

# --- DEPLOY-PORT-001: preserve the HTTPS port across updates (§25/§50) ---
# The persisted deployment config is the source of truth for domain + port.
CUR_DOMAIN=""; CUR_PORT=""
if [[ -r "$DEPLOYMENT_CONF" ]]; then
  # shellcheck disable=SC1090
  CUR_DOMAIN="$(sh -c ". '$DEPLOYMENT_CONF' 2>/dev/null; printf %s \"\${AWAMER_DOMAIN:-}\"")"
  CUR_PORT="$(sh -c ". '$DEPLOYMENT_CONF' 2>/dev/null; printf %s \"\${AWAMER_HTTPS_PORT:-}\"")"
fi

# Resolve the effective HTTPS port. An operator may intentionally change it via
# AWAMER_HTTPS_PORT, but a change MUST be explicitly confirmed (§27/§51).
HTTPS_PORT=""
PORT_CHANGE_REQUESTED=0
if [[ -n "${AWAMER_HTTPS_PORT:-}" ]]; then
  validate_https_port "$AWAMER_HTTPS_PORT" || err "Invalid AWAMER_HTTPS_PORT '$AWAMER_HTTPS_PORT' (must be 1..65535)."
  if [[ -n "$CUR_PORT" && "$AWAMER_HTTPS_PORT" != "$CUR_PORT" ]]; then
    PORT_CHANGE_REQUESTED=1
    say "Current HTTPS port: $CUR_PORT"
    say "Requested HTTPS port: $AWAMER_HTTPS_PORT"
    if [[ "${AWAMER_CONFIRM_PORT_CHANGE:-}" == "1" ]]; then
      say "Port change confirmed via AWAMER_CONFIRM_PORT_CHANGE=1."
    elif [[ -t 0 ]]; then
      read -rp "Change production HTTPS port ${CUR_PORT} -> ${AWAMER_HTTPS_PORT}? [y/N] " _ans
      [[ "$_ans" == "y" || "$_ans" == "Y" ]] || err "Port change not confirmed — aborting (port preserved: $CUR_PORT)."
    else
      err "Refusing to change HTTPS port non-interactively. Set AWAMER_CONFIRM_PORT_CHANGE=1 to confirm."
    fi
  fi
  HTTPS_PORT="$AWAMER_HTTPS_PORT"
elif [[ -n "$CUR_PORT" ]]; then
  HTTPS_PORT="$CUR_PORT"          # preserve the persisted port (§50)
else
  # Never guess (§25): require the operator to establish the port explicitly.
  err "Cannot determine the HTTPS port: no $DEPLOYMENT_CONF and no AWAMER_HTTPS_PORT set. Run install.sh (which persists it) or set AWAMER_HTTPS_PORT."
fi

# Domain: persisted value, or AWAMER_DOMAIN override.
DOMAIN="${AWAMER_DOMAIN:-$CUR_DOMAIN}"

# API base URL: derive from domain+port unless the operator overrides it.
if [[ -n "${API_BASE_URL:-}" ]]; then
  :                                # explicit override respected
elif [[ -n "$DOMAIN" ]]; then
  API_BASE_URL="$(build_public_https_url "$DOMAIN" "$HTTPS_PORT")"
else
  err "Cannot determine API base URL: set AWAMER_DOMAIN (or API_BASE_URL), or run install.sh first."
fi

# Pick docker compose flavour.
if docker compose version >/dev/null 2>&1; then DC=(docker compose); else DC=(docker-compose); fi

say "Project root: $ROOT"
say "Branch: $BRANCH   API base: $API_BASE_URL   Web root: $WEB_ROOT"

# 1) Record the current commit, then pull the latest code.
BEFORE="$(git rev-parse HEAD 2>/dev/null || echo none)"
say "Fetching latest…"
git fetch origin "$BRANCH"
git checkout "$BRANCH"
git pull origin "$BRANCH"
AFTER="$(git rev-parse HEAD)"

if [ "$BEFORE" = "$AFTER" ]; then
  say "Already up to date ($AFTER). Rebuilding anyway."
else
  say "Updated: $BEFORE -> $AFTER"
fi

# 2) Did backend code change? (rebuild the container only if so)
BACKEND_CHANGED=1
if [ "$BEFORE" != "none" ] && git diff --quiet "$BEFORE" "$AFTER" -- backend; then
  BACKEND_CHANGED=0
fi

if [ "$BACKEND_CHANGED" -eq 1 ]; then
  say "Backend changed — rebuilding the auth-service container…"
  "${DC[@]}" -f "$COMPOSE_FILE" --env-file "$ENV_FILE" build auth-service
  "${DC[@]}" -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d
  # AWM-STAB-002: rollout success requires READINESS (process + PostgreSQL),
  # not just liveness. /readyz returns 200 only when the DB is reachable, so a
  # backend that is up but cannot serve does NOT count as a successful deploy.
  say "Waiting for backend readiness (/readyz)…"
  for i in $(seq 1 30); do
    if curl -fsS http://127.0.0.1:8081/readyz >/dev/null 2>&1; then say "Backend ready."; break; fi
    sleep 2
    [ "$i" -eq 30 ] && { echo "Backend did not become READY in time (/readyz not 200 — check DB connectivity)"; exit 1; }
  done
else
  say "No backend changes — skipping container rebuild."
fi

# 3) Always rebuild + publish the frontend.
say "Building frontend (VITE_API_BASE_URL=$API_BASE_URL)…"
pushd desktop >/dev/null
VITE_API_BASE_URL="$API_BASE_URL" npm ci
VITE_API_BASE_URL="$API_BASE_URL" npm run build
popd >/dev/null

say "Publishing to $WEB_ROOT…"
mkdir -p "$WEB_ROOT"
rm -rf "${WEB_ROOT:?}/"*
cp -r desktop/dist/* "$WEB_ROOT"/

# 4a) If the operator explicitly (and confirmedly) changed the HTTPS port,
#     re-render the nginx config from the template with the new port, validate,
#     and only activate after `nginx -t` PASS (§27/§51). Certificates are NOT
#     touched. The persisted deployment config is updated to the new port.
if [[ "$PORT_CHANGE_REQUESTED" -eq 1 ]]; then
  [[ -n "$DOMAIN" ]] || err "Port change requires a known domain (set AWAMER_DOMAIN or run install.sh)."
  say "Re-rendering nginx config for $DOMAIN on new HTTPS port $HTTPS_PORT…"
  NGINX_CONF=/etc/nginx/sites-available/netsphere
  render_nginx_config deploy/nginx/netsphere.conf "$DOMAIN" "$HTTPS_PORT" | sudo tee "${NGINX_CONF}.new" >/dev/null
  # Stage the new config in place, validate, and roll back on failure.
  sudo cp "$NGINX_CONF" "${NGINX_CONF}.bak" 2>/dev/null || true
  sudo mv "${NGINX_CONF}.new" "$NGINX_CONF"
  if sudo nginx -t; then
    sudo systemctl reload nginx
    printf 'AWAMER_DOMAIN=%s\nAWAMER_HTTPS_PORT=%s\n' "$DOMAIN" "$HTTPS_PORT" | sudo tee "$DEPLOYMENT_CONF" >/dev/null
    say "HTTPS port changed to $HTTPS_PORT and persisted."
  else
    [[ -f "${NGINX_CONF}.bak" ]] && sudo mv "${NGINX_CONF}.bak" "$NGINX_CONF"
    sudo nginx -t >/dev/null 2>&1 && sudo systemctl reload nginx || true
    err "New nginx config failed 'nginx -t' — port change reverted, running config unchanged."
  fi
  sudo rm -f "${NGINX_CONF}.bak" 2>/dev/null || true
fi

# 4) Reload nginx. An application update NEVER touches TLS certificates
#    (DEPLOY-002/§6): the existing certificate is preserved. We only validate
#    the current nginx config and reload; a failed `nginx -t` must NOT reload
#    (keeps the running config intact) and fails the update clearly.
if command -v nginx >/dev/null 2>&1; then
  say "Validating nginx config (certificates are preserved, not reissued)…"
  if nginx -t; then
    systemctl reload nginx
    say "nginx reloaded."
  else
    echo "nginx -t FAILED — not reloading. The previously running nginx config is unchanged." >&2
    echo "If a certificate is unexpectedly missing, (re)issue it with the bootstrap flow in deploy/scripts/install.sh, then re-run." >&2
    exit 1
  fi
fi

# 5) Open the VPN-server port(s) on the host firewall (best-effort). The compose
#    publishes the port from the container, but the host firewall must also allow
#    it inbound for external OpenVPN clients to connect. Cloud security groups
#    still need the same rule added in your provider console.
if [ -n "$VPN_PORTS" ] && command -v ufw >/dev/null 2>&1 && ufw status >/dev/null 2>&1; then
  for p in $VPN_PORTS; do
    say "Allowing $p through ufw…"
    ufw allow "$p" >/dev/null 2>&1 || true
  done
fi

say "Done. Hard-refresh the browser (Ctrl-Shift-R) to pick up the new frontend."
say "VPN Server: ensure your cloud security group also allows inbound $VPN_PORTS."
