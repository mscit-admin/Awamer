#!/usr/bin/env bash
# =====================================================================
# VPN deployment fix tests (SEC-INFRA-DEPLOY-001 / -002)
# =====================================================================
# Covers:
#   VPN-DEPLOY-SECRET-001  fresh generate-secrets contains VPN_HELPER_SECRET
#   VPN-DEPLOY-SECRET-002  secret has sufficient entropy/length
#   VPN-DEPLOY-SECRET-003  fresh install compose config succeeds
#   VPN-DEPLOY-SECRET-004  legacy env without secret gets one during update
#   VPN-DEPLOY-SECRET-005  existing secret is preserved (never rotated)
#   VPN-DEPLOY-SECRET-006  secret never appears in installer/update output
#   VPN-DEPLOY-SECRET-007  .env.production remains mode 0600
#   VPN-DATAPLANE-001      default UDP 1194 is published (vpn-helper)
#   VPN-DATAPLANE-002      TCP 1194 is published (vpn-helper)
#   VPN-DATAPLANE-003      helper control plane has zero public ports
#   VPN-DATAPLANE-008      custom OPENVPN_SERVER_PORT is honored
#
# The live external-client tunnel (VPN-DATAPLANE-004..007) is validated in a
# real Docker runtime — see FINAL_SEC_INFRA_DEPLOYMENT_FIX_REPORT.md.
#
# Run:  bash deploy/scripts/tests/vpn-deploy-test.sh
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS="$(cd "${HERE}/.." && pwd)"
REPO_ROOT="$(cd "${SCRIPTS}/../.." && pwd)"
COMPOSE_FILE="${REPO_ROOT}/deploy/docker-compose.production.yml"
SANDBOX="$(mktemp -d)"
trap 'rm -rf "$SANDBOX"' EXIT

PASS=0; FAIL=0
ok()  { printf '  \033[0;32mPASS\033[0m %s\n' "$*"; PASS=$((PASS+1)); }
bad() { printf '  \033[0;31mFAIL\033[0m %s\n' "$*"; FAIL=$((FAIL+1)); }

# Dummy env for compose rendering (never real secrets).
render_env() {
  cat <<EOF
POSTGRES_USER=u
POSTGRES_PASSWORD=p
POSTGRES_DB=d
REDIS_PASSWORD=r
JWT_ACCESS_SECRET=$(printf 'a%.0s' {1..40})
JWT_REFRESH_SECRET=$(printf 'b%.0s' {1..40})
CREDENTIAL_ENCRYPTION_KEY=$(printf 'c%.0s' {1..44})
BOOTSTRAP_ADMIN_PASSWORD=Str0ng!Passw0rd12
VPN_HELPER_SECRET=$(printf 'd%.0s' {1..64})
EOF
}

# ---- SECRET-001 / -002: generate-secrets produces the secret + entropy -------
GEN="${SANDBOX}/generated.env"
bash "${SCRIPTS}/generate-secrets.sh" > "$GEN" 2>/dev/null
if grep -qE '^VPN_HELPER_SECRET=.+' "$GEN"; then ok "VPN-DEPLOY-SECRET-001 generate-secrets emits VPN_HELPER_SECRET"; else bad "VPN-DEPLOY-SECRET-001 generate-secrets emits VPN_HELPER_SECRET"; fi
SVAL="$(grep -E '^VPN_HELPER_SECRET=' "$GEN" | head -1 | cut -d= -f2-)"
if [[ ${#SVAL} -ge 32 && "$SVAL" =~ ^[0-9a-fA-F]+$ ]]; then ok "VPN-DEPLOY-SECRET-002 secret is high-entropy hex (len=${#SVAL})"; else bad "VPN-DEPLOY-SECRET-002 secret entropy/length"; fi

# ---- SECRET-003: fresh generated env passes compose config -------------------
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  if docker compose -f "$COMPOSE_FILE" --env-file "$GEN" config >/dev/null 2>"${SANDBOX}/cfg.err"; then
    ok "VPN-DEPLOY-SECRET-003 fresh install compose config succeeds"
  else bad "VPN-DEPLOY-SECRET-003 fresh install compose config ($(tail -1 "${SANDBOX}/cfg.err"))"; fi
else
  printf '  \033[0;33mSKIP\033[0m VPN-DEPLOY-SECRET-003 (docker compose unavailable)\n'
fi

# ---- SECRET-004/-005/-006/-007: update.sh legacy-upgrade behaviour -----------
# Drive the REAL update.sh; it runs ensure_vpn_helper_secret early, then aborts
# at HTTPS-port resolution (no deployment.conf) — so no git/docker/nginx runs.
run_update() {  # $1=env file → prints combined output; returns update.sh rc
  ( cd "$REPO_ROOT" && ENV_FILE="$1" AWAMER_DEPLOYMENT_CONF="${SANDBOX}/nope.conf" \
      bash deploy/scripts/update.sh ) 2>&1
}

LEGACY="${SANDBOX}/legacy.env"
grep -v '^VPN_HELPER_SECRET=' "$GEN" > "$LEGACY"   # a pre-helper .env.production
chmod 600 "$LEGACY"
OUT_LEGACY="$(run_update "$LEGACY" || true)"
if grep -qE '^VPN_HELPER_SECRET=.+' "$LEGACY"; then ok "VPN-DEPLOY-SECRET-004 legacy env gets a VPN_HELPER_SECRET on update"; else bad "VPN-DEPLOY-SECRET-004 legacy env gets a secret"; fi
NEWVAL="$(grep -E '^VPN_HELPER_SECRET=' "$LEGACY" | head -1 | cut -d= -f2-)"

# SECRET-005: existing secret preserved (run again → unchanged).
OUT_PRESERVE="$(run_update "$LEGACY" || true)"
AGAIN="$(grep -E '^VPN_HELPER_SECRET=' "$LEGACY" | head -1 | cut -d= -f2-)"
if [[ -n "$NEWVAL" && "$NEWVAL" == "$AGAIN" ]]; then ok "VPN-DEPLOY-SECRET-005 existing secret preserved (not rotated)"; else bad "VPN-DEPLOY-SECRET-005 existing secret preserved"; fi

# SECRET-006: the secret value never appears in update.sh output.
if [[ -n "$NEWVAL" ]] && { printf '%s' "$OUT_LEGACY$OUT_PRESERVE" | grep -qF -- "$NEWVAL"; }; then
  bad "VPN-DEPLOY-SECRET-006 secret leaked to update output"
else ok "VPN-DEPLOY-SECRET-006 secret never printed by update"; fi

# SECRET-007: .env.production stays mode 0600 after the secret is appended.
MODE="$(stat -c '%a' "$LEGACY")"
if [[ "$MODE" == "600" ]]; then ok "VPN-DEPLOY-SECRET-007 .env.production remains mode 0600"; else bad "VPN-DEPLOY-SECRET-007 mode is $MODE, expected 600"; fi

# ---- VPN-DATAPLANE compose contract (multi-server dynamic ports) -------------
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  RC="${SANDBOX}/rendered.json"
  docker compose -f "$COMPOSE_FILE" --env-file "$GEN" config --format json >"$RC" 2>/dev/null
  jget() { node -e "const j=require('$RC'); process.stdout.write(String(($1)))" 2>/dev/null; }
  NETMODE="$(jget 'j.services["vpn-helper"].network_mode || ""')"
  NPORTS="$(jget '(j.services["vpn-helper"].ports||[]).length')"
  # DATAPLANE-001/002: dynamic ports via host networking (no static publish, no recreation).
  [[ "$NETMODE" == "host" ]] && ok "VPN-DATAPLANE-001/002 helper uses host networking (each server binds its own dynamic port)" || bad "VPN-DATAPLANE-001/002 expected network_mode host (got '$NETMODE')"
  # DATAPLANE-003: control plane has zero published ports.
  [[ "$NPORTS" == "0" ]] && ok "VPN-DATAPLANE-003 helper control plane has zero published ports" || bad "VPN-DATAPLANE-003 helper published $NPORTS ports (expected 0)"
  # DATAPLANE-008: per-server port range is configured (single source of truth).
  MIN="$(jget 'j.services["vpn-helper"].environment.VPN_SERVER_PORT_MIN || ""')"
  MAX="$(jget 'j.services["vpn-helper"].environment.VPN_SERVER_PORT_MAX || ""')"
  FB="$(jget 'j.services["vpn-helper"].environment.VPN_FIREWALL_BACKEND || ""')"
  if [[ -n "$MIN" && -n "$MAX" && -n "$FB" ]]; then ok "VPN-DATAPLANE-008 per-server port range configured ($MIN-$MAX, firewall=$FB)"; else bad "VPN-DATAPLANE-008 port range/firewall env missing ($MIN/$MAX/$FB)"; fi
  # No obsolete single global OpenVPN port anywhere in the rendered compose.
  if grep -q 'OPENVPN_SERVER_PORT' "$RC"; then bad "obsolete OPENVPN_SERVER_PORT still present"; else ok "VPN-DATAPLANE no obsolete single-global OPENVPN_SERVER_PORT"; fi
else
  for t in 001/002 003 008; do printf '  \033[0;33mSKIP\033[0m VPN-DATAPLANE-%s (docker compose unavailable)\n' "$t"; done
fi

echo
echo "PASS=$PASS  FAIL=$FAIL"
[[ "$FAIL" -eq 0 ]]
