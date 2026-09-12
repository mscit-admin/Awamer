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

# ---- DATAPLANE-001/-002/-003/-008: compose port contract ---------------------
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  RC="${SANDBOX}/rendered.json"
  docker compose -f "$COMPOSE_FILE" --env-file "$GEN" config --format json >"$RC" 2>/dev/null
  helper_ports() { node -e '
    const fs=require("fs"); const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    const p=(j.services["vpn-helper"].ports||[]).map(x=>`${x.published}/${x.protocol}`);
    process.stdout.write(p.sort().join(","));
  ' "$RC" 2>/dev/null; }
  PORTS="$(helper_ports)"
  echo "$PORTS" | grep -q '1194/udp' && ok "VPN-DATAPLANE-001 default UDP 1194 published" || bad "VPN-DATAPLANE-001 UDP 1194 ($PORTS)"
  echo "$PORTS" | grep -q '1194/tcp' && ok "VPN-DATAPLANE-002 default TCP 1194 published" || bad "VPN-DATAPLANE-002 TCP 1194 ($PORTS)"
  # Control plane: the only published ports are the OpenVPN data ports (1194);
  # the IPC socket is a volume, never a port. So exactly two entries, both 1194.
  N="$(echo "$PORTS" | tr ',' '\n' | grep -c '/')"
  ONLY1194="$(echo "$PORTS" | tr ',' '\n' | grep -vc '^1194/')"
  if [[ "$ONLY1194" -eq 0 && "$N" -ge 1 ]]; then ok "VPN-DATAPLANE-003 helper control plane has zero public ports (only 1194 data)"; else bad "VPN-DATAPLANE-003 unexpected helper ports ($PORTS)"; fi
  # DATAPLANE-008: custom port honored.
  CUSTOM="${SANDBOX}/rendered5.json"
  ( cat "$GEN"; echo "OPENVPN_SERVER_PORT=1195" ) > "${SANDBOX}/gen5.env"
  docker compose -f "$COMPOSE_FILE" --env-file "${SANDBOX}/gen5.env" config --format json >"$CUSTOM" 2>/dev/null
  P5="$(node -e 'const j=require(process.argv[1]);process.stdout.write((j.services["vpn-helper"].ports||[]).map(x=>`${x.published}/${x.protocol}`).sort().join(","))' "$CUSTOM" 2>/dev/null)"
  if echo "$P5" | grep -q '1195/udp' && echo "$P5" | grep -q '1195/tcp'; then ok "VPN-DATAPLANE-008 custom OPENVPN_SERVER_PORT honored ($P5)"; else bad "VPN-DATAPLANE-008 custom port ($P5)"; fi
else
  for t in 001 002 003 008; do printf '  \033[0;33mSKIP\033[0m VPN-DATAPLANE-%s (docker compose unavailable)\n' "$t"; done
fi

echo
echo "PASS=$PASS  FAIL=$FAIL"
[[ "$FAIL" -eq 0 ]]
