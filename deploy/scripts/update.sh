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
BRANCH="${BRANCH:-claude/feature-addition-ygosfh}"
API_BASE_URL="${API_BASE_URL:-https://161.97.78.116.nip.io:6655}"
WEB_ROOT="${WEB_ROOT:-/var/www/awamer}"
COMPOSE_FILE="${COMPOSE_FILE:-deploy/docker-compose.production.yml}"
ENV_FILE="${ENV_FILE:-.env.production}"
# VPN-server listener port(s) to open on the host firewall (VPN Server feature).
# Set VPN_PORTS="" to skip, or e.g. "1194/udp 1195/udp" for extra servers.
VPN_PORTS="${VPN_PORTS:-1194/udp 1194/tcp}"
# ---------------------------------------------------------------------

# Resolve project root (this script lives in deploy/scripts/).
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }

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
